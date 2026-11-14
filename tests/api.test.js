import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registerApi } from '../lib/api.js';
import { SyncController } from '../lib/sync.js';
import { SyncState } from '../lib/state.js';
import { catalogSummary } from '../lib/catalog.js';

const LIMIT = 64 * 1024;
const PROVIDER = 'opaque:official/work';
const SECRET = 'TEST_ONLY_DO_NOT_EXPOSE_secret_93ca';

// No HTTP listener, fetch, settings service, filesystem-backed state, or credentials.
function apiHarness(controller) {
  let route;
  const dispose = () => {};
  assert.equal(registerApi({ register(value) { route = value; return dispose; } }, controller), dispose);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/model-sync');
  return async function request(path, { method = 'POST', body, raw, chunks, headers } = {}) {
    const bytes = raw === undefined ? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))) : Buffer.from(raw);
    const pieces = chunks ?? (bytes.length ? [bytes] : []);
    const req = {
      method,
      url: `/model-sync/api${path}`,
      headers: headers ?? { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield* pieces; },
    };
    let status;
    let responseHeaders;
    let text;
    const res = {
      writeHead(code, values) { status = code; responseHeaders = values; },
      end(value) { assert.equal(text, undefined, 'response ends once'); text = String(value); },
    };
    await route.handler(req, res);
    assert.equal(typeof text, 'string', 'handler must produce a response');
    return { status, headers: responseHeaders, text, body: JSON.parse(text) };
  };
}

function fakeController(overrides = {}) {
  const calls = [];
  const controller = {};
  const values = {
    status: { lastCheck: { results: [] }, managed: [] },
    check: { at: 1, results: [] },
    applySelection: { at: 2, applied: [], errors: [] },
    markViewed: { acknowledged: false, reason: 'test-only' },
    markOpened: { acknowledged: false },
    setManaged: undefined,
    setSelectionHabit: undefined,
    managedSiblings: [],
    removeManagedModels: { at: 3, applied: [], errors: [] },
    removeSiblingModels: { at: 4, applied: [], errors: [] },
    proxyStatus: { enabled: true, installed: true, url: 'http://127.0.0.1:7897', source: 'system' },
    setProxyEnabled: { enabled: false, proxy: { enabled: false, installed: true } },
  };
  for (const [name, value] of Object.entries(values)) {
    controller[name] = (...args) => {
      calls.push({ name, args });
      return Object.hasOwn(overrides, name) ? overrides[name](...args) : value;
    };
  }
  // Ownership resolution is a read-only validation step, not a mutation call.
  controller.resolveRemovals = overrides.resolveRemovals ?? ((items) => items.map((item) => ({ provider: item.owner ?? item.provider, id: item.id })));
  return { controller, calls, request: apiHarness(controller) };
}

