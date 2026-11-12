import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncController } from '../lib/sync.js';
import { SyncState } from '../lib/state.js';

// Cross-boundary contracts: real provider discovery, official parsers, catalog
// receipts and planners. All services/HTTP are synthetic; no disk-backed state,
// credential service, model endpoint, settings file or models.dev is accessed.
const copy = (value) => structuredClone(value);
const openai = (...ids) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
const anthropic = (ids, hasMore = false) => ({
  data: ids.map((id) => ({ id, type: 'model' })),
  has_more: hasMore,
  first_id: ids[0],
  last_id: ids.at(-1),
});
const response = (body, status = 200) => ({
  status,
  redirected: false,
  url: '',
  headers: new Headers(),
  json: async () => copy(body),
  text: async () => typeof body === 'string' ? body : JSON.stringify(body),
});

function fixture(t) {
  const entries = [];
  const namespaces = new Map();
  const revisions = new Map();
  const secrets = new Map();
  const calls = { fetch: [], mutations: [], commits: [], backups: 0, saves: 0 };
  const state = Object.create(SyncState.prototype);
  state.data = {
    version: 3, scopeSalt: 'synthetic-contract-salt', catalogs: {}, managed: {},
    siblings: {}, selectionHabits: {}, ownedModels: {}, providerUpdates: {},
    lastCheck: null, lastApply: null, lastRemove: null, repairedAt: null, lastOpenedAt: 0,
  };
  state.save = () => { calls.saves += 1; };
  const h = { entries, state, calls, reply: null, beforeMutate: null, namespaces, revisions };
  const settings = {
    describe: () => [...namespaces].map(([ns, value]) => ({ ns, value: copy(value), revision: revisions.get(ns) })),
    mutate: async (ns, operations, expectedRevision) => {
      calls.mutations.push({ ns, operations: copy(operations), expectedRevision });
      // Deliberately place native edits after controller revalidation, at the
      // settings service's real compare-and-swap boundary.
      if (h.beforeMutate) await h.beforeMutate();
      assert.equal(expectedRevision, revisions.get(ns), 'synthetic settings revision conflict');
      const next = copy(namespaces.get(ns));
      for (const operation of operations) {
        assert.equal(operation.op, 'set', 'official contracts must not replace a provider');
        assert.ok(Array.isArray(operation.path) && operation.path.length > 0);
        let parent = next;
        for (const key of operation.path.slice(0, -1)) {
          assert.ok(parent[key] && typeof parent[key] === 'object', 'operation stays inside an existing profile');
          parent = parent[key];
        }
        parent[operation.path.at(-1)] = copy(operation.value);
      }
      namespaces.set(ns, next);
      revisions.set(ns, expectedRevision + 1);
      calls.commits.push({ ns, revision: expectedRevision + 1 });
      return { revision: expectedRevision + 1 };
    },
  };
  const credentials = {
    resolve: (ref) => {
      assert.ok(secrets.has(ref), 'only fixture-owned credential references may resolve');
      return { value: secrets.get(ref) };
    },
    describe: (ref) => {
      assert.ok(secrets.has(ref), 'only fixture-owned credential metadata may resolve');
      return { configured: true, writable: false, shadowed: false, source: 'synthetic' };
    },
  };
  let discoverKnown;
  const llm = {
    listConfigurableProviders: () => copy(entries),
    listModels: () => [],
    discoverModels: async (ns, request) => {
      const known = discoverKnown?.[request.provider];
      if (known === undefined) throw new Error('unexpected SDK discovery in an explicit-protocol fixture');
      return known.map((id) => ({ id, name: id }));
    },
  };
  const services = { settings, credentials, llm, profileContext: { dir: '/synthetic-contract-profile' } };
  h.controller = new SyncController({
    ctx: { get: (name) => services[name] }, state,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  h.known = (map) => { discoverKnown = map; };
  h.controller.modelsDevIndex = async () => undefined;
  h.controller.backupSettings = async () => { calls.backups += 1; return 'synthetic-no-file-backup'; };
  t.after(() => h.controller.dispose());
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.fetch.push({ url: String(url), headers: new Headers(options.headers) });
    assert.equal(typeof h.reply, 'function', 'every request requires an explicit fixture response');
    return await h.reply(String(url), options);
  });
  h.add = ({
    provider = 'studio-openai', displayName = '任意展示名，不能用于识别厂商',
    ns = 'llm-pi-ai', baseURL = 'https://api.openai.com/v1',
    api = 'openai-completions', models = [{ id: 'gpt-4o', name: 'Existing' }], extra = {},
  } = {}) => {
    assert.ok(!entries.some((entry) => entry.provider === provider && entry.settingsNs === ns));
    const ref = `DSH_CONTRACT_SYNTHETIC_${entries.length}`;
    secrets.set(ref, `synthetic-value-${entries.length}`);
    const value = namespaces.get(ns) ?? { providers: {}, untouchedRoot: { preserved: true } };
    value.providers[provider] = { ...copy(extra), baseURL, ...(api === null ? {} : { api }), apiKeyEnv: ref, models: copy(models) };
    namespaces.set(ns, value);
    revisions.set(ns, (revisions.get(ns) ?? 0) + 1);
    entries.push({ provider, displayName, settingsNs: ns, settingsPath: ['providers', provider], defaultBaseURL: baseURL, nativeAuth: { env: [ref] } });
    return { provider, ns, ref, secret: secrets.get(ref) };
  };
  h.target = (provider, ns = 'llm-pi-ai') => {
    const matches = h.controller.routeTargets().filter((target) => target.actualProvider === provider && target.route.settingsNs === ns);
    assert.equal(matches.length, 1, 'configured instance is uniquely resolved');
    return matches[0];
  };
  h.profile = (provider, ns = 'llm-pi-ai') => copy(namespaces.get(ns).providers[provider]);
  h.revision = (ns = 'llm-pi-ai') => revisions.get(ns);
  h.nativeEdit = (provider, edit, ns = 'llm-pi-ai') => {
    edit(namespaces.get(ns).providers[provider]);
    revisions.set(ns, revisions.get(ns) + 1);
  };
  h.result = (check, provider, ns = 'llm-pi-ai') => {
    const id = h.target(provider, ns).id;
    const result = check.results.find((item) => item.provider === id);
    assert.ok(result, 'check returns the exact configured instance');
    return result;
  };
  h.directory = (body) => { h.reply = async () => response(body); };
  return h;
}

