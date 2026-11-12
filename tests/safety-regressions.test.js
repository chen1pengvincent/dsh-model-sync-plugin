import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncController } from '../lib/sync.js';
import { SyncState } from '../lib/state.js';
import { BUILTIN_ROUTES } from '../lib/routes.js';
import { expectedSiblingNames } from '../lib/engine.js';
import { configuredTargets } from '../lib/providers.js';
import { acknowledgeCatalog, catalogSummary, updateCatalog } from '../lib/catalog.js';

// Controller regressions use real methods with in-memory state and explicit fakes.
// Do not construct SyncState: its constructor reads disk. No test resolves a real
// credential, writes a settings document, or sends an upstream request.
function memoryState() {
  const state = Object.create(SyncState.prototype);
  state.data = {
    version: 3,
    scopeSalt: 'synthetic-safety-test-salt',
    catalogs: {}, managed: {}, siblings: {}, selectionHabits: {}, ownedModels: {},
    providerUpdates: {}, lastCheck: null, lastApply: null, lastRemove: null,
    repairedAt: null, lastOpenedAt: 0,
  };
  state.save = () => {};
  return state;
}

function denyNetwork(t) {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request in a safety regression');
  });
}

function controllerFor(t, state, settings = {}) {
  const controller = new SyncController({
    state,
    ctx: {
      get(name) {
        if (name === 'settings') return settings;
        if (name === 'credentials') throw new Error('Real credential resolution is forbidden in this test');
        return undefined;
      },
    },
    logger: { warn() {}, info() {}, error() {} },
  });
  t.after(() => controller.dispose());
  return controller;
}

function siblingFixture(t) {
  denyNetwork(t);
  const state = memoryState();
  const controller = controllerFor(t, state);
  const route = Object.values(BUILTIN_ROUTES).find((item) => item.provider === 'opencode-go');
  assert.ok(route, 'the legacy route fixture must be an existing route');
  const sibling = expectedSiblingNames(route)[0];
  assert.ok(sibling);
  const targets = ['A', 'B'].map((suffix) => ({
    id: `cfg_owner_${suffix}`,
    managed: true,
    legacy: true,
    route: { ...route, settingsNs: `entry-${suffix}` },
    descriptor: {
      ns: `entry-${suffix}`,
      value: { providers: { [sibling]: { models: [{ id: 'shared-id' }, { id: 'retain' }] } } },
    },
  }));
  controller.routeTargets = () => targets;
  const calls = [];
  controller.applySelection = async (selections, options) => {
    calls.push({ selections, options });
    return { at: 1, applied: [], errors: [] };
  };
  return { controller, targets, sibling, calls };
}

