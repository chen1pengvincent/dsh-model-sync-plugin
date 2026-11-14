import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncController } from '../lib/sync.js';
import { SyncState } from '../lib/state.js';

function applyOps(root, ops) {
  for (const op of ops) {
    let node = root;
    for (const key of op.path.slice(0, -1)) {
      if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
      node = node[key];
    }
    const tail = op.path.at(-1);
    if (op.op === 'unset') delete node[tail];
    else node[tail] = structuredClone(op.value);
  }
}

function makeHarness({ modelList, opencodeList = ['claude-opus-5-5', 'mimo-v2.6-flash-free'], extraProviders = false, credentialDescription = { configured: true, source: 'file', writable: true, shadowed: false }, kimiStatus = undefined, modelsDevExtra = {}, openrouterList = ['x/one', 'y/two'], openrouterProfile = {}, deepseekProfile = {}, llmModels = undefined, kimiList = ['k3'], kimiProfile = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'model-sync-test-'));
  const state = new SyncState(dir);
  const providers = {
    'opencode-go': { displayName: 'OpenCode Go', apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'kimi-k3', name: 'Kimi K3' }] },
    opencode: {
      apiKeyEnv: 'OPENCODE_API_KEY',
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free' }],
    },
  };
  if (extraProviders) {
    providers.openrouter = { displayName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY', models: [], ...openrouterProfile };
    providers['kimi-coding'] = { displayName: 'Kimi Coding', apiKeyEnv: 'KIMI_CODING_API_KEY', models: [], ...structuredClone(kimiProfile) };
  }
  const document = {
    'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }], ...deepseekProfile },
    'llm-pi-ai': { providers },
  };
  const revisions = Object.fromEntries(Object.keys(document).map((ns) => [ns, 1]));
  const patchPath = join(dir, 'synthetic-settings.patch.yaml');
  const persistPatch = () => writeFileSync(patchPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  persistPatch();
  const mutations = [];
  const descriptions = [];
  let prepareCalls = 0;
  const settings = {
    describe(options) {
      descriptions.push(structuredClone(options));
      return Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: revisions[ns] }));
    },
    async prepareDocument() { prepareCalls += 1; return patchPath; },
    async mutate(ns, ops, expectedRevision) {
      assert.ok(Object.hasOwn(document, ns), `unknown synthetic namespace: ${ns}`);
      assert.ok(Number.isInteger(expectedRevision), 'every save carries an observed settings revision');
      assert.equal(expectedRevision, revisions[ns], 'a stale namespace must never be overwritten');
      assert.ok(ops.length > 0, 'no-op plans must not invoke settings.mutate');
      const paths = ops.map((op) => JSON.stringify(op.path));
      assert.equal(new Set(paths).size, paths.length, 'the CAS must not contain duplicate paths');
      applyOps(document[ns], ops);
      mutations.push({ ns, ops: structuredClone(ops), expectedRevision });
      revisions[ns] += 1;
      persistPatch();
    },
  };
  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'credentials') return { resolve: async () => ({ value: 'synthetic-test-credential' }), describe: async () => credentialDescription };
      if (name === 'llm' && llmModels !== undefined) return { listModels: async (provider) => structuredClone(llmModels[provider] ?? []) };
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  const catalogs = {
    go: structuredClone(modelList), opencode: structuredClone(opencodeList),
    deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'], openrouter: structuredClone(openrouterList), kimi: structuredClone(kimiList),
  };
  const requests = [];
  const fetchCalls = [];
  const rows = (list) => list.map((model) => typeof model === 'string' ? { id: model, object: 'model' } : { object: 'model', ...structuredClone(model) });
  const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    requests.push(address);
    fetchCalls.push({ url: address, headers: init.headers instanceof Headers ? Object.fromEntries(init.headers) : structuredClone(init.headers ?? {}) });
    if (address === 'https://models.dev/api.json') {
      return response({
        deepseek: { npm: '@ai-sdk/openai-compatible', models: { 'deepseek-v4-flash': { attachment: true, limit: { context: 1000000 } } } },
        'opencode-go': {
          npm: '@ai-sdk/openai-compatible',
          models: {
            'minimax-m3': { provider: { npm: '@ai-sdk/anthropic' } },
            'gpt-5.6-luna': { provider: { npm: '@ai-sdk/openai' } },
          },
        },
        opencode: {
          npm: '@ai-sdk/openai-compatible',
          models: {
            'qwen3.8-max': {},
            'claude-haiku-5-5': { provider: { npm: '@ai-sdk/anthropic' } },
            'gemini-4-argon': { provider: { npm: '@ai-sdk/google' } },
          },
        },
        ...structuredClone(modelsDevExtra),
      });
    }
    const endpoints = [
      ['https://api.deepseek.com/models', 'deepseek'],
      ['https://opencode.ai/zen/go/v1/models', 'go'],
      ['https://opencode.ai/zen/v1/models', 'opencode'],
      ['https://openrouter.ai/api/v1/models', 'openrouter'],
      ['https://api.kimi.com/coding/v1/models', 'kimi'],
    ];
    const endpoint = endpoints.find(([prefix]) => address.startsWith(prefix));
    if (endpoint) {
      if (endpoint[1] === 'kimi' && kimiStatus !== undefined) {
        return new Response(JSON.stringify({ error: { message: 'synthetic' } }), { status: kimiStatus, headers: { 'content-type': 'application/json' } });
      }
      return response({ object: 'list', data: rows(catalogs[endpoint[1]]) });
    }
    throw new Error(`Unexpected synthetic fetch target: ${address}`);
  };
  const controller = new SyncController({ ctx, state, logger: { info() {}, warn() {}, error() {} } });
  // The switch itself is covered by tests/proxy-policy.test.js; every other test
  // must not touch the machine's real proxy settings (or install a dispatcher).
  controller.proxy = {
    disposed: false,
    apply: async (enabled) => ({ enabled: enabled === true, active: false }),
    status: () => ({ enabled: state.proxyEnabled(), active: false }),
    dispose() {},
  };
  return {
    controller, state, document, mutations, settings, revisions, descriptions, catalogs, requests, fetchCalls, patchPath,
    get prepareCalls() { return prepareCalls; },
    cleanup() {
      controller.dispose();
      globalThis.fetch = realFetch;
      assert.ok(dir.startsWith(join(tmpdir(), 'model-sync-test-')), 'cleanup is restricted to this temporary fixture');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// These helpers represent explicit user actions, never an implicit controller refresh.
async function checkedRevisions(harness) {
  const check = await harness.controller.check();
  return Object.fromEntries(check.results.map((result) => [result.provider, result.settingsRevision]));
}
async function checkedApply(harness, selections, options = {}) {
  const expectedRevisions = await checkedRevisions(harness);
  return harness.controller.applySelection(selections, { ...options, expectedRevisions: { ...expectedRevisions, ...options.expectedRevisions } });
}
async function checkedRemove(harness, items, { method = 'removeManagedModels', ...options } = {}) {
  const expectedRevisions = await checkedRevisions(harness);
  return harness.controller[method](items, { ...options, expectedRevisions: { ...expectedRevisions, ...options.expectedRevisions } });
}
function assertApplied(outcome, { provider, added = 0, removed = 0 }) {
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(outcome.warnings, []);
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].provider, provider);
  assert.equal(outcome.applied[0].added, added);
  assert.equal(outcome.applied[0].removed, removed);
}
function assertRefused(outcome) {
  assert.deepEqual(outcome.applied, []);
  assert.ok(outcome.errors.length > 0, 'an unsafe request must return a visible refusal');
}
const FULL_LIST = ['kimi-k3', 'deepseek-flash', 'minimax-m3', 'gpt-5.6-luna'];

test('check is read-only and lists new models with placement', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const before = structuredClone(h.document);
    const payload = await h.controller.check();
    const go = payload.results.find((row) => row.provider === 'opencode-go');
    assert.equal(go.status, 'ok');
    assert.deepEqual(go.newItems.map((item) => [item.id, item.target]), [
      ['deepseek-flash', 'opencode-go'], ['minimax-m3', 'opencode-go-messages'], ['gpt-5.6-luna', 'opencode-go-responses'],
    ]);
    assert.deepEqual(go.newItems.map((item) => item.vendor), ['DeepSeek', 'MiniMax', 'OpenAI']);
    const ds = payload.results.find((row) => row.provider === 'deepseek-official');
    assert.equal(ds.status, 'ok', ds.reason);
    assert.deepEqual(ds.newItems.map((item) => item.id), ['deepseek-v4-flash']);
    assert.equal(go.catalog.changedCount, 0, 'initial discovery is a baseline, not a new-model notification');
    assert.equal(go.catalog.firstDiscovery, true);
    assert.equal(go.layout, 'groups', 'multi-vendor gateways keep vendor-grouped cards');
    assert.ok(h.state.data.lastCheck.results.find((row) => row.provider === 'opencode-go').newItems.every((item) => item.entry === undefined));
    assert.ok(h.controller.status().lastCheck.results.every((row) => row.newItems.every((item) => item.entry === undefined)), 'public status strips model-write payloads for every provider');
    assert.deepEqual(h.document, before);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
  } finally { h.cleanup(); }
});