function assertDelta(result, { total, added = [], removed = [], firstDiscovery }) {
  assert.equal(result.status, 'ok');
  assert.equal(result.catalog.total, total);
  assert.deepEqual(result.catalog.addedIds, [...added].sort());
  assert.deepEqual(result.catalog.removedIds, [...removed].sort());
  assert.equal(result.catalog.addedCount, added.length);
  assert.equal(result.catalog.removedCount, removed.length);
  assert.equal(result.catalog.changedCount, added.length + removed.length);
  if (firstDiscovery !== undefined) assert.equal(result.catalog.firstDiscovery, firstDiscovery);
}

async function apply(h, provider, modelIds, options = {}) {
  const target = h.target(provider);
  return h.controller.applySelection({ [target.id]: modelIds }, {
    expectedRevisions: { [target.id]: h.revision() }, recheck: false, ...options,
  });
}

test('contract: runtime OpenAI additions use endpoint identity and keep same-brand instances independent', async (t) => {
  const h = fixture(t);
  assert.equal(h.controller.routeTargets().length, 0);
  const a = h.add({ provider: 'studio-a', displayName: '不是 OpenAI 的固定名称' });
  const bodies = new Map([[a.secret, openai('gpt-4o', 'gpt-4.1')]]);
  h.reply = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    const secret = new Headers(options.headers).get('authorization')?.replace(/^Bearer /, '');
    assert.ok(bodies.has(secret), 'request is scoped to an explicitly configured synthetic account');
    return response(bodies.get(secret));
  };
  let check = await h.controller.check();
  const aId = h.target(a.provider).id;
  assertDelta(h.result(check, a.provider), { total: 2, firstDiscovery: true });

  const b = h.add({ provider: 'studio-b', displayName: '同一家厂商的第二实例' });
  bodies.set(b.secret, openai('gpt-4o', 'gpt-5'));
  assert.equal(h.controller.routeTargets().length, 2, 'no controller restart is needed');
  assert.equal(h.target(a.provider).id, aId, 'adding another instance does not rename the first');
  assert.notEqual(h.target(b.provider).id, aId);
  check = await h.controller.check();
  assert.deepEqual(h.result(check, a.provider).allItems.map((row) => row.id).sort(), ['gpt-4.1', 'gpt-4o']);
  assert.deepEqual(h.result(check, b.provider).allItems.map((row) => row.id).sort(), ['gpt-4o', 'gpt-5']);
  assert.equal(check.results.length, 2);
  const aBefore = h.profile(a.provider);
  const outcome = await apply(h, b.provider, ['gpt-5']);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].provider, h.target(b.provider).id);
  assert.deepEqual(h.profile(a.provider), aBefore);
  assert.deepEqual(h.profile(b.provider).models.map((model) => model.id), ['gpt-4o', 'gpt-5']);
  assert.equal(h.calls.commits.length, 1);
});