test('sibling removal honors the owner identity returned by managedSiblings', async (t) => {
  // This exercises identity routing, not native adapter registration. Native DSH
  // can reject duplicate active provider IDs; the removal boundary must still
  // never ignore an explicit owner or silently choose a different namespace.
  const { controller, targets, sibling, calls } = siblingFixture(t);
  const row = controller.managedSiblings().find((item) => item.owner === targets[1].id && item.provider === sibling);
  assert.ok(row);
  await controller.removeManagedModels([{ provider: row.provider, owner: row.owner, id: 'shared-id' }], { recheck: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.removals, [{ provider: targets[1].id, id: 'shared-id' }]);
});

test('ambiguous bare sibling names are rejected instead of choosing the first owner', async (t) => {
  const { controller, sibling, calls } = siblingFixture(t);
  await assert.rejects(controller.removeManagedModels([{ provider: sibling, id: 'shared-id' }], { recheck: false }));
  assert.equal(calls.length, 0, 'ambiguous input must never reach applySelection');
});

test('a stale or invalid explicit sibling owner cannot fall back to another owner', async (t) => {
  const { controller, sibling, calls } = siblingFixture(t);
  await assert.rejects(controller.removeManagedModels([
    { provider: sibling, owner: 'cfg_owner_removed', id: 'shared-id' },
  ], { recheck: false }));
  assert.equal(calls.length, 0);
});

function applyFixture(t, beforeCommit = () => {}) {
  denyNetwork(t);
  const state = memoryState();
  const writes = [];
  const settings = {
    async mutate(ns, operations, expectedRevision) {
      writes.push({ ns, operations: structuredClone(operations), expectedRevision });
    },
  };
  const controller = controllerFor(t, state, settings);
  const target = {
    id: 'cfg_commit_scope',
    managed: true,
    legacy: false,
    adapter: 'pi-ai',
    reason: undefined,
    configScope: 'config-scope-A',
    settingsRevision: 7,
    settingsPath: ['providers', 'openai'],
    route: { provider: 'openai', displayName: 'Synthetic official account', settingsNs: 'entry-official' },
    profile: { models: [{ id: 'retain' }] },
    descriptor: { ns: 'entry-official', revision: 7, value: { providers: { openai: { models: [{ id: 'retain' }] } } } },
  };
  let credential = { ref: 'SYNTHETIC_TEST_REF', value: 'synthetic-account-A' };
  // configuredTargets creates fresh snapshots; model that here rather than
  // mutating the very object captured by the planning pass.
  controller.routeTargets = () => [structuredClone(target)];
  controller.credentialFor = async () => ({ ...credential });
  state.commitCatalog(target.id, controller.scopeFor(target, credential), target.configScope,
    [{ id: 'retain' }, { id: 'new' }], { at: Date.now() });
  state.data.lastCheck = { at: Date.now(), results: [
    { provider: target.id, status: 'ok', settingsRevision: 7, configScope: target.configScope },
  ] };
  let planned = false;
  let backupReached = false;
  controller.planOfficial = async (current, selected) => {
    assert.equal(current.id, target.id);
    assert.deepEqual(selected, ['new']);
    planned = true;
    return {
      target: current,
      ops: [{ op: 'set', path: ['providers', 'openai', 'models'], value: [{ id: 'retain' }, { id: 'new' }] }],
      added: 1, removed: 0, addedIds: ['new'], removedIds: [], createdSiblings: [],
    };
  };
  const fixture = {
    controller, state, target, writes,
    rotateCredential() { credential = { ...credential, value: 'synthetic-account-B' }; },
    get planned() { return planned; },
    get backupReached() { return backupReached; },
  };
  controller.backupSettings = async () => {
    backupReached = true;
    await Promise.resolve();
    beforeCommit(fixture);
  };
  return fixture;
}

for (const [name, change] of [
  ['credential rotation', (fixture) => fixture.rotateCredential()],
  ['management opt-out', (fixture) => { fixture.target.managed = false; }],
  ['endpoint/configuration scope change', (fixture) => { fixture.target.configScope = 'config-scope-B'; }],
]) {
  test(`applySelection rejects ${name} after planning and before namespace commit`, async (t) => {
    const fixture = applyFixture(t, change);
    const result = await fixture.controller.applySelection({ [fixture.target.id]: ['new'] }, {
      expectedRevisions: { [fixture.target.id]: 7 }, recheck: false,
    });
    assert.equal(fixture.planned, true, 'exercise the post-planning race, not an earlier rejection');
    assert.equal(fixture.backupReached, true, 'the simulated change occurs in the last async pre-commit phase');
    assert.equal(fixture.writes.length, 0, 'a different account/scope or an opted-out target must not be written');
    assert.equal(result.applied.length, 0);
    assert.ok(result.errors.length > 0, 'a stale operation must report that a fresh check is required');
  });
}

test('applySelection stable-scope control commits exactly once with the checked revision', async (t) => {
  const fixture = applyFixture(t);
  const result = await fixture.controller.applySelection({ [fixture.target.id]: ['new'] }, {
    expectedRevisions: { [fixture.target.id]: 7 }, recheck: false,
  });
  assert.equal(fixture.planned, true);
  assert.equal(fixture.backupReached, true);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].ns, 'entry-official');
  assert.equal(fixture.writes[0].expectedRevision, 7);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.errors, []);
});