test('openrouter lists but preselects nothing; kimi is preselected; managed toggle works', async () => {
  const h = makeHarness({ modelList: FULL_LIST, extraProviders: true });
  try {
    const payload = await h.controller.check();
    const openrouter = payload.results.find((row) => row.provider === 'openrouter');
    assert.equal(openrouter.defaultSelected, false);
    assert.deepEqual(openrouter.newItems.map((item) => item.id), ['x/one', 'y/two']);
    assert.equal(payload.results.find((row) => row.provider === 'kimi-coding').defaultSelected, true);
    h.controller.setManaged('openrouter', false);
    assert.equal(h.controller.status().managed.find((item) => item.provider === 'openrouter').managed, false);
    assert.equal((await h.controller.check()).results.find((row) => row.provider === 'openrouter').status, 'unmanaged');
    assertRefused(await checkedApply(h, { openrouter: ['x/one'] }));
    assert.equal(h.mutations.length, 0);
    h.controller.setManaged('openrouter', true);
    assert.equal(h.controller.status().managed.find((item) => item.provider === 'openrouter').managed, true);
    assertApplied(await checkedApply(h, { openrouter: ['x/one'] }), { provider: 'openrouter', added: 1 });
    const profile = h.document['llm-pi-ai'].providers.openrouter;
    assert.deepEqual(profile.models.map((model) => model.id), ['x/one']);
    assert.equal(profile.baseURL, undefined, 'native endpoint is not materialized by a model save');
    assert.equal(profile.api, undefined, 'native protocol is not replaced by a model save');
    assert.equal(profile.apiKeyEnv, 'OPENROUTER_API_KEY');
    assertApplied(await checkedApply(h, { 'kimi-coding': ['k3'] }), { provider: 'kimi-coding', added: 1 });
    const kimi = h.document['llm-pi-ai'].providers['kimi-coding'];
    assert.deepEqual(kimi.models.map((model) => model.id), ['k3']);
    assert.equal(kimi.api, 'anthropic-messages', 'single-protocol compat routes pin their protocol so catalog api cannot invalidate route compat');
    assert.equal(kimi.baseURL, 'https://api.kimi.com/coding', 'the protocol pin must carry the Anthropic base path, not the /v1 OpenAI discovery path');
    assert.equal(new URL(`${kimi.baseURL}/v1/messages`).href, 'https://api.kimi.com/coding/v1/messages');
    assert.equal(kimi.apiKeyEnv, 'KIMI_CODING_API_KEY');
  } finally { h.cleanup(); }
});

test('a custom baseURL blocks the protocol pin instead of being overwritten', async () => {
  const h = makeHarness({ modelList: FULL_LIST, extraProviders: true });
  try {
    h.document['llm-pi-ai'].providers['kimi-coding'].baseURL = 'https://api.kimi.com/coding/v1';
    const outcome = await checkedApply(h, { 'kimi-coding': ['k3'] });
    assertRefused(outcome);
    assert.match(outcome.errors[0].reason, /自定义 baseURL/);
    assert.equal(h.mutations.length, 0, 'the refusal happens before settings.mutate');
    assert.equal(h.document['llm-pi-ai'].providers['kimi-coding'].api, undefined);
    assert.equal(h.document['llm-pi-ai'].providers['kimi-coding'].baseURL, 'https://api.kimi.com/coding/v1');
  } finally { h.cleanup(); }
});

test('an explicit incompatible api is refused instead of producing the generic error', async () => {
  const h = makeHarness({ modelList: FULL_LIST, extraProviders: true });
  try {
    h.document['llm-pi-ai'].providers['kimi-coding'].api = 'openai-completions';
    const outcome = await checkedApply(h, { 'kimi-coding': ['k3'] });
    assertRefused(outcome);
    assert.match(outcome.errors[0].reason, /openai-completions|未托管/);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.document['llm-pi-ai'].providers['kimi-coding'].api, 'openai-completions');
  } finally { h.cleanup(); }
});

test('an unknown kimi model gets the pinned protocol and endpoint', async () => {
  const h = makeHarness({ modelList: FULL_LIST, extraProviders: true, kimiList: ['k3', 'k3.1-pro'] });
  try {
    assertApplied(await checkedApply(h, { 'kimi-coding': ['k3.1-pro'] }), { provider: 'kimi-coding', added: 1 });
    const kimi = h.document['llm-pi-ai'].providers['kimi-coding'];
    assert.deepEqual(kimi.models.map((model) => model.id), ['k3.1-pro']);
    assert.equal(kimi.api, 'anthropic-messages');
    assert.equal(kimi.baseURL, 'https://api.kimi.com/coding');
    assert.equal(new URL(`${kimi.baseURL}/v1/messages`).href, 'https://api.kimi.com/coding/v1/messages');
  } finally { h.cleanup(); }
});

test('after pinning kimi the next check still uses the catalog listing base', async () => {
  const h = makeHarness({ modelList: FULL_LIST, extraProviders: true });
  try {
    assertApplied(await checkedApply(h, { 'kimi-coding': ['k3'] }), { provider: 'kimi-coding', added: 1 });
    const before = h.requests.length;
    const payload = await h.controller.check();
    const kimi = payload.results.find((row) => row.provider === 'kimi-coding');
    assert.equal(kimi.status, 'ok', kimi.reason);
    const after = h.requests.slice(before);
    assert.ok(after.includes('https://api.kimi.com/coding/v1/models'), 'the pinned wire base must not replace the discovery base');
    assert.ok(!after.includes('https://api.kimi.com/coding/models'), 'the discovery probe must not use the wire base');
  } finally { h.cleanup(); }
});

test('removal-only saves still repair a compat route with no api pin', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true,
    kimiList: ['k3.1-pro', 'k3.1-pro-highspeed'],
    kimiProfile: { models: [
      { id: 'k3.1-pro', compat: { forceAdaptiveThinking: true } },
      { id: 'k3.1-pro-highspeed', compat: { forceAdaptiveThinking: true } },
    ] },
  });
  try {
    const outcome = await checkedRemove(h, [{ provider: 'kimi-coding', id: 'k3.1-pro-highspeed' }]);
    assertApplied(outcome, { provider: 'kimi-coding', removed: 1 });
    const kimi = h.document['llm-pi-ai'].providers['kimi-coding'];
    assert.deepEqual(kimi.models.map((model) => model.id), ['k3.1-pro']);
    assert.equal(kimi.api, 'anthropic-messages');
    assert.equal(kimi.baseURL, 'https://api.kimi.com/coding');
  } finally { h.cleanup(); }
});

test('an explicit correct api gets a missing baseURL repaired', async () => {
  const h = makeHarness({ modelList: FULL_LIST, extraProviders: true });
  try {
    h.document['llm-pi-ai'].providers['kimi-coding'].api = 'anthropic-messages';
    assertApplied(await checkedApply(h, { 'kimi-coding': ['k3'] }), { provider: 'kimi-coding', added: 1 });
    const kimi = h.document['llm-pi-ai'].providers['kimi-coding'];
    assert.equal(kimi.api, 'anthropic-messages');
    assert.equal(kimi.baseURL, 'https://api.kimi.com/coding');
  } finally { h.cleanup(); }
});

test('a trailing slash on the pinned base is normalized', async () => {
  const h = makeHarness({ modelList: FULL_LIST, extraProviders: true });
  try {
    h.document['llm-pi-ai'].providers['kimi-coding'].api = 'anthropic-messages';
    h.document['llm-pi-ai'].providers['kimi-coding'].baseURL = 'https://api.kimi.com/coding/';
    assertApplied(await checkedApply(h, { 'kimi-coding': ['k3'] }), { provider: 'kimi-coding', added: 1 });
    assert.equal(h.document['llm-pi-ai'].providers['kimi-coding'].baseURL, 'https://api.kimi.com/coding');
  } finally { h.cleanup(); }
});

test('a null compat entry does not crash a compat-route save', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true,
    kimiList: ['k3', 'k3.1-pro'],
    kimiProfile: { models: [{ id: 'k3', compat: null }] },
  });
  try {
    assertApplied(await checkedApply(h, { 'kimi-coding': ['k3.1-pro'] }), { provider: 'kimi-coding', added: 1 });
    const kimi = h.document['llm-pi-ai'].providers['kimi-coding'];
    assert.equal(kimi.models.find((model) => model.id === 'k3').compat, null);
    assert.deepEqual(kimi.models.find((model) => model.id === 'k3.1-pro').compat, { allowEmptySignature: true, forceAdaptiveThinking: true });
    assert.equal(kimi.api, 'anthropic-messages');
    assert.equal(kimi.baseURL, 'https://api.kimi.com/coding');
  } finally { h.cleanup(); }
});