test('contract: unread changes are net full-directory differences, not the list of addable models', async (t) => {
  const h = fixture(t);
  const { provider } = h.add({ models: [{ id: 'gpt-4o', name: 'Selected' }, { id: 'manual-only', name: 'Keep me' }] });
  const id = h.target(provider).id;
  h.directory(openai('gpt-4o', 'gpt-4.1'));
  let result = h.result(await h.controller.check(), provider);
  assertDelta(result, { total: 2, firstDiscovery: true });
  assert.deepEqual(result.newItems.map((row) => row.id), ['gpt-4.1'], 'initial addable does not mean newly arrived');
  assert.equal((await h.controller.markViewed(id, result.catalog.revision)).acknowledged, true);

  h.directory(openai('gpt-4.1', 'gpt-5'));
  result = h.result(await h.controller.check(), provider);
  assertDelta(result, { total: 2, added: ['gpt-5'], removed: ['gpt-4o'], firstDiscovery: false });
  const revision = result.catalog.revision;
  result = h.result(await h.controller.check(), provider);
  assert.equal(result.catalog.revision, revision);
  assertDelta(result, { total: 2, added: ['gpt-5'], removed: ['gpt-4o'] });

  h.directory(openai('gpt-4.1', 'gpt-5', 'gpt-5-mini'));
  assertDelta(h.result(await h.controller.check(), provider), { total: 3, added: ['gpt-5', 'gpt-5-mini'], removed: ['gpt-4o'] });
  h.directory(openai('gpt-4.1', 'gpt-5-mini'));
  result = h.result(await h.controller.check(), provider);
  assertDelta(result, { total: 2, added: ['gpt-5-mini'], removed: ['gpt-4o'] });
  const unread = copy(h.state.data.catalogs[id]);
  h.controller.markOpened();
  h.controller.status();
  assert.deepEqual(h.state.data.catalogs[id], unread, 'opening/status reads do not acknowledge a provider');

  h.nativeEdit(provider, (profile) => profile.models.push({ id: 'gpt-5-mini', name: 'Enabled elsewhere' }));
  result = h.result(await h.controller.check(), provider);
  assertDelta(result, { total: 2, added: ['gpt-5-mini'], removed: ['gpt-4o'] });
  assert.equal(result.allItems.find((row) => row.id === 'gpt-5-mini').added, true);
  assert.equal(result.newItems.some((row) => row.id === 'gpt-5-mini'), false, 'enabling elsewhere does not consume the new tag');
  assert.ok(h.profile(provider).models.some((model) => model.id === 'manual-only'));
  assert.equal(h.calls.mutations.length, 0);
});