// Exercise actual controller/state/catalog methods without invoking either real
// constructor's disk/service discovery. Only a synthetic credential is returned.
function memoryController() {
  const state = Object.create(SyncState.prototype);
  state.data = {
    scopeSalt: 'api-tests-in-memory-salt', catalogs: {}, managed: {}, selectionHabits: {},
    ownedModels: {}, siblings: {}, lastOpenedAt: 41, lastCheck: { at: 0, results: [] },
  };
  let saves = 0;
  state.save = () => { saves++; };
  state.markOpened = () => { throw new Error('Legacy panel opening must not consume catalog state'); };
  const controller = new SyncController({
    ctx: { get(name) { throw new Error(`Unexpected real service access: ${name}`); } },
    state, logger: { info() {}, warn() {}, error() {} },
  });
  const targets = [];
  const mutations = [];
  const plans = [];
  let checks = 0;
  let backups = 0;
  let credential = { ref: 'synthetic-reference', value: 'synthetic-not-a-real-credential' };
  controller.routeTargets = () => targets;
  controller.credentialFor = async () => credential;
  controller.managedSiblings = () => [];
  controller.backupSettings = async () => { backups++; };
  controller.settings = () => ({ async mutate(...args) { mutations.push(args); } });
  controller.check = async () => { checks++; return state.data.lastCheck; };
  controller.refreshAfterMutation = () => { throw new Error('Unexpected refresh outside the fake check'); };
  controller.planOfficial = async (target, selected, removed) => {
    plans.push({ provider: target.id, selected, removed: [...removed] });
    return {
      target, ops: [{ op: 'set', path: ['models', target.id], value: selected }],
      createdSiblings: [], addedIds: selected, removedIds: [...removed], added: selected.length, removed: removed.size,
    };
  };
  function publish(target, ids) {
    const models = ids.map((id) => ({ id, name: id }));
    const summary = state.commitCatalog(target.id, controller.scopeFor(target, credential), target.configScope, models);
    const record = state.catalog(target.id, target.configScope);
    const result = {
      provider: target.id, displayName: target.route.displayName, adapter: 'pi-ai', status: 'ok',
      settingsRevision: target.settingsRevision, configScope: target.configScope, catalog: summary,
      allItems: models.map((model) => ({ ...model, target: target.id, status: 'available', added: false, removable: false })),
      newItems: models.map((model) => ({ ...model, target: target.id, status: 'available', entry: { internal: SECRET } })),
      removed: [], repairs: [], defaultSelected: [],
    };
    state.data.lastCheck = {
      at: Date.now(), results: [...state.data.lastCheck.results.filter((item) => item.provider !== target.id), result],
    };
    return record;
  }
  function addTarget(id = PROVIDER, settingsNs = 'synthetic-settings', settingsRevision = 7) {
    const target = {
      id, managed: true, legacy: false, settingsRevision, configScope: `scope:${id}`,
      route: { provider: 'not-the-instance-id', displayName: `Official ${id}`, adapter: 'pi-ai', settingsNs },
    };
    targets.push(target);
    publish(target, ['kept', 'removed']);
    return target;
  }
  const target = addTarget();
  return {
    state, controller, target, targets, mutations, plans, publish, addTarget, request: apiHarness(controller),
    setCredential(value) { credential = value; },
    get saves() { return saves; }, get checks() { return checks; }, get backups() { return backups; },
  };
}

function clientHelpers() {
  let exported;
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) {
      exported = factory((name) => {
        if (name === 'react') return {};
        throw new Error(`Optional module unavailable in isolated API test: ${name}`);
      });
    } } },
    fetch() { throw new Error('API contract tests must not perform network requests'); },
  });
  return exported.__test;
}