test('applySelection appends only selected ids and creates protocol siblings', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const original = structuredClone(h.document['llm-pi-ai'].providers['opencode-go'].models[0]);
    const outcome = await checkedApply(h, { 'opencode-go': ['deepseek-flash', 'minimax-m3', 'gpt-5.6-luna'] });
    assertApplied(outcome, { provider: 'opencode-go', added: 3 });
    assert.equal(h.mutations.length, 1, 'reported additions must correspond to a real namespace CAS');
    const providers = h.document['llm-pi-ai'].providers;
    assert.deepEqual(providers['opencode-go'].models.map((model) => model.id), ['kimi-k3', 'deepseek-flash']);
    assert.deepEqual(providers['opencode-go'].models[0], original, 'manual rows survive whole');
    assert.deepEqual(providers['opencode-go-messages'].models.map((model) => model.id), ['minimax-m3']);
    assert.equal(providers['opencode-go-messages'].api, 'anthropic-messages');
    assert.deepEqual(providers['opencode-go-responses'].models.map((model) => model.id), ['gpt-5.6-luna']);
    assert.equal(providers['opencode-go-responses'].api, 'openai-responses');
    assert.deepEqual(h.state.knownSiblings('opencode-go').sort(), ['opencode-go-messages', 'opencode-go-responses']);
    const writes = h.mutations.length;
    const backups = h.prepareCalls;
    const again = await checkedApply(h, { 'opencode-go': ['deepseek-flash', 'minimax-m3', 'gpt-5.6-luna'] });
    assert.deepEqual(again.errors, []);
    assert.equal(h.mutations.length, writes, 're-adding is a write-free no-op');
    assert.equal(h.prepareCalls, backups);
  } finally { h.cleanup(); }
});

test('an unknown main-route model is materialized in the primary protocol sibling', async () => {
  const h = makeHarness({
    modelList: FULL_LIST,
    llmModels: { 'opencode-go': [{ id: 'kimi-k3' }, { id: 'claude-haiku-5-5' }] },
  });
  const main = h.document['llm-pi-ai'].providers['opencode-go'];
  main.models = [{ id: 'kimi-k3' }, { id: 'claude-haiku-5-5' }];
  try {
    const beforeMain = structuredClone(main);
    const outcome = await checkedApply(h, { 'opencode-go': ['deepseek-flash'] });
    assertApplied(outcome, { provider: 'opencode-go', added: 1 });
    assert.deepEqual(outcome.warnings, []);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go'], beforeMain);
    const chat = h.document['llm-pi-ai'].providers['opencode-go-chat'];
    assert.equal(chat.api, 'openai-completions');
    assert.equal(chat.baseURL, 'https://opencode.ai/zen/go/v1');
    assert.equal(chat.apiKeyEnv, 'OPENCODE_GO_API_KEY');
    assert.deepEqual(chat.models.map((model) => model.id), ['deepseek-flash']);
    assert.deepEqual(h.state.knownSiblings('opencode-go'), ['opencode-go-chat']);
    const checked = (await h.controller.check()).results.find((row) => row.provider === 'opencode-go');
    const chatRow = checked.allItems.find((item) => item.id === 'deepseek-flash');
    assert.equal(chatRow.target, 'opencode-go');
    assert.equal(chatRow.originProviderName, 'opencode-go-chat', 'physical owner must not be the classified target');
    const writes = h.mutations.length;
    const again = await checkedApply(h, { 'opencode-go': ['deepseek-flash'] });
    assert.deepEqual(again.errors, []);
    assert.equal(again.applied[0].added, 0, 'the primary sibling is part of the existing-model scan');
    assert.equal(h.mutations.length, writes, 're-adding is a write-free no-op');
  } finally { h.cleanup(); }
});

test('a brand-new upstream-classified model is routed to its protocol sibling', async () => {
  const h = makeHarness({
    modelList: [...FULL_LIST, 'brand-new-model'],
    llmModels: { 'opencode-go': [{ id: 'kimi-k3' }] },
    modelsDevExtra: { 'opencode-go': { npm: '@ai-sdk/openai-compatible', models: { 'brand-new-model': { provider: { npm: '@ai-sdk/openai-compatible' } } } } },
  });
  try {
    const before = structuredClone(h.document['llm-pi-ai'].providers['opencode-go']);
    const outcome = await checkedApply(h, { 'opencode-go': ['brand-new-model'] });
    assertApplied(outcome, { provider: 'opencode-go', added: 1 });
    assert.deepEqual(outcome.warnings, []);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go'], before, 'the main provider transport is never rewritten');
    const chat = h.document['llm-pi-ai'].providers['opencode-go-chat'];
    assert.equal(chat.api, 'openai-completions');
    assert.equal(chat.baseURL, 'https://opencode.ai/zen/go/v1');
    assert.deepEqual(chat.models.map((model) => model.id), ['brand-new-model']);
  } finally { h.cleanup(); }
});

test('a model materialized in the primary sibling can be removed again', async () => {
  const h = makeHarness({
    modelList: FULL_LIST,
    llmModels: { 'opencode-go': [{ id: 'kimi-k3' }] },
  });
  try {
    assertApplied(await checkedApply(h, { 'opencode-go': ['deepseek-flash'] }), { provider: 'opencode-go', added: 1 });
    assert.ok(h.document['llm-pi-ai'].providers['opencode-go-chat']);
    assertApplied(await checkedApply(h, { 'opencode-go': [] }, { removals: [{ provider: 'opencode-go', id: 'deepseek-flash' }] }), { provider: 'opencode-go', removed: 1 });
    assert.equal(h.document['llm-pi-ai'].providers['opencode-go-chat'], undefined);
    assert.deepEqual(h.state.knownSiblings('opencode-go'), []);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go'].models.map((model) => model.id), ['kimi-k3']);
  } finally { h.cleanup(); }
});

test('a customized primary sibling is not deleted wholesale by a main-card removal', async () => {
  const h = makeHarness({ modelList: FULL_LIST, llmModels: { 'opencode-go': [{ id: 'kimi-k3' }] } });
  try {
    assertApplied(await checkedApply(h, { 'opencode-go': ['deepseek-flash'] }), { provider: 'opencode-go', added: 1 });
    const chat = h.document['llm-pi-ai'].providers['opencode-go-chat'];
    chat.baseURL = 'https://proxy.example/v1';
    chat.apiKeyEnv = 'PROXY_KEY';
    const before = structuredClone(chat);
    const outcome = await checkedApply(h, { 'opencode-go': [] }, { removals: [{ provider: 'opencode-go', id: 'deepseek-flash' }] });
    assertRefused(outcome);
    assert.match(outcome.errors[0].reason, /自定义连接配置/);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go-chat'], before);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go'].models.map((model) => model.id), ['kimi-k3']);
  } finally { h.cleanup(); }
});

test('a foreign provider with a builtin sibling name is not reported as owned', async () => {
  const h = makeHarness({ modelList: FULL_LIST, llmModels: { 'opencode-go': [{ id: 'kimi-k3' }] } });
  try {
    const foreign = { api: 'openai-completions', baseURL: 'https://custom.example/v1', apiKeyEnv: 'MY_KEY', models: [{ id: 'deepseek-flash', name: 'Foreign Flash' }] };
    h.document['llm-pi-ai'].providers['opencode-go-chat'] = structuredClone(foreign);
    const outcome = await checkedApply(h, { 'opencode-go': ['deepseek-flash'] });
    assert.deepEqual(outcome.errors, []);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go-chat'], foreign);
    assert.equal(h.document['llm-pi-ai'].providers['opencode-go'].models.some((model) => model.id === 'deepseek-flash'), false);
    assert.match(outcome.warnings[0].reason, /不在本机模型目录中/);
  } finally { h.cleanup(); }
});

test('an unknown model is redirected even when the main provider pins a different api', async () => {
  const h = makeHarness({ modelList: FULL_LIST, llmModels: { 'opencode-go': [{ id: 'kimi-k3' }] } });
  try {
    const main = h.document['llm-pi-ai'].providers['opencode-go'];
    main.api = 'anthropic-messages';
    main.baseURL = 'https://opencode.ai/zen/go';
    const before = structuredClone(main);
    const outcome = await checkedApply(h, { 'opencode-go': ['deepseek-flash'] });
    assertApplied(outcome, { provider: 'opencode-go', added: 1 });
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go'], before);
    assert.equal(h.document['llm-pi-ai'].providers['opencode-go-chat'].models[0].id, 'deepseek-flash');
    assert.equal(h.document['llm-pi-ai'].providers['opencode-go-chat'].api, 'openai-completions');
  } finally { h.cleanup(); }
});

test('an unknown main-route model does not rewrite existing explicit rows', async () => {
  const h = makeHarness({ modelList: FULL_LIST, llmModels: { 'opencode-go': [{ id: 'kimi-k3' }] } });
  try {
    const before = structuredClone(h.document['llm-pi-ai'].providers['opencode-go']);
    const outcome = await checkedApply(h, { 'opencode-go': ['deepseek-flash'] });
    assert.equal(outcome.errors.length, 0);
    assert.deepEqual(outcome.warnings, []);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go'], before);
    assert.deepEqual(h.document['llm-pi-ai'].providers['opencode-go-chat'].models.map((model) => model.id), ['deepseek-flash']);
  } finally { h.cleanup(); }
});