test('contract: a rendered R receipt cannot consume a subsequently fetched R+1', async (t) => {
  const h = fixture(t);
  const { provider } = h.add();
  const id = h.target(provider).id;
  h.directory(openai('gpt-4o'));
  let result = h.result(await h.controller.check(), provider);
  await h.controller.markViewed(id, result.catalog.revision);
  h.directory(openai('gpt-4o', 'gpt-4.1'));
  const rendered = h.result(await h.controller.check(), provider).catalog;
  h.directory(openai('gpt-4o', 'gpt-4.1', 'gpt-5'));
  const newer = h.result(await h.controller.check(), provider).catalog;
  assert.notEqual(rendered.revision, newer.revision);
  const late = await h.controller.markViewed(id, rendered.revision);
  assert.equal(late.acknowledged, true);
  assert.deepEqual(late.catalog.addedIds, ['gpt-5']);
  assert.equal(late.catalog.changedCount, 1);
  assert.deepEqual(rendered.addedIds, ['gpt-4.1'], 'the rendered snapshot remains unchanged for its current expansion');
  const current = await h.controller.markViewed(id, newer.revision);
  assert.equal(current.acknowledged, true);
  assert.equal(current.catalog.changedCount, 0);
});

const failedDirectories = [
  ['network rejection', () => { throw new Error('synthetic transport failure'); }],
  ['HTTP 401', () => response({ error: 'synthetic unauthorized' }, 401)],
  ['HTTP 429', () => response({ error: 'synthetic rate limited' }, 429)],
  ['malformed row', () => response({ object: 'list', data: [{ id: 'gpt-4o', object: 'model' }, { id: null, object: 'model' }] })],
  ['duplicate ID', () => response(openai('gpt-4o', 'gpt-4o'))],
  ['empty replacement', () => response(openai())],
];
for (const [name, fail] of failedDirectories) {
  test(`contract: ${name} preserves the last complete directory and unread changes`, async (t) => {
    const h = fixture(t);
    const { provider } = h.add();
    const id = h.target(provider).id;
    h.directory(openai('gpt-4o', 'gpt-4.1'));
    let result = h.result(await h.controller.check(), provider);
    await h.controller.markViewed(id, result.catalog.revision);
    h.directory(openai('gpt-4o', 'gpt-4.1', 'gpt-5'));
    result = h.result(await h.controller.check(), provider);
    const before = copy(h.state.data.catalogs[id]);
    const enabledBefore = h.profile(provider);
    h.reply = async () => fail();
    result = h.result(await h.controller.check(), provider);
    assert.equal(result.status, 'discovery-failed');
    assert.equal(result.stale, true);
    assert.deepEqual(h.state.data.catalogs[id], before);
    assert.deepEqual(result.catalog.addedIds, ['gpt-5']);
    assert.deepEqual(result.catalog.removedIds, []);
    assert.equal((await h.controller.markViewed(id, before.generation + ':' + before.serial)).acknowledged, false);
    assert.deepEqual(h.profile(provider), enabledBefore);
    assert.equal(h.calls.mutations.length, 0);
  });
}