function assertCommittedWithStateWarning(fixture, result) {
  assert.equal(fixture.writes.length, 1, 'an already committed settings mutation must never be replayed');
  assert.equal(result.applied.length, 1, 'retain the successful settings commit even if local bookkeeping fails');
  assert.equal(result.applied[0].provider, fixture.target.id);
  assert.equal(result.applied[0].added, 1);
  assert.deepEqual(result.errors, [], 'do not report a committed mutation as an unchanged configuration failure');
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0,
    'partial local-state failure needs an explicit non-fatal warning');
  assert.ok(result.warnings.some((warning) => {
    const text = typeof warning === 'string' ? warning : JSON.stringify(warning);
    return /已保存|已提交/u.test(text) && /状态|记账/u.test(text) && /失败|未能|未完成/u.test(text);
  }), 'the warning must distinguish saved configuration from failed local-state bookkeeping');
}

test('successful settings commit survives rememberOwned failure with a truthful state warning', async (t) => {
  const fixture = applyFixture(t);
  let faults = 0;
  fixture.state.rememberOwned = () => {
    faults += 1;
    throw new Error('Synthetic ownership persistence failure after settings commit');
  };
  const result = await fixture.controller.applySelection({ [fixture.target.id]: ['new'] }, {
    expectedRevisions: { [fixture.target.id]: 7 }, recheck: false,
  });
  assert.equal(faults, 1, 'exercise the post-mutate ownership failure');
  assertCommittedWithStateWarning(fixture, result);
});

test('successful settings commit survives final state.save failure without rejecting the request', async (t) => {
  const fixture = applyFixture(t);
  // Isolate the final lastApply persistence boundary, not the saves ordinarily
  // triggered by rememberOwned/forgetOwned before that boundary.
  fixture.state.rememberOwned = () => {};
  fixture.state.forgetOwned = () => {};
  let faults = 0;
  fixture.state.save = () => {
    faults += 1;
    assert.equal(fixture.writes.length, 1, 'the final persistence failure occurs after settings committed');
    assert.equal(fixture.state.data.lastApply?.applied.length, 1,
      'the final save must be persisting an already successful result');
    throw new Error('Synthetic final lastApply persistence failure after settings commit');
  };
  const result = await fixture.controller.applySelection({ [fixture.target.id]: ['new'] }, {
    expectedRevisions: { [fixture.target.id]: 7 }, recheck: false,
  });
  assert.equal(faults, 1, 'exercise the final state.save failure exactly once');
  assertCommittedWithStateWarning(fixture, result);
});

function legacyCheckFixture(t, body) {
  const state = memoryState();
  const controller = controllerFor(t, state, {
    async mutate() { assert.fail('a directory check must never write settings'); },
  });
  const route = Object.values(BUILTIN_ROUTES).find((item) => item.provider === 'opencode-go');
  const target = {
    id: 'cfg_legacy_strict', managed: true, legacy: true, adapter: 'pi-ai',
    route: { ...route, settingsNs: 'entry-legacy' },
    settingsRevision: 3, configScope: 'legacy-scope',
    baseUrls: ['https://legacy.invalid/v1'], existingModels: [{ id: 'retained' }],
    profile: { models: [{ id: 'retained' }] },
    descriptor: { ns: 'entry-legacy', revision: 3, value: { providers: {} } },
  };
  const credential = { ref: 'SYNTHETIC_TEST_REF', value: 'synthetic-account' };
  controller.routeTargets = () => [target];
  controller.credentialFor = async () => ({ ...credential });
  controller.describeCredential = async () => ({ ref: credential.ref, configured: true, source: 'synthetic' });
  controller.modelsDevIndex = async () => undefined;
  controller.resultFor = async () => ({
    provider: target.id, status: 'ok', source: 'account-api', newItems: [],
    settingsRevision: 3, configScope: target.configScope,
  });
  const scope = controller.scopeFor(target, credential);
  state.commitCatalog(target.id, scope, target.configScope, [{ id: 'retained' }]);
  state.acknowledgeCatalog(target.id, catalogSummary(state.catalog(target.id)).revision);
  state.commitCatalog(target.id, scope, target.configScope, [{ id: 'retained' }, { id: 'previous' }]);
  const before = structuredClone(state.catalog(target.id));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://legacy.invalid/v1/models');
    requests += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { controller, state, target, before, get requests() { return requests; } };
}