test('deepseek additions preserve complete manual entries and native configuration', async () => {
  const h = makeHarness({ modelList: ['kimi-k3'] });
  try {
    const profile = h.document['llm-deepseek'];
    const original = structuredClone(profile.models[0]);
    assertApplied(await checkedApply(h, { 'deepseek-official': ['deepseek-v4-flash'] }), { provider: 'deepseek-official', added: 1 });
    assert.deepEqual(profile.models.map((model) => model.id), ['deepseek-v4-pro', 'deepseek-v4-flash']);
    assert.deepEqual(profile.models[0], original);
    assert.equal(profile.api, undefined);
    assert.equal(profile.baseURL, undefined);
    assert.equal(profile.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.deepEqual(h.mutations[0].ops.map((op) => op.path), [['models']]);
  } finally { h.cleanup(); }
});

test('startup reports legacy misplacements read-only; explicit repair is idempotent', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    h.document['llm-pi-ai'].providers['opencode-go'].models.push({ id: 'minimax-m3', name: 'MiniMax M3' });
    const before = structuredClone(h.document);
    const startup = await h.controller.startup();
    assert.ok(startup.results.find((row) => row.provider === 'opencode-go').repairs.length > 0);
    await h.controller.startup();
    assert.deepEqual(h.document, before);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
    const repaired = await checkedApply(h, {}, { repairs: true });
    assert.deepEqual(repaired.errors, []);
    const providers = h.document['llm-pi-ai'].providers;
    assert.deepEqual(providers['opencode-go'].models.map((model) => model.id), ['kimi-k3']);
    assert.deepEqual(providers['opencode-go-messages'].models.map((model) => model.id), ['minimax-m3']);
    assert.equal(h.mutations.length, 1);
    const backups = h.prepareCalls;
    assert.deepEqual((await checkedApply(h, {}, { repairs: true })).errors, []);
    assert.equal(h.mutations.length, 1, 'an explicit second repair is idempotent');
    assert.equal(h.prepareCalls, backups);
  } finally { h.cleanup(); }
});

test('startup never auto-applies additions', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const before = structuredClone(h.document);
    await h.controller.startup();
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
    assert.deepEqual(h.document, before);
    assert.ok(h.state.data.lastCheck.results.some((row) => row.newItems.length > 0));
  } finally { h.cleanup(); }
});

test('explicit shadowed/read-only credential metadata surfaces a safe persisted warning', async () => {
  const h = makeHarness({ modelList: FULL_LIST, credentialDescription: { configured: true, source: 'env', writable: false, shadowed: true } });
  try {
    const row = (await h.controller.check()).results.find((item) => item.provider === 'opencode-go');
    assert.equal(row.credential.configured, true);
    assert.equal(row.credential.source, 'env');
    assert.equal(row.credential.readOnly, true);
    assert.equal(row.credential.shadowed, true);
    assert.match(row.credential.warning, /只读/);
    assert.equal(row.credential.warning.includes('synthetic-test-credential'), false);
    assert.deepEqual(h.state.data.lastCheck.results.find((item) => item.provider === row.provider).credential, row.credential);
    assert.equal(h.mutations.length, 0);
  } finally { h.cleanup(); }
});

test('writable file credential reports configured and not shadowed', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const row = (await h.controller.check()).results.find((item) => item.provider === 'opencode-go');
    assert.equal(row.credential.configured, true);
    assert.equal(row.credential.writable, true);
    assert.equal(row.credential.readOnly, false);
    assert.equal(row.credential.shadowed, false);
    assert.equal(row.credential.warning, undefined);
  } finally { h.cleanup(); }
});

test('writable env metadata is not inferred to be read-only or shadowed', async () => {
  const h = makeHarness({ modelList: FULL_LIST, credentialDescription: { configured: true, source: 'env', writable: true, shadowed: false } });
  try {
    const row = (await h.controller.check()).results.find((item) => item.provider === 'opencode-go');
    assert.equal(row.credential.configured, true);
    assert.equal(row.credential.source, 'env');
    assert.equal(row.credential.writable, true);
    assert.equal(row.credential.readOnly, false);
    assert.equal(row.credential.shadowed, false);
    assert.equal(row.credential.warning, undefined);
  } finally { h.cleanup(); }
});

test('absent credential metadata is tolerated without exposing the resolved value', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    // Unique fake references keep the optional env-metadata fallback away from user credentials.
    for (const [index, profile] of [h.document['llm-deepseek'], ...Object.values(h.document['llm-pi-ai'].providers)].entries()) {
      profile.apiKeyEnv = `TEST_ONLY_${h.patchPath.replace(/\W/g, '_')}_${index}`;
    }
    const get = h.controller.ctx.get.bind(h.controller.ctx);
    h.controller.ctx.get = (name) => name === 'credentials' ? { resolve: async () => ({ value: 'synthetic-test-credential' }) } : get(name);
    const row = (await h.controller.check()).results.find((item) => item.provider === 'opencode-go');
    assert.equal(row.status, 'ok');
    assert.equal(row.credential.configured, false, 'missing metadata is not fabricated from a resolved value');
    assert.equal(row.credential.writable, false);
    assert.equal(row.credential.source, undefined);
    assert.equal(JSON.stringify(row).includes('synthetic-test-credential'), false);
  } finally { h.cleanup(); }
});

test('reads actual descriptor revisions without requiring settings.get', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    assert.equal(h.settings.get, undefined);
    const byProvider = Object.fromEntries((await h.controller.check()).results.map((row) => [row.provider, row]));
    assert.equal(byProvider['opencode-go'].status, 'ok');
    assert.equal(byProvider['deepseek-official'].status, 'ok');
    assert.equal(byProvider['opencode-go'].settingsRevision, 1);
    assert.equal(byProvider['deepseek-official'].settingsRevision, 1);
    assert.ok(h.descriptions.length > 0);
    assert.equal(h.mutations.length, 0);
  } finally { h.cleanup(); }
});

test('opencode candidates use siblings without rewriting the catalog provider', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'mimo-v2.6-flash-free', 'claude-haiku-5-5', 'qwen3.8-max', 'gemini-4-argon', 'claude-opus-5-5-backup'] });
  try {
    const original = structuredClone(h.document['llm-pi-ai'].providers.opencode);
    const row = (await h.controller.check()).results.find((item) => item.provider === 'opencode');
    assert.equal(row.defaultSelected, false);
    assert.deepEqual(row.newItems.map((item) => [item.id, item.target]), [
      ['claude-haiku-5-5', 'opencode-messages'], ['qwen3.8-max', 'opencode-chat'], ['claude-opus-5-5-backup', 'opencode-messages'],
    ]);
    assert.deepEqual(row.skipped.map((item) => item.id), ['gemini-4-argon']);
    assertApplied(await checkedApply(h, { opencode: ['claude-haiku-5-5', 'qwen3.8-max'] }), { provider: 'opencode', added: 2 });
    const providers = h.document['llm-pi-ai'].providers;
    assert.deepEqual(providers.opencode, original);
    assert.ok(h.mutations.every((mutation) => mutation.ops.every((op) => op.path[1] !== 'opencode')));
    assert.deepEqual(providers['opencode-messages'].models.map((model) => model.id), ['claude-haiku-5-5']);
    assert.equal(providers['opencode-messages'].api, 'anthropic-messages');
    assert.equal(providers['opencode-messages'].baseURL, 'https://opencode.ai/zen');
    assert.equal(providers['opencode-messages'].apiKeyEnv, 'OPENCODE_API_KEY');
    assert.deepEqual(providers['opencode-chat'].models.map((model) => model.id), ['qwen3.8-max']);
    assert.equal(providers['opencode-chat'].baseURL, 'https://opencode.ai/zen/v1');
    assert.deepEqual(h.state.knownSiblings('opencode').sort(), ['opencode-chat', 'opencode-messages']);
    const before = h.mutations.length;
    assert.deepEqual((await checkedApply(h, {}, { repairs: true })).errors, []);
    assert.equal(h.mutations.length, before);
  } finally { h.cleanup(); }
});

test('descriptor saves use prepareDocument and the observed namespace CAS revision', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    assertApplied(await checkedApply(h, { 'opencode-go': ['minimax-m3'] }), { provider: 'opencode-go', added: 1 });
    assert.ok(h.document['llm-pi-ai'].providers['opencode-go-messages'].models.some((model) => model.id === 'minimax-m3'));
    assert.equal(h.prepareCalls, 1);
    assert.equal(h.mutations[0].ns, 'llm-pi-ai');
    assert.equal(h.mutations[0].expectedRevision, 1);
    assert.equal(h.revisions['llm-pi-ai'], 2);
    assert.equal(h.revisions['llm-deepseek'], 1);
  } finally { h.cleanup(); }
});