test('contract: a later Anthropic page failure cannot commit a partial directory as removals', async (t) => {
  const h = fixture(t);
  const { provider } = h.add({ provider: 'renamed-claude', baseURL: 'https://api.anthropic.com/v1', api: 'anthropic-messages', models: [{ id: 'claude-sonnet-4-6', name: 'Existing' }] });
  const id = h.target(provider).id;
  h.directory(anthropic(['claude-sonnet-4-6', 'claude-opus-4-6']));
  const initial = h.result(await h.controller.check(), provider);
  assert.equal(initial.status, 'ok');
  await h.controller.markViewed(id, initial.catalog.revision);
  const before = copy(h.state.data.catalogs[id]);
  const start = h.calls.fetch.length;
  h.reply = async (url) => new URL(url).searchParams.has('after_id')
    ? response({ error: 'synthetic second page failure' }, 503)
    : response(anthropic(['claude-sonnet-4-6'], true));
  const failed = h.result(await h.controller.check(), provider);
  assert.equal(h.calls.fetch.length - start, 2, 'the test actually exercises the second page');
  assert.equal(failed.status, 'discovery-failed');
  assert.deepEqual(h.state.data.catalogs[id], before);
  assert.equal(failed.catalog.removedCount, 0);
  assert.equal(h.calls.mutations.length, 0);
});

test('contract: explicit addition preserves manual/noncatalog entries, native fields and transport verbatim', async (t) => {
  const h = fixture(t);
  const manual = { id: 'manual-only', name: 'Custom display', input: ['text'], contextWindow: 32123, maxTokens: 222, reasoning: true, compat: { custom: true }, headers: { 'X-Model-Synthetic': 'keep' } };
  const selected = { id: 'gpt-4o', name: 'Native override', contextWindow: 8192, cost: { input: 1.25, output: 2.5 }, customField: { preserved: true } };
  const { provider } = h.add({ models: [manual, selected], extra: { headers: { 'OpenAI-Project': 'synthetic-project' }, timeoutMs: 777, customTransport: { retained: true } } });
  const before = h.profile(provider);
  h.directory(openai('gpt-4.1'));
  const checked = h.result(await h.controller.check(), provider);
  assert.equal(checked.status, 'ok');
  assert.deepEqual(h.profile(provider), before, 'check itself never removes absent enabled entries');
  const outcome = await apply(h, provider, ['gpt-4.1']);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].added, 1);
  assert.equal(outcome.applied[0].removed, 0);
  const after = h.profile(provider);
  assert.deepEqual(after.models.slice(0, 2), [manual, selected]);
  assert.equal(after.models[2].id, 'gpt-4.1');
  const { models: beforeModels, ...beforeTransport } = before;
  const { models: afterModels, ...afterTransport } = after;
  assert.equal(beforeModels.length, 2);
  assert.equal(afterModels.length, 3);
  assert.deepEqual(afterTransport, beforeTransport);
  assert.deepEqual(h.calls.mutations[0].operations.map((operation) => operation.path), [['providers', provider, 'models']]);
  assert.equal(h.calls.commits.length, 1);
});

test('contract: native edit at settings CAS boundary aborts the namespace group without overwriting either instance', async (t) => {
  const h = fixture(t);
  const a = h.add({ provider: 'race-a' });
  const b = h.add({ provider: 'race-b' });
  h.directory(openai('gpt-4o', 'gpt-4.1'));
  await h.controller.check();
  const aId = h.target(a.provider).id;
  const bId = h.target(b.provider).id;
  const revision = h.revision();
  const beforeB = h.profile(b.provider);
  h.beforeMutate = () => {
    h.beforeMutate = null;
    h.nativeEdit(a.provider, (profile) => {
      profile.models.push({ id: 'native-only', name: 'Concurrent native edit', custom: 'must survive' });
      profile.headers = { 'X-Synthetic-Native': 'preserve' };
    });
  };
  const outcome = await h.controller.applySelection({ [aId]: ['gpt-4.1'], [bId]: ['gpt-4.1'] }, {
    expectedRevisions: { [aId]: revision, [bId]: revision }, recheck: false,
  });
  assert.equal(h.calls.mutations.length, 1, 'both plans reach one compare-and-swap');
  assert.equal(h.calls.mutations[0].expectedRevision, revision);
  assert.equal(h.calls.commits.length, 0);
  assert.deepEqual(outcome.applied, []);
  assert.deepEqual(outcome.errors.map((error) => error.provider).sort(), [aId, bId].sort());
  assert.deepEqual(h.profile(a.provider).models.map((model) => model.id), ['gpt-4o', 'native-only']);
  assert.deepEqual(h.profile(a.provider).headers, { 'X-Synthetic-Native': 'preserve' });
  assert.deepEqual(h.profile(b.provider), beforeB);
  assert.equal(h.revision(), revision + 1, 'only the native edit commits');
});