for (const [name, rows] of [
  ['null row', [{ id: 'retained' }, null]],
  ['missing id', [{ id: 'retained' }, { missingId: true }]],
  ['non-string id', [{ id: 'retained' }, { id: 123 }]],
  ['empty id', [{ id: 'retained' }, { id: '' }]],
  ['duplicate id', [{ id: 'retained' }, { id: 'retained' }]],
  ['empty directory', []],
]) {
  test(`legacy ${name} fails the whole check and retains the prior catalog and unread baseline`, async (t) => {
    const fixture = legacyCheckFixture(t, { data: rows });
    const result = await fixture.controller.performCheck();
    assert.equal(fixture.requests, 1);
    assert.equal(result.results[0].status, 'discovery-failed');
    assert.equal(result.results[0].stale, true);
    assert.deepEqual(fixture.state.catalog(fixture.target.id), fixture.before,
      'no partial-success replacement, generation change, checkedAt change, or unread reset');
    assert.deepEqual(result.results[0].catalog.addedIds, ['previous']);
  });
}

test('legacy valid complete-directory control still commits its catalog', async (t) => {
  const fixture = legacyCheckFixture(t, { data: [{ id: 'retained' }, { id: 'previous' }, { id: 'new' }] });
  const result = await fixture.controller.performCheck();
  assert.equal(fixture.requests, 1);
  assert.equal(result.results[0].status, 'ok');
  assert.deepEqual(fixture.state.catalog(fixture.target.id).models.map((model) => model.id), ['retained', 'previous', 'new']);
  assert.deepEqual(result.results[0].catalog.addedIds, ['new', 'previous']);
});

const rows = (...ids) => ids.map((id) => ({ id }));

test('late acknowledgement applies only the rendered revision and cannot acknowledge future arrivals', () => {
  let record = updateCatalog(undefined, 'scope-A', rows('a'), { at: 1 });
  const revision1 = catalogSummary(record).revision;
  assert.equal(acknowledgeCatalog(record, revision1, 2).acknowledged, true);
  record = updateCatalog(record, 'scope-A', rows('a', 'b'), { at: 3 });
  const revision2 = catalogSummary(record).revision;
  record = updateCatalog(record, 'scope-A', rows('a', 'b', 'c'), { at: 4 });
  assert.equal(acknowledgeCatalog(record, revision2, 5).acknowledged, true);
  assert.deepEqual(catalogSummary(record).addedIds, ['c']);
  const after = structuredClone(record);
  assert.equal(acknowledgeCatalog(record, revision1, 6).acknowledged, false);
  assert.deepEqual(record, after, 'an older response must not roll back the seen baseline');
});

test('changing account scope resets generation and rejects an old-scope acknowledgement', () => {
  const original = updateCatalog(undefined, 'scope-A', rows('a'), { at: 1 });
  const oldRevision = catalogSummary(original).revision;
  const changed = updateCatalog(original, 'scope-B', rows('a', 'b'), { at: 2 });
  const before = structuredClone(changed);
  assert.notEqual(changed.generation, original.generation);
  assert.equal(acknowledgeCatalog(changed, oldRevision, 3).acknowledged, false);
  assert.deepEqual(changed, before);
  assert.equal(catalogSummary(changed).firstDiscovery, true);
});

test('expired history and malformed/future revision tokens never change the seen baseline', () => {
  let record = updateCatalog(undefined, 'scope-A', rows('initial'), { at: 1 });
  const expiredRevision = catalogSummary(record).revision;
  for (let index = 0; index < 20; index += 1) {
    record = updateCatalog(record, 'scope-A', rows(`model-${index}`), { at: index + 2 });
  }
  const before = structuredClone(record);
  for (const revision of [
    expiredRevision,
    `${record.generation}:0`,
    `${record.generation}:01`,
    `${record.generation}:1e0`,
    `${record.generation}:${record.serial + 1}`,
    'unrelated-generation:1',
  ]) {
    assert.equal(acknowledgeCatalog(record, revision, 99).acknowledged, false);
    assert.deepEqual(record, before);
  }
});