test('managedSiblings returns flat owner/version rows without modifying manual model metadata', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    h.state.rememberSiblings('opencode', ['opencode-chat', 'opencode-messages', 'opencode-responses']);
    const providers = h.document['llm-pi-ai'].providers;
    providers['opencode-messages'] = { displayName: 'OpenCode · Anthropic Messages', models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'] }] };
    providers['opencode-chat'] = { models: [{ id: 'qwen3.8-max', input: ['text', 'audio'] }] };
    providers['opencode-responses'] = { models: [] };
    const before = structuredClone(providers);
    assert.ok(h.controller.managedSiblings().every((row) => row.status === 'needs-check'));
    await checkedRevisions(h);
    const rows = h.controller.managedSiblings();
    assert.ok(Array.isArray(rows));
    assert.deepEqual(rows.filter((row) => row.models.length).map((row) => row.provider).sort(), ['opencode-chat', 'opencode-messages']);
    assert.ok(rows.every((row) => row.owner === 'opencode' && row.routeProvider === 'opencode' && row.settingsRevision === 1));
    assert.ok(rows.every((row) => row.status === 'ok'));
    assert.deepEqual(rows.find((row) => row.provider === 'opencode-chat').models, [{ id: 'qwen3.8-max', name: 'qwen3.8-max' }]);
    assert.deepEqual(rows.find((row) => row.provider === 'opencode-messages').models, [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }]);
    assert.ok(rows.filter((row) => row.provider === 'opencode-responses').every((row) => row.models.length === 0));
    assert.deepEqual(providers, before);
    assert.equal(h.mutations.length, 0);
  } finally { h.cleanup(); }
});

test('removeSiblingModel drops an owned sibling and a later check offers the model again', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'claude-haiku-5-5'] });
  try {
    assertApplied(await checkedApply(h, { opencode: ['claude-haiku-5-5'] }), { provider: 'opencode', added: 1 });
    await checkedRevisions(h); // Single-item compatibility wrapper uses this exact last-check revision.
    const original = structuredClone(h.document['llm-pi-ai'].providers.opencode);
    const outcome = await h.controller.removeSiblingModel('opencode-messages', 'claude-haiku-5-5');
    assertApplied(outcome, { provider: 'opencode', removed: 1 });
    assert.equal(h.document['llm-pi-ai'].providers['opencode-messages'], undefined);
    assert.deepEqual(h.document['llm-pi-ai'].providers.opencode, original);
    assert.deepEqual(h.mutations.at(-1).ops, [{ op: 'unset', path: ['providers', 'opencode-messages'] }]);
    assert.deepEqual(h.state.data.lastRemove.removed, outcome.applied);
    const row = (await h.controller.check()).results.find((item) => item.provider === 'opencode');
    assert.ok(row.newItems.some((item) => item.id === 'claude-haiku-5-5' && item.target === 'opencode-messages'));
    assert.deepEqual(h.controller.managedSiblings(), []);
  } finally { h.cleanup(); }
});

test('non-sibling providers and malformed removal requests never mutate settings', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    h.state.rememberSiblings('opencode', ['opencode-messages']);
    h.document['llm-pi-ai'].providers['opencode-messages'] = { models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }] };
    const expectedRevisions = await checkedRevisions(h);
    const before = structuredClone(h.document);
    await assert.rejects(() => h.controller.removeSiblingModel('opencode', 'claude-opus-5-5'));
    await assert.rejects(() => h.controller.removeSiblingModel('openrouter', 'x/one'));
    await assert.rejects(() => h.controller.removeSiblingModel('opencode-messages', ''));
    await assert.rejects(() => h.controller.removeSiblingModels([{ provider: 'opencode-messages', id: 'ok' }, { provider: 'opencode', id: 'nope' }]));
    await assert.rejects(() => h.controller.removeSiblingModels([{ provider: 'opencode-messages', id: 'ok' }, { provider: 'openrouter', id: 'x/one' }]));
    assertRefused(await h.controller.removeSiblingModels([{ provider: 'opencode-messages', id: 'x'.repeat(201), owner: 'opencode' }], { expectedRevisions, recheck: false }));
    assertRefused(await h.controller.removeSiblingModels(Array.from({ length: 101 }, () => ({ provider: 'opencode-messages', id: 'not-present', owner: 'opencode' })), { expectedRevisions, recheck: false }));
    await assert.rejects(() => h.controller.removeSiblingModels([], { expectedRevisions, recheck: false }), /至少选择一个模型/);
    assert.deepEqual(h.document, before);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
  } finally { h.cleanup(); }
});

test('removeSiblingModels removes multiple owned routes with one namespace CAS', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'claude-haiku-5-5', 'qwen3.8-max'] });
  try {
    assertApplied(await checkedApply(h, { opencode: ['claude-haiku-5-5', 'qwen3.8-max'] }), { provider: 'opencode', added: 2 });
    const before = h.mutations.length;
    const outcome = await checkedRemove(h, [
      { provider: 'opencode-messages', id: 'claude-haiku-5-5', owner: 'opencode' },
      { provider: 'opencode-chat', id: 'qwen3.8-max', owner: 'opencode' },
    ], { method: 'removeSiblingModels' });
    assertApplied(outcome, { provider: 'opencode', removed: 2 });
    assert.equal(h.mutations.length, before + 1);
    assert.equal(h.mutations.at(-1).expectedRevision, 2);
    assert.deepEqual(h.mutations.at(-1).ops.map((op) => [op.op, op.path]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
      ['unset', ['providers', 'opencode-chat']], ['unset', ['providers', 'opencode-messages']],
    ]);
    assert.equal(h.document['llm-pi-ai'].providers['opencode-messages'], undefined);
    assert.equal(h.document['llm-pi-ai'].providers['opencode-chat'], undefined);
    assert.deepEqual(h.state.data.lastRemove.removed, outcome.applied);
  } finally { h.cleanup(); }
});

test('unmatched removals preserve settings, catalogs, ownership and backups', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    h.state.rememberSiblings('opencode', ['opencode-messages']);
    h.document['llm-pi-ai'].providers['opencode-messages'] = { models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }] };
    const expectedRevisions = await checkedRevisions(h);
    const before = structuredClone({ document: h.document, catalogs: h.state.data.catalogs, ownedModels: h.state.data.ownedModels, siblings: h.state.knownSiblings('opencode') });
    const outcome = await h.controller.removeSiblingModels([
      { provider: 'opencode-messages', id: 'nope', owner: 'opencode' },
      { provider: 'opencode-messages', id: 'nope', owner: 'opencode' },
    ], { expectedRevisions, recheck: false });
    assertRefused(outcome);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
    assert.deepEqual(h.document, before.document);
    assert.deepEqual(h.state.data.catalogs, before.catalogs);
    assert.deepEqual(h.state.data.ownedModels, before.ownedModels);
    assert.deepEqual(h.state.knownSiblings('opencode'), before.siblings);
    assert.deepEqual(h.state.data.lastRemove.removed, [], 'failure bookkeeping never claims a deletion');
  } finally { h.cleanup(); }
});

test('duplicate removals count once; an unmatched member blocks the namespace atomically', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'claude-haiku-5-5'] });
  try {
    assertApplied(await checkedApply(h, { opencode: ['claude-haiku-5-5'] }), { provider: 'opencode', added: 1 });
    const before = h.mutations.length;
    const valid = { provider: 'opencode-messages', id: 'claude-haiku-5-5', owner: 'opencode' };
    assertRefused(await checkedRemove(h, [{ ...valid, id: 'never-added' }, valid, valid], { method: 'removeSiblingModels' }));
    assert.equal(h.mutations.length, before, 'a mixed valid/invalid namespace cannot partially commit');
    assert.ok(h.document['llm-pi-ai'].providers['opencode-messages']);
    const outcome = await checkedRemove(h, [valid, valid], { method: 'removeSiblingModels' });
    assertApplied(outcome, { provider: 'opencode', removed: 1 });
    assert.equal(h.mutations.length, before + 1);
    assert.equal(h.state.data.lastRemove.removed[0].removed, 1);
  } finally { h.cleanup(); }
});