test('contract: an SDK-unknown chat model is enabled only through an explicit provider protocol write', async (t) => {
  const h = fixture(t);
  const { provider } = h.add({ api: null });
  h.directory(openai('gpt-4o', 'gpt-6.1-terra', 'mystery-v1'));
  const checked = h.result(await h.controller.check(), provider);
  assertDelta(checked, { total: 2, firstDiscovery: true });
  const unknown = checked.allItems.find((row) => row.id === 'gpt-6.1-terra');
  assert.ok(unknown, 'the SDK-unknown chat model stays visible so the user can opt in');
  assert.equal(unknown.selectable, true);
  assert.equal(unknown.status, 'available');
  assert.equal(unknown.needsProtocol, true);
  assert.equal(unknown.reasonCode, 'protocol');
  assert.match(unknown.reason, /openai-responses/);
  assert.equal(checked.newItems.some((row) => row.id === 'gpt-6.1-terra'), true);
  assert.deepEqual(checked.skipped.map((row) => [row.id, row.reasonCode]), [['mystery-v1', 'non-chat']]);
  const outcome = await apply(h, provider, ['gpt-6.1-terra']);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.applied.length, 1);
  assert.equal(h.profile(provider).api, 'openai-responses', 'the opt-in writes the provider protocol once');
  assert.deepEqual(h.profile(provider).models.map((model) => model.id).sort(), ['gpt-4o', 'gpt-6.1-terra']);
});

test('contract: non-chat and duplicate dated snapshots leave the visible catalog', async (t) => {
  const h = fixture(t);
  const { provider } = h.add({ api: null });
  h.directory(openai('gpt-5.4-2026-03-05', 'gpt-5.4', 'text-embedding-3-large', 'mystery-v1'));
  const checked = h.result(await h.controller.check(), provider);
  assert.equal(checked.layout, 'grid', 'a single-vendor official route uses the two-column grid');
  assert.deepEqual(checked.allItems.map((row) => row.id), ['gpt-5.4']);
  assert.equal(checked.catalog.total, 1, 'filtered rows never enter the unread baseline');
  const duplicate = checked.skipped.find((row) => row.id === 'gpt-5.4-2026-03-05');
  assert.equal(duplicate.reasonCode, 'duplicate');
  assert.equal(duplicate.duplicateOf, 'gpt-5.4');
  assert.equal(checked.skipped.find((row) => row.id === 'text-embedding-3-large').reasonCode, 'non-chat');
  assert.equal(checked.skipped.find((row) => row.id === 'mystery-v1').reasonCode, 'non-chat');
});

test('contract: an enabled dated snapshot stays manageable and an unaliased snapshot stays visible', async (t) => {
  const h = fixture(t);
  const { provider } = h.add({ api: null, models: [{ id: 'gpt-5.4-2026-03-05', name: 'Pinned' }] });
  h.directory(openai('gpt-5.4-2026-03-05', 'gpt-5.4', 'gpt-5.6-2026-01-01'));
  const checked = h.result(await h.controller.check(), provider);
  const enabled = checked.allItems.find((row) => row.id === 'gpt-5.4-2026-03-05');
  assert.ok(enabled, 'an already enabled snapshot must never disappear');
  assert.equal(enabled.status, 'added');
  assert.equal(enabled.removable, true);
  assert.equal(checked.skipped.some((row) => row.id === 'gpt-5.4-2026-03-05'), false);
  assert.ok(checked.allItems.some((row) => row.id === 'gpt-5.6-2026-01-01'),
    'a dated model without an upstream alias is not hidden as a duplicate');
});