test('same ID set with reordered rows retains the revision and unread baseline', () => {
  let record = updateCatalog(undefined, 'scope-A', rows('a'), { at: 1 });
  record = updateCatalog(record, 'scope-A', rows('a', 'b'), { at: 2 });
  const previous = catalogSummary(record);
  const next = updateCatalog(record, 'scope-A', [{ id: 'b', name: 'Renamed B' }, { id: 'a' }], { at: 3 });
  assert.equal(catalogSummary(next).revision, previous.revision);
  assert.deepEqual(catalogSummary(next).addedIds, ['b']);
  assert.deepEqual(next.seenIds, record.seenIds);
  assert.equal(next.checkedAt, 3);
});

test('catalog rejects malformed or empty replacement data without changing the prior record', () => {
  const record = updateCatalog(undefined, 'scope-A', rows('retained'), { at: 1 });
  const before = structuredClone(record);
  for (const invalid of [[], [null], [{}], [{ id: '' }], [{ id: ' ' }], rows('duplicate', 'duplicate')]) {
    assert.throws(() => updateCatalog(record, 'scope-A', invalid, { at: 2 }));
    assert.deepEqual(record, before);
  }
});

test('a configured route that only shares a sibling name stays visible', () => {
  const state = { managedOverride: () => undefined };
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai', revision: 1,
      value: { providers: {
        opencode: { apiKeyEnv: 'OPENCODE_API_KEY', models: [{ id: 'x' }] },
        'opencode-chat': { displayName: 'My Gateway', apiKeyEnv: 'MY_KEY', baseURL: 'https://example.com/v1', models: [{ id: 'y' }] },
      } },
    }],
  };
  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'llm') return {
        listConfigurableProviders: () => [
          { provider: 'opencode', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode'], defaultBaseURL: 'https://opencode.ai/zen/v1', displayName: 'OpenCode' },
          { provider: 'opencode-chat', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-chat'], defaultBaseURL: 'https://example.com/v1', displayName: 'My Gateway' },
        ],
      };
      return undefined;
    },
  };
  const targets = configuredTargets(ctx, state);
  assert.ok(targets.some((target) => target.actualProvider === 'opencode-chat'),
    'hiding a user route by name alone reproduces the invisible-provider bug');
});

test('a route matching a sibling transport but using its own credential stays visible', () => {
  const state = { managedOverride: () => undefined };
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai', revision: 1,
      value: { providers: {
        opencode: { apiKeyEnv: 'OPENCODE_API_KEY', models: [{ id: 'x' }] },
        'opencode-chat': { displayName: 'My Chat', apiKeyEnv: 'MY_CHAT_KEY', api: 'openai-completions', baseURL: 'https://opencode.ai/zen/v1', models: [{ id: 'y' }] },
      } },
    }],
  };
  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'llm') return {
        listConfigurableProviders: () => [
          { provider: 'opencode', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode'], defaultBaseURL: 'https://opencode.ai/zen/v1', displayName: 'OpenCode' },
          { provider: 'opencode-chat', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-chat'], defaultBaseURL: 'https://opencode.ai/zen/v1', displayName: 'My Chat' },
        ],
      };
      return undefined;
    },
  };
  const targets = configuredTargets(ctx, state);
  assert.ok(targets.some((target) => target.actualProvider === 'opencode-chat'),
    'a different credential binding means the route is not plugin-owned');
  assert.ok(targets.some((target) => target.actualProvider === 'opencode'));
});

test('DeepSeek Account is excluded from discovery entirely', () => {
  const state = { managedOverride: () => undefined };
  const settings = {
    describe: () => [{
      ns: 'llm-deepseek-account', revision: 1,
      value: { models: [{ id: 'account-model' }] },
    }],
  };
  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'llm') return {
        listConfigurableProviders: () => [{
          provider: 'deepseek-account', settingsNs: 'llm-deepseek-account', settingsPath: [],
          displayName: 'DeepSeek Account',
        }],
      };
      return undefined;
    },
  };
  assert.deepEqual(configuredTargets(ctx, state), []);
});