test('a user-created provider is protected even if its name matches a builtin sibling', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const providers = h.document['llm-pi-ai'].providers;
    providers['opencode-messages'] = { displayName: 'User-owned route', models: [{ id: 'my-private-model', name: 'My Private Model' }] };
    const before = structuredClone(providers['opencode-messages']);
    assertRefused(await checkedRemove(h, [{ provider: 'opencode-messages', id: 'my-private-model', owner: 'opencode' }]));
    assert.deepEqual(providers['opencode-messages'], before);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
    assert.deepEqual(h.state.knownSiblings('opencode'), [], 'listing/refusing a user route never grants ownership');
    const visible = h.controller.managedSiblings().find((row) => row.provider === 'opencode-messages');
    assert.deepEqual(visible.models, [{ id: 'my-private-model', name: 'My Private Model' }], 'flat inventory is display metadata, not deletion authority');
    h.state.rememberSiblings('opencode', ['opencode-messages']); // Positive fixture: an exclusively plugin-owned route.
    const expectedRevisions = await checkedRevisions(h);
    const row = h.controller.managedSiblings().find((item) => item.provider === 'opencode-messages');
    assert.equal(row.owner, 'opencode');
    assert.equal(row.settingsRevision, expectedRevisions.opencode);
    const outcome = await h.controller.removeSiblingModels([{ provider: row.provider, owner: row.owner, id: 'my-private-model' }], { expectedRevisions });
    assertApplied(outcome, { provider: 'opencode', removed: 1 });
    assert.equal(providers['opencode-messages'], undefined);
  } finally { h.cleanup(); }
});

test('mixed removal unsets only a drained owned sibling and preserves whole remaining model rows', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    h.state.rememberSiblings('opencode-go', ['opencode-go-messages', 'opencode-go-responses']);
    const providers = h.document['llm-pi-ai'].providers;
    const keep = { id: 'minimax-m3', name: 'Manual MiniMax', contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'] };
    providers['opencode-go-messages'] = { displayName: 'Manual label', api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen/go', apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [keep, { id: 'hy4-preview', name: 'HY4 Preview' }] };
    providers['opencode-go-responses'] = { api: 'openai-responses', baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }] };
    const original = structuredClone(providers['opencode-go-messages']);
    const outcome = await checkedRemove(h, [
      { provider: 'opencode-go-messages', id: 'hy4-preview', owner: 'opencode-go' },
      { provider: 'opencode-go-responses', id: 'gpt-5.6-luna', owner: 'opencode-go' },
    ], { method: 'removeSiblingModels' });
    assertApplied(outcome, { provider: 'opencode-go', removed: 2 });
    assert.equal(h.mutations.length, 1);
    assert.deepEqual(h.mutations[0].ops, [
      { op: 'set', path: ['providers', 'opencode-go-messages', 'models'], value: [keep] },
      { op: 'unset', path: ['providers', 'opencode-go-responses'] },
    ]);
    assert.deepEqual(providers['opencode-go-messages'], { ...original, models: [keep] });
    assert.equal(providers['opencode-go-responses'], undefined);
  } finally { h.cleanup(); }
});

test('a drained owned sibling is recreated with its protocol and credential reference', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'claude-haiku-5-5'] });
  try {
    assertApplied(await checkedApply(h, { opencode: ['claude-haiku-5-5'] }), { provider: 'opencode', added: 1 });
    assertApplied(await checkedRemove(h, [{ provider: 'opencode-messages', id: 'claude-haiku-5-5', owner: 'opencode' }]), { provider: 'opencode', removed: 1 });
    assert.equal(h.document['llm-pi-ai'].providers['opencode-messages'], undefined);
    assertApplied(await checkedApply(h, { opencode: ['claude-haiku-5-5'] }), { provider: 'opencode', added: 1 });
    const sibling = h.document['llm-pi-ai'].providers['opencode-messages'];
    assert.equal(sibling.api, 'anthropic-messages');
    assert.equal(sibling.baseURL, 'https://opencode.ai/zen');
    assert.equal(sibling.apiKeyEnv, 'OPENCODE_API_KEY');
    assert.deepEqual(sibling.models.map((model) => model.id), ['claude-haiku-5-5']);
    assert.equal(h.mutations.length, 3);
  } finally { h.cleanup(); }
});

test('repairs never leave a sibling with an empty models list', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    h.state.rememberSiblings('opencode-go', ['opencode-go-messages']);
    const providers = h.document['llm-pi-ai'].providers;
    providers['opencode-go-messages'] = { api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen/go', apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }] };
    const outcome = await checkedApply(h, {}, { repairs: true });
    assert.deepEqual(outcome.errors, []);
    assert.equal(h.mutations.length, 1);
    assert.equal(providers['opencode-go-messages'], undefined);
    assert.deepEqual(providers['opencode-go-responses'].models.map((model) => model.id), ['gpt-5.6-luna']);
    assert.equal(providers['opencode-go-responses'].api, 'openai-responses');
    const ops = h.mutations[0].ops;
    assert.equal(ops.filter((op) => op.op === 'unset' && op.path[1] === 'opencode-go-messages').length, 1, 'a drained route is unset exactly once');
    assert.equal(ops.some((op) => op.path.length > 2 && op.path[1] === 'opencode-go-messages'), false, 'no orphan child operation recreates the drained route');
  } finally { h.cleanup(); }
});

test('repairs never drain the main route below one model', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const providers = h.document['llm-pi-ai'].providers;
    providers['opencode-go'].models = [{ id: 'minimax-m3', name: 'MiniMax M3' }];
    const outcome = await checkedApply(h, {}, { repairs: true });
    assert.deepEqual(outcome.errors, []);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
    assert.deepEqual(providers['opencode-go'].models.map((model) => model.id), ['minimax-m3']);
  } finally { h.cleanup(); }
});

test('explicit false selection habits persist; an explicit addition can remember true', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    assert.deepEqual(h.controller.status().selectionHabits, {});
    h.controller.setSelectionHabit('opencode-go', true);
    assert.equal(h.controller.status().selectionHabits['opencode-go'], true);
    h.controller.setSelectionHabit('opencode-go', false);
    assert.equal(h.controller.status().selectionHabits['opencode-go'], false);
    assert.equal(new SyncState(h.state.dir).selectionHabit('opencode-go'), false);
    assert.equal((await h.controller.check()).results.find((row) => row.provider === 'opencode-go').defaultSelected, false);
    assertApplied(await checkedApply(h, { 'opencode-go': ['deepseek-flash'] }), { provider: 'opencode-go', added: 1 });
    assert.equal(h.controller.status().selectionHabits['opencode-go'], true);
    assert.equal(h.controller.status().selectionHabits['deepseek-official'], undefined);
    assert.equal(new SyncState(h.state.dir).selectionHabit('opencode-go'), true);
  } finally { h.cleanup(); }
});

test('check exposes full added/available catalog state without modifying enabled models', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'mimo-v2.6-flash-free', 'claude-haiku-5-5'] });
  try {
    const before = structuredClone(h.document);
    const payload = await h.controller.check();
    const go = payload.results.find((row) => row.provider === 'opencode-go');
    assert.ok(go.allItems.some((item) => item.id === 'kimi-k3' && item.status === 'added' && item.removable === true));
    assert.ok(go.allItems.some((item) => item.id === 'deepseek-flash' && item.status === 'available' && item.removable === false));
    const opencode = payload.results.find((row) => row.provider === 'opencode');
    assert.ok(opencode.allItems.some((item) => item.id === 'claude-opus-5-5' && item.status === 'added' && item.removable === true));
    assert.ok(opencode.allItems.some((item) => item.id === 'claude-haiku-5-5' && item.status === 'available'));
    assert.deepEqual(h.document, before);
    assert.equal(h.mutations.length, 0);
  } finally { h.cleanup(); }
});

test('added models can be removed, but the last primary model and provider cannot be cleared', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    assertApplied(await checkedApply(h, { 'opencode-go': ['deepseek-flash'] }), { provider: 'opencode-go', added: 1 });
    const go = (await h.controller.check()).results.find((row) => row.provider === 'opencode-go');
    assert.ok(go.allItems.some((item) => item.id === 'deepseek-flash' && item.added && item.removable));
    assertApplied(await checkedRemove(h, [{ provider: 'opencode-go', id: 'deepseek-flash' }]), { provider: 'opencode-go', removed: 1 });
    const before = structuredClone(h.document);
    const writes = h.mutations.length;
    const backups = h.prepareCalls;
    assertRefused(await checkedRemove(h, [{ provider: 'opencode-go', id: 'kimi-k3' }]));
    assertRefused(await checkedRemove(h, [{ provider: 'deepseek-official', id: 'deepseek-v4-pro' }]));
    assert.equal(h.mutations.length, writes);
    assert.equal(h.prepareCalls, backups);
    assert.deepEqual(h.document, before);
  } finally { h.cleanup(); }
});

test('owned sibling removal carries its explicit owner and observed revision', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'mimo-v2.6-flash-free', 'claude-haiku-5-5'] });
  try {
    assertApplied(await checkedApply(h, { opencode: ['claude-haiku-5-5'] }), { provider: 'opencode', added: 1 });
    const expectedRevisions = await checkedRevisions(h);
    const sibling = h.controller.managedSiblings().find((row) => row.provider === 'opencode-messages');
    assert.equal(sibling.owner, 'opencode');
    assert.equal(sibling.settingsRevision, expectedRevisions.opencode);
    const before = h.mutations.length;
    await assert.rejects(() => h.controller.removeManagedModels([{ provider: sibling.provider, owner: 'does-not-exist', id: 'claude-haiku-5-5' }], { expectedRevisions, recheck: false }));
    assert.equal(h.mutations.length, before);
    assertApplied(await h.controller.removeManagedModels([{ provider: sibling.provider, owner: sibling.owner, id: 'claude-haiku-5-5' }], { expectedRevisions, recheck: false }), { provider: 'opencode', removed: 1 });
    assert.equal(h.document['llm-pi-ai'].providers['opencode-messages'], undefined);
  } finally { h.cleanup(); }
});