test('contract: public Zhipu schema retains provenance through discovery and status without account-availability claims', async (t) => {
  const h = fixture(t);
  const { provider } = h.add({ provider: 'custom-zhipu-name', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-4.7', name: 'Existing' }] });
  const schema = {
    openapi: '3.0.1', servers: [{ url: 'https://open.bigmodel.cn/api/' }],
    paths: { '/paas/v4/chat/completions': { post: { requestBody: { content: { 'application/json': { schema: { oneOf: [
      { $ref: '#/components/schemas/ChatCompletionTextRequest' },
      { $ref: '#/components/schemas/ChatCompletionVisionRequest' },
    ] } } } } } } },
    components: { schemas: {
      ChatCompletionTextRequest: { properties: { model: { type: 'string', enum: ['glm-5.3', 'glm-4.7'] } } },
      ChatCompletionVisionRequest: { properties: { model: { type: 'string', enum: ['glm-5.3-flash', 'autoglm-phone'] } } },
    } },
  };
  h.reply = async (url, options) => {
    assert.equal(url, 'https://docs.bigmodel.cn/openapi/openapi.json');
    const headers = new Headers(options.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('x-api-key'), false);
    return response(schema);
  };
  const checked = h.result(await h.controller.check(), provider);
  assert.equal(checked.status, 'ok');
  assert.equal(checked.source, 'official-schema');
  assert.equal(checked.notice, '官方公开目录，非账号可用性验证');
  assert.equal(checked.catalog.total, 3, 'non-chat schema rows are filtered from the visible catalog');
  assert.deepEqual(checked.allItems.map((row) => row.id).sort(), ['glm-4.7', 'glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual(checked.skipped.map((row) => row.id), ['autoglm-phone']);
  const publicResult = h.result(h.controller.status().lastCheck, provider);
  assert.equal(publicResult.source, 'official-schema');
  assert.equal(publicResult.notice, checked.notice);
  assert.equal(h.calls.fetch.length, 1, 'does not probe a guessed authenticated /models endpoint');
  assert.equal(h.calls.mutations.length, 0);
});

test('contract: native DeepSeek resolves its documented endpoint when the directory omits defaultBaseURL', (t) => {
  const h = fixture(t);
  h.namespaces.set('llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-pro' }] });
  h.revisions.set('llm-deepseek', 1);
  h.entries.push({ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], nativeAuth: { env: ['DEEPSEEK_API_KEY'] } });
  const target = h.controller.routeTargets().find((row) => row.actualProvider === 'deepseek-official');
  assert.ok(target, 'the native DeepSeek row is discovered');
  assert.equal(target.managed, true);
  assert.equal(target.reason, undefined, 'the native adapter must not be treated as an unknown endpoint');
  assert.equal(target.baseUrls[0], 'https://api.deepseek.com');
  assert.equal(target.official?.baseURL, 'https://api.deepseek.com');
  assert.equal(target.legacy, false);
});

test('contract: builtin routes without defaultBaseURL resolve and claim their protocol siblings', (t) => {
  const h = fixture(t);
  const key = 'OPENCODE_API_KEY';
  h.namespaces.set('llm-pi-ai', { providers: {
    opencode: { apiKeyEnv: key, models: [{ id: 'claude-opus-5-5' }] },
    'opencode-chat': { displayName: 'OpenCode · Chat Completions', api: 'openai-completions', baseURL: 'https://opencode.ai/zen/v1', apiKeyEnv: key, models: [{ id: 'deepseek-v4.1-flash-free' }] },
    'opencode-messages': { displayName: 'OpenCode · Anthropic Messages', api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen', apiKeyEnv: key, models: [{ id: 'claude-haiku-5-5' }] },
  } });
  h.revisions.set('llm-pi-ai', 1);
  for (const provider of ['opencode', 'opencode-chat', 'opencode-messages']) {
    h.entries.push({ provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], nativeAuth: { env: [key] } });
  }
  const targets = h.controller.routeTargets();
  const opencode = targets.find((row) => row.actualProvider === 'opencode');
  assert.ok(opencode, 'a built-in route without defaultBaseURL is discovered');
  assert.equal(opencode.legacy, true, 'documented built-in endpoints stay on the legacy path');
  assert.equal(opencode.reason, undefined);
  assert.equal(opencode.baseUrls[0], 'https://opencode.ai/zen/v1');
  assert.equal(targets.some((row) => row.actualProvider === 'opencode-chat'), false, 'matching chat sibling stays inside its owner card');
  assert.equal(targets.some((row) => row.actualProvider === 'opencode-messages'), false, 'matching messages sibling stays inside its owner card');
});