function clientResult(provider, settingsRevision = 7) {
  const available = { id: 'new', name: 'New', target: provider, status: 'available', added: false, removable: false };
  return {
    provider, displayName: `Official ${provider}`, adapter: 'pi-ai', status: 'ok', settingsRevision,
    allItems: [available, { id: 'enabled', name: 'Enabled', target: provider, status: 'added', added: true, removable: true }],
    newItems: [available],
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('API registers its prefix, returns JSON without caching, and rejects unknown route/method combinations', async () => {
  const { request, calls } = fakeController();
  const response = await request('/state', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.body, { lastCheck: { results: [] }, managed: [] });
  assert.equal((await request('/not-a-route')).status, 404);
  assert.equal((await request('/state', { method: 'POST' })).status, 404);
  assert.equal((await request('/apply', { method: 'GET' })).status, 404);
  assert.deepEqual(calls.map((item) => item.name), ['status']);
});

test('the system-proxy switch is readable and requires an explicit boolean on write', async () => {
  const { request, calls } = fakeController();
  const read = await request('/proxy', { method: 'GET' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { enabled: true, installed: true, url: 'http://127.0.0.1:7897', source: 'system' });

  // Absent or non-boolean values must not silently mean "off": the switch
  // rewrites every request's transport, so only an explicit boolean applies.
  for (const body of [{}, { enabled: 'false' }, { enabled: 1 }, { enabled: null }]) {
    const rejected = await request('/proxy', { body });
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.match(rejected.body.error, /布尔值/);
  }
  // A cross-site page can send text/plain without a preflight, so this route
  // only accepts the JSON type the panel actually sends.
  const before = calls.length;
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    const wrongType = await request('/proxy', { body: { enabled: true }, headers: { 'content-type': type } });
    assert.equal(wrongType.status, 415, type);
    assert.equal(calls.length, before, 'a rejected media type never reaches the controller');
  }
  assert.equal((await request('/proxy', { body: { enabled: false }, headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
  assert.deepEqual(calls.map((item) => item.name), ['proxyStatus', 'setProxyEnabled']);
  assert.deepEqual(calls[1].args, [false]);
});

test('JSON input must be an object and malformed JSON never reaches a mutation', async () => {
  for (const raw of ['{', '{"unterminated":', 'null', '[]', '42', 'true', '"string"']) {
    const { request, calls } = fakeController();
    const response = await request('/apply', { raw });
    assert.equal(response.status, 400, raw);
    assert.match(response.body.error, /JSON/);
    assert.equal(calls.length, 0);
  }
  const { request, calls } = fakeController();
  const response = await request('/apply');
  assert.equal(response.status, 200, 'an absent optional body uses defaults');
  assert.deepEqual(calls[0].args, [{}, { removals: [], expectedRevisions: {}, repairs: false, recheck: true, rememberHabit: true }]);
});

test('JSON budget is inclusive at 64 KiB and counts streamed bytes, not characters', async () => {
  const { request, calls } = fakeController();
  const exact = Buffer.from(`${' '.repeat(LIMIT - 2)}{}`);
  assert.equal((await request('/apply', { chunks: [exact.subarray(0, 123), exact.subarray(123)] })).status, 200);
  assert.equal(calls.length, 1);
  assert.equal((await request('/apply', { chunks: [exact, Buffer.from(' ')] })).status, 413);
  assert.equal(calls.length, 1, 'oversized streamed body must not apply');
  const unicode = JSON.stringify({ note: '模'.repeat(Math.ceil(LIMIT / 3)) });
  assert.ok(unicode.length < LIMIT && Buffer.byteLength(unicode) > LIMIT);
  const tooLarge = await request('/apply', { raw: unicode });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.body, { error: '请求体过大' });
  assert.equal(calls.length, 1);
  const small = Buffer.from(JSON.stringify({ note: '模型🍵' }));
  assert.equal((await request('/apply', { chunks: [...small].map((byte) => Buffer.from([byte])) })).status, 200,
    'UTF-8 split across arbitrary stream chunks is reconstructed before JSON parsing');
});

test('settings and habit toggles require actual booleans and preserve opaque instance IDs', async () => {
  for (const [path, flag, method] of [['/settings', 'managed', 'setManaged'], ['/habits', 'enabled', 'setSelectionHabit']]) {
    for (const value of [true, false]) {
      const { request, calls } = fakeController();
      assert.equal((await request(path, { body: { provider: PROVIDER, [flag]: value } })).status, 200);
      assert.deepEqual(calls, [{ name: method, args: [PROVIDER, value] }, { name: 'status', args: [] }]);
    }
    for (const value of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
      const { request, calls } = fakeController();
      assert.equal((await request(path, { body: { provider: PROVIDER, [flag]: value } })).status, 400, `${path}: ${JSON.stringify(value)}`);
      assert.equal(calls.length, 0);
    }
    for (const provider of [undefined, null, 4, {}, []]) {
      const { request, calls } = fakeController();
      assert.equal((await request(path, { body: { provider, [flag]: true } })).status, 400);
      assert.equal(calls.length, 0);
    }
  }
});

test('apply forwards explicit booleans and defaults once without splitting removals or rechecking in the API', async () => {
  const { request, calls } = fakeController();
  const selections = { [PROVIDER]: ['selected'] };
  const removals = [{ provider: PROVIDER, id: 'removed' }];
  const expectedRevisions = { [PROVIDER]: 7 };
  const response = await request('/apply', { body: { selections, removals, expectedRevisions, repairs: true, recheck: false, rememberHabit: false } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ name: 'applySelection', args: [selections, { removals, expectedRevisions, repairs: true, recheck: false, rememberHabit: false }] }]);
});

for (const flag of ['repairs', 'recheck', 'rememberHabit']) {
  test(`apply rejects non-boolean ${flag} instead of silently changing user intent`, async () => {
    for (const value of ['false', 'true', 0, 1, null, {}, []]) {
      const { request, calls } = fakeController();
      const response = await request('/apply', { body: { selections: {}, [flag]: value } });
      assert.equal(response.status, 400, `${flag}=${JSON.stringify(value)}`);
      assert.equal(calls.length, 0, 'invalid flags must not reach the controller');
    }
  });
}

test('viewed requires string provider and revision, then forwards the exact opaque receipt', async () => {
  const receipt = { acknowledged: true, catalog: { revision: 'generation:9', total: 4, changedCount: 0 } };
  const { request, calls } = fakeController({ markViewed: () => receipt });
  for (const body of [{}, { provider: PROVIDER }, { revision: 'generation:9' }, { provider: 7, revision: 'generation:9' },
    { provider: PROVIDER, revision: 9 }, { provider: PROVIDER, revision: null }]) {
    assert.equal((await request('/viewed', { body })).status, 400);
  }
  assert.equal(calls.length, 0);
  const response = await request('/viewed', { body: { provider: PROVIDER, revision: 'generation:9' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, receipt);
  assert.deepEqual(calls, [{ name: 'markViewed', args: [PROVIDER, 'generation:9'] }]);
});

test('real viewed receipts consume only the rendered revision; late R never clears R+1', async () => {
  const f = memoryController();
  const first = catalogSummary(f.state.catalog(PROVIDER));
  assert.equal(first.firstDiscovery, true);
  assert.equal(first.changedCount, 0);
  assert.equal((await f.request('/viewed', { body: { provider: PROVIDER, revision: first.revision } })).body.acknowledged, true);
  const rendered = catalogSummary(f.publish(f.target, ['kept', 'incoming']));
  assert.equal(rendered.changedCount, 2);
  const newer = catalogSummary(f.publish(f.target, ['kept', 'incoming', 'later']));
  const late = await f.request('/viewed', { body: { provider: PROVIDER, revision: rendered.revision } });
  assert.equal(late.status, 200);
  assert.equal(late.body.acknowledged, true);
  assert.equal(late.body.catalog.revision, newer.revision);
  assert.deepEqual(late.body.catalog.addedIds, ['later']);
  assert.equal(late.body.catalog.removedCount, 0);
  assert.equal(late.body.catalog.changedCount, 1);
  const before = plain(f.state.catalog(PROVIDER));
  for (const revision of ['not-this-generation:1', `${before.generation}:${before.serial + 1}`, first.revision]) {
    assert.equal((await f.request('/viewed', { body: { provider: PROVIDER, revision } })).body.acknowledged, false);
    assert.deepEqual(plain(f.state.catalog(PROVIDER)), before);
  }
  const current = await f.request('/viewed', { body: { provider: PROVIDER, revision: newer.revision } });
  assert.equal(current.body.acknowledged, true);
  assert.equal(current.body.catalog.changedCount, 0);
  assert.equal(current.body.catalog.firstDiscovery, false);
});

test('failed, stale-config, unmanaged, unsupported, unknown and credential-changed directories cannot be acknowledged', async () => {
  const cases = [
    (f) => { f.state.data.lastCheck.results[0].status = 'discovery-failed'; },
    (f) => { f.target.settingsRevision++; },
    (f) => { f.target.configScope = 'different-configuration'; },
    (f) => { f.target.managed = false; },
    (f) => { f.target.reason = 'Unsupported synthetic adapter'; },
    (f) => { f.targets.length = 0; },
    (f) => { f.setCredential({ ref: 'changed-reference', value: 'another-synthetic-value' }); },
  ];
  for (const change of cases) {
    const f = memoryController();
    const revision = catalogSummary(f.publish(f.target, ['kept', 'new'])).revision;
    const before = plain(f.state.data.catalogs);
    const saves = f.saves;
    change(f);
    const response = await f.request('/viewed', { body: { provider: PROVIDER, revision } });
    assert.equal(response.status, 200);
    assert.equal(response.body.acknowledged, false);
    assert.equal(typeof response.body.reason, 'string');
    assert.deepEqual(plain(f.state.data.catalogs), before);
    assert.equal(f.saves, saves);
  }
});

test('GET state and legacy opened leave unread catalogs intact; public state omits private entries and scope', async () => {
  const f = memoryController();
  f.publish(f.target, ['kept', 'new']);
  const before = plain(f.state.data.catalogs);
  const saves = f.saves;
  const response = await f.request('/state', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.body.lastCheck.results[0].catalog.changedCount, 2);
  assert.equal(Object.hasOwn(response.body.lastCheck.results[0], 'configScope'), false);
  assert.ok(response.body.lastCheck.results[0].newItems.every((item) => !Object.hasOwn(item, 'entry')));
  assert.equal(response.text.includes(SECRET), false);
  const opened = await f.request('/opened');
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body, { acknowledged: false });
  assert.deepEqual(plain(f.state.data.catalogs), before);
  assert.equal(f.state.data.lastOpenedAt, 41);
  assert.equal(f.saves, saves);
});

test('client-generated atomic payload keeps captured CAS revisions and only clears explicitly applied drafts', async () => {
  const helpers = clientHelpers();
  const first = clientResult(PROVIDER);
  const second = clientResult('opaque:second/work', 11);
  let drafts = helpers.updateDraft({}, first, ['new'], true);
  drafts = helpers.updateDraft(drafts, first, ['enabled'], true, 'removals');
  drafts = helpers.updateDraft(drafts, second, ['new'], true);
  const { body, submitted, blocked } = helpers.buildApplyRequest(drafts, [{ ...first, settingsRevision: 8 }, second]);
  assert.equal(blocked.length, 0);
  assert.deepEqual(plain(body), {
    selections: { [PROVIDER]: ['new'], [second.provider]: ['new'] }, removals: [{ provider: PROVIDER, id: 'enabled' }],
    expectedRevisions: { [PROVIDER]: 7, [second.provider]: 11 }, repairs: false, recheck: true, rememberHabit: true,
  });
  const outcome = {
    at: 99, applied: [{ provider: PROVIDER, added: 1, removed: 1 }],
    errors: [{ provider: second.provider, reason: '配置版本冲突' }],
  };
  const { request, calls } = fakeController({ applySelection: () => outcome });
  const response = await request('/apply', { body });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, outcome);
  assert.notEqual(response.body.ok, true, 'mixed outcomes must not claim global success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'applySelection');
  const { selections, ...options } = plain(body);
  assert.deepEqual(calls[0].args, [selections, options]);
  const remaining = helpers.clearAppliedDrafts(drafts, submitted, response.body);
  assert.deepEqual(Object.keys(remaining), [second.provider]);
  assert.deepEqual([...remaining[second.provider].checked], ['new']);
});

test('HTTP apply requires explicit safe revisions for every selected or removed provider', async () => {
  const removedProvider = 'opaque:removal-only';
  const operation = { selections: { [PROVIDER]: ['new'] }, removals: [{ provider: removedProvider, id: 'enabled' }] };
  const invalid = [
    undefined, {}, { [PROVIDER]: 7 }, { [removedProvider]: 9 },
    { 'not-the-instance-id': 7, [removedProvider]: 9 },
    ...[null, '7', -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ [PROVIDER]: value, [removedProvider]: 9 })),
  ];
  for (const expectedRevisions of invalid) {
    const { request, calls } = fakeController();
    const response = await request('/apply', { body: { ...operation, expectedRevisions } });
    assert.equal(response.status, 400, String(JSON.stringify(expectedRevisions)));
    assert.equal(calls.length, 0, 'missing/invalid CAS intent must not reach applySelection');
  }
  const { request, calls } = fakeController();
  const expectedRevisions = { [PROVIDER]: 0, [removedProvider]: 9 };
  const response = await request('/apply', { body: { ...operation, expectedRevisions } });
  assert.equal(response.status, 200, 'zero is a valid captured settings revision');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args[1].expectedRevisions, expectedRevisions);
});

test('HTTP removal routes reject missing or invalid CAS versions before deleting models', async () => {
  for (const path of ['/remove-managed', '/remove']) {
    for (const expectedRevisions of [undefined, {}, { [PROVIDER]: '7' }, { [PROVIDER]: -1 }, { [PROVIDER]: null }]) {
      const { request, calls } = fakeController();
      const response = await request(path, { body: { provider: PROVIDER, modelId: 'enabled', expectedRevisions } });
      assert.equal(response.status, 400, `${path}: ${JSON.stringify(expectedRevisions)}`);
      assert.equal(calls.length, 0);
    }
  }
});

test('HTTP removal validates the resolved stable owner revision rather than the protocol alias', async () => {
  for (const path of ['/remove-managed', '/remove']) {
    const item = { provider: 'opencode-protocol-alias', owner: PROVIDER, id: 'enabled' };
    const { request, calls } = fakeController();
    const missingOwner = await request(path, { body: { removals: [item], expectedRevisions: { [item.provider]: 7 } } });
    assert.equal(missingOwner.status, 400);
    assert.equal(calls.length, 0);
    const valid = await request(path, { body: { removals: [item], expectedRevisions: { [PROVIDER]: 7 } } });
    assert.equal(valid.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args[0], [item], 'exact explicit owner survives the HTTP boundary');
    assert.deepEqual(calls[0].args[1].expectedRevisions, { [PROVIDER]: 7 });
  }
});

test('real apply rejects malformed selection, removal and revision-container shapes before service access', async () => {
  for (const body of [
    { selections: null }, { selections: [] }, { selections: 'models' }, { selections: { [PROVIDER]: 'model' } },
    { selections: { [PROVIDER]: [''] } }, { selections: { [PROVIDER]: [7] } },
    { removals: null }, { removals: {} }, { removals: [null] }, { removals: [{ provider: PROVIDER }] },
    { removals: [{ provider: 3, id: 'model' }] }, { expectedRevisions: null }, { expectedRevisions: [] }, { expectedRevisions: '7' },
  ]) {
    const f = memoryController();
    const response = await f.request('/apply', { body: { ...body, recheck: false } });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(f.mutations.length, 0);
    assert.equal(f.plans.length, 0);
    assert.equal(f.checks, 0);
  }
});

test('real apply merges additions and removals once under CAS and returns accurate per-provider outcomes', async () => {
  const f = memoryController();
  const other = f.addTarget('opaque:other', 'another-synthetic-namespace', 9);
  const response = await f.request('/apply', { body: {
    selections: { [PROVIDER]: ['incoming'], [other.id]: ['other-model'] },
    removals: [{ provider: PROVIDER, id: 'removed' }], expectedRevisions: { [PROVIDER]: 7, [other.id]: 8 },
    repairs: false, recheck: true, rememberHabit: true,
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.applied.map(({ provider, added, removed }) => ({ provider, added, removed })), [{ provider: PROVIDER, added: 1, removed: 1 }]);
  assert.deepEqual(response.body.errors.map(({ provider }) => provider), [other.id]);
  assert.match(response.body.errors[0].reason, /配置.*修改/);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0][0], 'synthetic-settings');
  assert.equal(f.mutations[0][2], 7, 'displayed CAS revision reaches settings.mutate');
  assert.deepEqual(f.plans, [{ provider: PROVIDER, selected: ['incoming'], removed: ['removed'] }]);
  assert.equal(f.backups, 1);
  assert.equal(f.checks, 1);
  assert.equal(f.state.data.selectionHabits[PROVIDER], true);
  assert.equal(Object.hasOwn(f.state.data.selectionHabits, other.id), false);
  assert.notEqual(response.body.ok, true);
});

test('same-namespace conflicts abort the entire group without writes or falsely successful providers', async () => {
  const f = memoryController();
  const other = f.addTarget('opaque:namespace-sibling', 'synthetic-settings', 7);
  const response = await f.request('/apply', { body: {
    selections: { [PROVIDER]: ['incoming'], [other.id]: ['other-model'] },
    expectedRevisions: { [PROVIDER]: 7, [other.id]: 6 }, recheck: false,
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.applied, []);
  assert.deepEqual(response.body.errors.map((item) => item.provider).sort(), [PROVIDER, other.id].sort());
  assert.equal(f.mutations.length, 0);
  assert.equal(f.backups, 0);
  assert.equal(f.checks, 0);
});

test('save aborts if the catalog revision changes while the settings backup awaits', async () => {
  const f = memoryController();
  const original = catalogSummary(f.state.catalog(PROVIDER)).revision;
  f.controller.backupSettings = async () => { f.publish(f.target, ['kept', 'replacement']); };
  const response = await f.request('/apply', { body: {
    selections: { [PROVIDER]: ['removed'] }, expectedRevisions: { [PROVIDER]: 7 }, recheck: false,
  } });
  assert.notEqual(catalogSummary(f.state.catalog(PROVIDER)).revision, original);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.applied, [], 'a plan based on the previous catalog must not be applied');
  assert.equal(response.body.errors.length, 1);
  assert.equal(response.body.errors[0].provider, PROVIDER);
  assert.equal(f.mutations.length, 0);
});

test('check responses remove internal material without mutating the controller result', async () => {
  const checked = { at: 1, results: [{ provider: PROVIDER, configScope: SECRET, newItems: [{ id: 'new', entry: { apiKey: SECRET } }], allItems: [{ id: 'new' }] }] };
  const { request } = fakeController({ check: () => checked });
  const response = await request('/check');
  assert.equal(response.status, 200);
  assert.equal(response.text.includes(SECRET), false);
  assert.deepEqual(response.body, { at: 1, results: [{ provider: PROVIDER, newItems: [{ id: 'new' }], allItems: [{ id: 'new' }] }] });
  assert.equal(checked.results[0].newItems[0].entry.apiKey, SECRET);
});

test('API exceptions never expose raw messages, stacks or credentials across supported routes', async () => {
  const routes = [
    ['/state', 'GET', 'status'], ['/check', 'POST', 'check'], ['/apply', 'POST', 'applySelection'],
    ['/viewed', 'POST', 'markViewed', { provider: PROVIDER, revision: 'generation:1' }],
    ['/settings', 'POST', 'setManaged', { provider: PROVIDER, managed: true }],
    ['/habits', 'POST', 'setSelectionHabit', { provider: PROVIDER, enabled: true }],
    ['/managed', 'GET', 'managedSiblings'],
    ['/remove-managed', 'POST', 'removeManagedModels', { removals: [{ provider: PROVIDER, id: 'model' }], expectedRevisions: { [PROVIDER]: 7 } }],
    ['/remove', 'POST', 'removeSiblingModels', { provider: PROVIDER, modelId: 'model', expectedRevisions: { [PROVIDER]: 7 } }],
  ];
  for (const [path, method, name, body] of routes) {
    const { request } = fakeController({ [name]() { throw Object.assign(new Error(`Authorization: Bearer ${SECRET}`), { details: { token: SECRET } }); } });
    const response = await request(path, { method, body });
    assert.equal(response.status, 500, path);
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.equal(response.text.includes(SECRET), false, path);
    assert.equal(response.text.includes('Authorization'), false, path);
    assert.match(response.body.error, /未显示.*凭证/);
  }
  const unsafe = fakeController({ applySelection() { throw Object.assign(new Error(SECRET), { status: 409, publicMessage: SECRET }); } });
  const hidden = await unsafe.request('/apply');
  assert.equal(hidden.status, 409);
  assert.equal(hidden.text.includes(SECRET), false, 'untrusted publicMessage fields are not safe to expose');
  const { request } = fakeController({ applySelection() { throw Object.assign(new Error(SECRET), { status: 409, safe: true, publicMessage: '请重新检查配置版本' }); } });
  assert.deepEqual(await request('/apply').then(({ status, body }) => ({ status, body })), { status: 409, body: { error: '请重新检查配置版本' } });
});

test('per-provider controller exceptions are sanitized and never appear as applied successes', async () => {
  const f = memoryController();
  f.controller.planOfficial = async () => { throw Object.assign(new Error(`credential ${SECRET}`), { publicMessage: SECRET }); };
  const response = await f.request('/apply', { body: { selections: { [PROVIDER]: ['incoming'] }, expectedRevisions: { [PROVIDER]: 7 }, recheck: false } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.applied, []);
  assert.equal(response.body.errors.length, 1);
  assert.equal(response.body.errors[0].provider, PROVIDER);
  assert.equal(response.text.includes(SECRET), false);
  assert.equal(f.mutations.length, 0);
});

test('legacy removal routes validate lists and never report ok when any provider failed', async () => {
  for (const path of ['/remove-managed', '/remove']) {
    for (const body of [{}, { removals: [] }, { removals: 'model' }, { removals: [null] }, { removals: [{ provider: '', id: 'model' }] }, { provider: PROVIDER, id: '' }]) {
      const { request, calls } = fakeController();
      assert.equal((await request(path, { body })).status, 400);
      assert.equal(calls.length, 0);
    }
    const name = path === '/remove-managed' ? 'removeManagedModels' : 'removeSiblingModels';
    const outcome = { at: 1, applied: [{ provider: PROVIDER, removed: 1 }], errors: [{ provider: 'opaque:failed', reason: 'conflict' }] };
    const { request, calls } = fakeController({ [name]: () => outcome });
    const response = await request(path, { body: { provider: PROVIDER, modelId: 'removed', expectedRevisions: { [PROVIDER]: 7 }, recheck: false } });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, false);
    assert.deepEqual(response.body.errors, outcome.errors);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args[0], [{ provider: PROVIDER, id: 'removed' }]);
    assert.deepEqual(calls[0].args[1], { expectedRevisions: { [PROVIDER]: 7 }, repairs: false, recheck: false, rememberHabit: true });
  }
});

test('post-commit warnings stay separate from errors and do not invite replay of successful writes', async () => {
  const outcome = {
    at: 1, applied: [{ provider: PROVIDER, added: 1, removed: 1 }], errors: [],
    warnings: [{ provider: PROVIDER, reason: '设置已保存，但后续目录检查未完成' }],
  };
  for (const path of ['/apply', '/remove-managed', '/remove']) {
    const method = path === '/apply' ? 'applySelection' : path === '/remove-managed' ? 'removeManagedModels' : 'removeSiblingModels';
    const { request, calls } = fakeController({ [method]: () => outcome });
    const body = path === '/apply'
      ? { selections: { [PROVIDER]: ['incoming'] }, removals: [{ provider: PROVIDER, id: 'enabled' }], expectedRevisions: { [PROVIDER]: 7 } }
      : { removals: [{ provider: 'protocol-alias', owner: PROVIDER, id: 'enabled' }], expectedRevisions: { [PROVIDER]: 7 } };
    const response = await request(path, { body });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.applied, outcome.applied);
    assert.deepEqual(response.body.errors, []);
    assert.deepEqual(response.body.warnings, outcome.warnings);
    if (path !== '/apply') assert.equal(response.body.ok, true);
    assert.equal(calls.length, 1);
  }
});