test('apply uses the explicitly checked snapshot and recheck=false performs no new discovery', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const expectedRevisions = await checkedRevisions(h);
    const beforeAt = h.state.data.lastCheck.at;
    const requests = h.requests.length;
    const outcome = await h.controller.applySelection({ 'opencode-go': ['deepseek-flash'] }, { expectedRevisions, recheck: false });
    assertApplied(outcome, { provider: 'opencode-go', added: 1 });
    assert.equal(h.requests.length, requests);
    assert.equal(h.state.data.lastCheck.at, beforeAt);
    assert.ok(h.document['llm-pi-ai'].providers['opencode-go'].models.some((model) => model.id === 'deepseek-flash'));
    assert.equal(h.state.data.selectionHabits['opencode-go'], true);
    assert.ok(h.state.data.ownedModels['opencode-go'].includes('deepseek-flash'));
    assert.equal(h.controller.status().lastCheck.results.find((row) => row.provider === 'opencode-go').status, 'needs-check');
  } finally { h.cleanup(); }
});

test('markOpened does not acknowledge; exact rendered catalog revisions control unread changes', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const first = (await h.controller.check()).results.find((row) => row.provider === 'opencode-go').catalog;
    assert.equal(first.changedCount, 0);
    assert.equal(first.firstDiscovery, true);
    assert.deepEqual(h.controller.markOpened(), { acknowledged: false });
    assert.equal(h.controller.status().lastCheck.results.find((row) => row.provider === 'opencode-go').catalog.firstDiscovery, true);
    assert.equal((await h.controller.markViewed('opencode-go', first.revision)).acknowledged, true);
    h.catalogs.go.push('new-chat-one');
    const second = (await h.controller.check()).results.find((row) => row.provider === 'opencode-go').catalog;
    assert.deepEqual(second.addedIds, ['new-chat-one']);
    assert.equal(second.changedCount, 1);
    assert.deepEqual(h.controller.markOpened(), { acknowledged: false });
    assert.equal(h.controller.status().lastCheck.results.find((row) => row.provider === 'opencode-go').catalog.changedCount, 1);
    assertApplied(await checkedApply(h, { 'opencode-go': ['deepseek-flash'] }), { provider: 'opencode-go', added: 1 });
    const afterSave = h.controller.status().lastCheck.results.find((row) => row.provider === 'opencode-go').catalog;
    assert.equal(afterSave.revision, second.revision, 'enabling a model is not upstream catalog change');
    assert.equal(afterSave.changedAt, second.changedAt);
    assert.deepEqual(afterSave.addedIds, ['new-chat-one']);
    h.catalogs.go.push('new-chat-two');
    await h.controller.check();
    const late = await h.controller.markViewed('opencode-go', second.revision);
    assert.equal(late.acknowledged, true);
    assert.deepEqual(late.catalog.addedIds, ['new-chat-two'], 'late acknowledgement cannot hide a newer arrival');
    assert.equal((await h.controller.markViewed('opencode-go', first.revision)).acknowledged, false);
    assert.deepEqual(h.controller.status().lastCheck.results.find((row) => row.provider === 'opencode-go').catalog.addedIds, ['new-chat-two']);
    assert.equal(h.mutations.length, 1, 'viewing/opening never saves model configuration');
  } finally { h.cleanup(); }
});

test('unchecked and expired saves refuse without implicit upstream checks or configuration writes', async (t) => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    assertRefused(await h.controller.applySelection({ 'opencode-go': ['deepseek-flash'] }, { expectedRevisions: { 'opencode-go': 1 }, recheck: false }));
    assert.equal(h.requests.length, 0, 'a save must not silently perform the missing explicit check');
    const expectedRevisions = await checkedRevisions(h);
    const requests = h.requests.length;
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 300001);
    assertRefused(await h.controller.applySelection({ 'opencode-go': ['deepseek-flash'] }, { expectedRevisions, recheck: false }));
    assert.equal(h.requests.length, requests);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
  } finally { h.cleanup(); }
});

test('a stale settings revision cannot overwrite an external manual change', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const expectedRevisions = await checkedRevisions(h);
    h.document['llm-pi-ai'].providers['opencode-go'].models.push({ id: 'external-manual-model', name: 'Keep this whole row' });
    h.revisions['llm-pi-ai'] += 1;
    const before = structuredClone(h.document);
    const requests = h.requests.length;
    assertRefused(await h.controller.applySelection({ 'opencode-go': ['deepseek-flash'] }, { expectedRevisions, recheck: false }));
    assert.deepEqual(h.document, before);
    assert.equal(h.requests.length, requests);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
  } finally { h.cleanup(); }
});

test('catalog removals are notification metadata and never delete local enabled entries', async () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const first = (await h.controller.check()).results.find((row) => row.provider === 'opencode-go');
    assert.equal((await h.controller.markViewed('opencode-go', first.catalog.revision)).acknowledged, true);
    const before = structuredClone(h.document);
    h.catalogs.go = FULL_LIST.filter((id) => id !== 'kimi-k3');
    h.catalogs.deepseek = ['deepseek-v4-flash'];
    const rows = (await h.controller.check()).results;
    const go = rows.find((row) => row.provider === 'opencode-go');
    assert.deepEqual(go.catalog.removedIds, ['kimi-k3']);
    assert.equal(go.catalog.removedCount, 1);
    assert.ok(go.removed.some((item) => item.id === 'kimi-k3'));
    assert.ok(rows.find((row) => row.provider === 'deepseek-official').removed.some((item) => item.id === 'deepseek-v4-pro'));
    assert.deepEqual(h.document, before);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
  } finally { h.cleanup(); }
});

test('even an owned sibling cannot be unset when that would restore an inherited provider', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'claude-haiku-5-5'] });
  try {
    h.state.rememberSiblings('opencode', ['opencode-messages']);
    const inherited = { models: [{ id: 'claude-haiku-5-5', name: 'Inherited manual row' }] };
    h.document['llm-pi-ai'].providers['opencode-messages'] = structuredClone(inherited);
    const describe = h.settings.describe.bind(h.settings);
    h.settings.describe = (options) => describe(options).map((entry) => entry.ns === 'llm-pi-ai' ? { ...entry, base: { providers: { 'opencode-messages': structuredClone(inherited) } } } : entry);
    const before = structuredClone(h.document);
    assertRefused(await checkedRemove(h, [{ provider: 'opencode-messages', id: 'claude-haiku-5-5', owner: 'opencode' }]));
    assert.deepEqual(h.document, before);
    assert.equal(h.mutations.length, 0);
    assert.equal(h.prepareCalls, 0);
  } finally { h.cleanup(); }
});

test('kimi coding falls back to the public catalog only when its list endpoint is missing', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true, kimiStatus: 404,
    modelsDevExtra: {
      'kimi-code-plan-cn': { npm: '@ai-sdk/anthropic', models: {
        k3: { name: 'Kimi K3', limit: { context: 262144, output: 32768 }, modalities: { input: ['text', 'image'] } },
        'kimi-for-coding': { name: 'Kimi for Coding' },
      } },
      'kimi-code-plan-global': { npm: '@ai-sdk/anthropic', models: { k3: { name: 'Kimi K3 Global' }, 'k3-256k': {} } },
    },
  });
  try {
    const payload = await h.controller.check();
    const kimi = payload.results.find((row) => row.provider === 'kimi-coding');
    assert.equal(kimi.status, 'ok', kimi.reason);
    assert.equal(kimi.source, 'models-dev');
    assert.equal(kimi.base, 'https://models.dev/api.json');
    assert.match(kimi.notice, /models\.dev/);
    assert.deepEqual(kimi.newItems.map((item) => item.id).sort(), ['k3', 'k3-256k', 'kimi-for-coding']);
    const k3 = kimi.newItems.find((item) => item.id === 'k3');
    assert.equal(k3.name, 'Kimi K3', 'the first regional catalog wins on duplicate ids');
    assert.equal(k3.api, 'anthropic-messages');
    const modelsDev = h.fetchCalls.find((call) => call.url === 'https://models.dev/api.json');
    assert.ok(modelsDev);
    assert.ok(!JSON.stringify(modelsDev.headers).includes('synthetic-test-credential'), 'the public catalog never receives the API key');
    assertApplied(await checkedApply(h, { 'kimi-coding': ['k3'] }), { provider: 'kimi-coding', added: 1 });
    const saved = h.document['llm-pi-ai'].providers['kimi-coding'].models.find((model) => model.id === 'k3');
    assert.equal(saved.name, 'Kimi K3');
    assert.equal(saved.contextWindow, 262144);
    assert.equal(saved.maxTokens, 32768);
    assert.deepEqual(saved.input, ['text', 'image']);
  } finally { h.cleanup(); }
});