test('contract: compact and preview dated snapshots fold into their aliases', async (t) => {
  const anthropicFixture = fixture(t);
  const anthropicTarget = anthropicFixture.add({ provider: 'renamed-claude', baseURL: 'https://api.anthropic.com/v1', api: 'anthropic-messages' });
  anthropicFixture.directory(anthropic(['claude-opus-4-1', 'claude-opus-4-1-20250805']));
  const checkedAnthropic = anthropicFixture.result(await anthropicFixture.controller.check(), anthropicTarget.provider);
  assert.deepEqual(checkedAnthropic.allItems.map((row) => row.id), ['claude-opus-4-1']);
  const compact = checkedAnthropic.skipped.find((row) => row.id === 'claude-opus-4-1-20250805');
  assert.equal(compact.reasonCode, 'duplicate');
  assert.equal(compact.duplicateOf, 'claude-opus-4-1');

  const unaliasedFixture = fixture(t);
  const unaliasedTarget = unaliasedFixture.add({ provider: 'renamed-claude', baseURL: 'https://api.anthropic.com/v1', api: 'anthropic-messages' });
  unaliasedFixture.directory(anthropic(['claude-opus-4-1-20250805']));
  const checkedUnaliased = unaliasedFixture.result(await unaliasedFixture.controller.check(), unaliasedTarget.provider);
  assert.deepEqual(checkedUnaliased.allItems.map((row) => row.id), ['claude-opus-4-1-20250805'],
    'a compact-dated model without an upstream alias stays visible');

  const previewFixture = fixture(t);
  const previewTarget = previewFixture.add({ provider: 'studio-openai' });
  previewFixture.directory(openai('gpt-5.4', 'gpt-5.4-preview-06-05'));
  const checkedPreview = previewFixture.result(await previewFixture.controller.check(), previewTarget.provider);
  assert.deepEqual(checkedPreview.allItems.map((row) => row.id), ['gpt-5.4']);
  const preview = checkedPreview.skipped.find((row) => row.id === 'gpt-5.4-preview-06-05');
  assert.equal(preview.reasonCode, 'duplicate');
  assert.equal(preview.duplicateOf, 'gpt-5.4');
});

test('contract: an installed-catalog hit is not flagged as needing a protocol write', async (t) => {
  const h = fixture(t);
  const { provider } = h.add({ api: null });
  h.known({ openai: ['gpt-4o'] });
  h.directory(openai('gpt-4o', 'gpt-6.1-terra', 'mystery-v1'));
  const checked = h.result(await h.controller.check(), provider);
  const known = checked.allItems.find((row) => row.id === 'gpt-4o');
  assert.ok(known, 'the catalog-known chat model stays visible');
  assert.equal(known.needsProtocol, undefined, 'a known model must not ask for a protocol write');
  const unknown = checked.allItems.find((row) => row.id === 'gpt-6.1-terra');
  assert.equal(unknown.needsProtocol, true);
  assert.equal(unknown.reasonCode, 'protocol');
  assert.equal(checked.skipped.find((row) => row.id === 'mystery-v1').reasonCode, 'non-chat');
});