test('kimi coding auth failures are not downgraded to a public catalog', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true, kimiStatus: 401,
    modelsDevExtra: { 'kimi-code-plan-cn': { npm: '@ai-sdk/anthropic', models: { k3: {} } } },
  });
  try {
    const payload = await h.controller.check();
    const kimi = payload.results.find((row) => row.provider === 'kimi-coding');
    assert.equal(kimi.status, 'discovery-failed');
    assert.equal(kimi.source, undefined);
    assert.equal(kimi.catalog, undefined, 'a failed discovery must not commit a fallback catalog');
    assert.match(kimi.reason ?? '', /401/);
  } finally { h.cleanup(); }
});

test('public-catalog scope ignores credential rotation but account scope still binds it', () => {
  const h = makeHarness({ modelList: FULL_LIST });
  try {
    const target = { configScope: 'scope-1' };
    const a = h.controller.scopeFor(target, { ref: 'KIMI_CODING_API_KEY', value: 'one' }, 'models-dev');
    const b = h.controller.scopeFor(target, { ref: 'KIMI_CODING_API_KEY', value: 'two' }, 'models-dev');
    const c = h.controller.scopeFor(target, { ref: 'KIMI_CODING_API_KEY', value: 'one' }, 'account-api');
    assert.equal(a, b, 'a public catalog does not depend on the secret');
    assert.notEqual(a, c);
    const z1 = h.controller.scopeFor(target, { ref: 'ZHIPU_API_KEY', value: 'one' }, 'official-schema');
    const z2 = h.controller.scopeFor(target, { ref: 'ZHIPU_API_KEY', value: 'two' }, 'official-schema');
    assert.equal(z1, z2, 'the Zhipu public schema does not depend on the secret either');
  } finally { h.cleanup(); }
});

test('a legacy addition extends the served catalog instead of replacing it', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true, openrouterList: ['x/one', 'y/two', 'z/three'],
    llmModels: { openrouter: [{ id: 'x/one', name: 'X One' }, { id: 'y/two', name: 'Y Two' }] },
  });
  try {
    const outcome = await checkedApply(h, { openrouter: ['z/three'] });
    assertApplied(outcome, { provider: 'openrouter', added: 1 });
    const profile = h.document['llm-pi-ai'].providers.openrouter;
    assert.deepEqual(profile.models.map((model) => model.id), ['x/one', 'y/two', 'z/three'],
      'the installed catalog rows must survive the write');
    assert.equal(profile.baseURL, undefined, 'materializing models must not materialize transport');
    assert.equal(profile.api, undefined);
    assert.equal(profile.apiKeyEnv, 'OPENROUTER_API_KEY');
  } finally { h.cleanup(); }
});

test('legacy modelOverrides migrate onto entries and clear the block', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true, openrouterList: ['x/one', 'y/two', 'z/three'],
    openrouterProfile: { modelOverrides: { 'x/one': { name: 'Manual X', maxTokens: 1234 } } },
    llmModels: { openrouter: [{ id: 'x/one', name: 'X One' }, { id: 'y/two' }] },
  });
  try {
    const outcome = await checkedApply(h, { openrouter: ['z/three'] });
    assertApplied(outcome, { provider: 'openrouter', added: 1 });
    const profile = h.document['llm-pi-ai'].providers.openrouter;
    assert.deepEqual(profile.modelOverrides, {}, 'a models list beside modelOverrides is refused by llm-pi-ai');
    const manual = profile.models.find((model) => model.id === 'x/one');
    assert.equal(manual.name, 'Manual X', 'manual fields are preserved, not dropped');
    assert.equal(manual.maxTokens, 1234);
    assert.deepEqual(profile.models.map((model) => model.id), ['x/one', 'y/two', 'z/three']);
  } finally { h.cleanup(); }
});

test('explicit models beside modelOverrides migrate instead of dropping manual fields', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true, openrouterList: ['x/one', 'y/two', 'z/three'],
    openrouterProfile: {
      models: [{ id: 'x/one', name: 'X One' }, { id: 'y/two', name: 'Y Two' }],
      modelOverrides: { 'x/one': { name: 'Manual X', maxTokens: 1234 } },
    },
  });
  try {
    const outcome = await checkedApply(h, { openrouter: ['z/three'] });
    assertApplied(outcome, { provider: 'openrouter', added: 1 });
    const profile = h.document['llm-pi-ai'].providers.openrouter;
    assert.deepEqual(profile.modelOverrides, {});
    assert.deepEqual(profile.models.map((model) => model.id), ['x/one', 'y/two', 'z/three']);
    assert.equal(profile.models[0].name, 'Manual X', 'override wins over the explicit row');
    assert.equal(profile.models[0].maxTokens, 1234);
  } finally { h.cleanup(); }
});

test('a sibling-only save never clears modelOverrides without rewriting models', async () => {
  const h = makeHarness({ modelList: FULL_LIST, opencodeList: ['claude-opus-5-5', 'mimo-v2.6-flash-free', 'qwen3.8-max'] });
  try {
    h.document['llm-pi-ai'].providers.opencode.modelOverrides = { 'claude-opus-5-5': { maxTokens: 999 } };
    const outcome = await checkedApply(h, { opencode: ['qwen3.8-max'] });
    assertApplied(outcome, { provider: 'opencode', added: 1 });
    const profile = h.document['llm-pi-ai'].providers.opencode;
    assert.deepEqual(profile.modelOverrides, { 'claude-opus-5-5': { maxTokens: 999 } }, 'clearing alone would drop the manual fields');
    assert.ok(h.mutations.every((mutation) => mutation.ops.every((op) => op.path[1] !== 'opencode')));
  } finally { h.cleanup(); }
});

test('a removal-only legacy save keeps manual override fields', async () => {
  const h = makeHarness({
    modelList: FULL_LIST, extraProviders: true, openrouterList: ['x/one', 'y/two'],
    openrouterProfile: {
      models: [{ id: 'x/one', name: 'X One' }, { id: 'y/two', name: 'Y Two' }],
      modelOverrides: { 'x/one': { name: 'Manual X', maxTokens: 1234 } },
    },
  });
  try {
    const outcome = await checkedApply(h, { openrouter: [] }, { removals: [{ provider: 'openrouter', id: 'y/two' }] });
    assertApplied(outcome, { provider: 'openrouter', removed: 1 });
    const profile = h.document['llm-pi-ai'].providers.openrouter;
    assert.deepEqual(profile.modelOverrides, {});
    assert.deepEqual(profile.models.map((model) => model.id), ['x/one']);
    assert.equal(profile.models[0].name, 'Manual X', 'manual fields survive a removal-only apply');
    assert.equal(profile.models[0].maxTokens, 1234);
  } finally { h.cleanup(); }
});

test('official modelOverrides migrate on save instead of refusing the user', async () => {
  const h = makeHarness({
    modelList: FULL_LIST,
    deepseekProfile: { modelOverrides: { 'deepseek-v4-pro': { maxTokens: 4321 } } },
  });
  try {
    const outcome = await checkedApply(h, { 'deepseek-official': ['deepseek-v4-flash'] });
    assertApplied(outcome, { provider: 'deepseek-official', added: 1 });
    const profile = h.document['llm-deepseek'];
    assert.deepEqual(profile.modelOverrides, {});
    assert.deepEqual(profile.models.map((model) => model.id), ['deepseek-v4-pro', 'deepseek-v4-flash']);
    assert.equal(profile.models[0].maxTokens, 4321);
  } finally { h.cleanup(); }
});


test('a check re-detects the machine proxy, and only when the switch is on', async (t) => {
  const harness = makeHarness({ modelList: ['kimi-k3'] });
  t.after(() => harness.cleanup());
  const calls = [];
  harness.controller.proxy = {
    disposed: false,
    apply: async (enabled, options) => { calls.push({ enabled, options }); return { enabled }; },
    status: () => ({ enabled: true, active: false }),
    dispose() {},
  };

  await harness.controller.check();
  assert.equal(calls.length, 1, 'an enabled switch reconciles on every check');
  assert.deepEqual(calls[0], { enabled: true, options: { force: true } });

  harness.state.setProxyEnabled(false);
  await harness.controller.check();
  assert.equal(calls.length, 1, 'a disabled switch must not probe or install anything');
});

test('a failing proxy re-detection never fails the check', async (t) => {
  const harness = makeHarness({ modelList: ['kimi-k3'] });
  t.after(() => harness.cleanup());
  harness.controller.proxy = {
    disposed: false,
    apply: async () => { throw new Error('scutil exploded'); },
    status: () => ({ enabled: true, active: false }),
    dispose() {},
  };
  const payload = await harness.controller.check();
  assert.ok(Array.isArray(payload.results) && payload.results.length > 0, 'discovery still runs');
});
