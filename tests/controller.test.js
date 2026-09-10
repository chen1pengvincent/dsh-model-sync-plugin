import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
    const tail = op.path[op.path.length - 1];
    if (op.op === 'unset') delete node[tail];
    else node[tail] = op.value;
  }
}

function makeHarness({ modelList, extraProviders = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'model-sync-test-'));
  const state = new SyncState(dir);
  const providers = {
    'opencode-go': { displayName: 'OpenCode Go', apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'kimi-k3', name: 'Kimi K3' }] },
  };
  if (extraProviders) {
    providers.openrouter = { displayName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY', models: [] };
    providers['kimi-coding'] = { displayName: 'Kimi Coding', apiKeyEnv: 'KIMI_CODING_API_KEY', models: [] };
  }
  const document = {
    'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
    'llm-pi-ai': { providers },
  };
  const mutations = [];
  const settings = {
    get: (ns) => structuredClone(document[ns]),
    mutate: async (ns, ops) => {
      if (document[ns] === undefined) throw new Error(`settings namespace "${ns}" is not registered`);
      mutations.push({ ns, ops });
      applyOps(document[ns], ops);
    },
  };
  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }) };
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://models.dev/api.json') {
      return {
        ok: true,
        json: async () => ({
          deepseek: { npm: '@ai-sdk/openai-compatible', models: { 'deepseek-flash': { attachment: true, limit: { context: 1000000 } } } },
          'opencode-go': {
            npm: '@ai-sdk/openai-compatible',
            models: {
              'minimax-m3': { provider: { npm: '@ai-sdk/anthropic' } },
              'gpt-5.6-luna': { provider: { npm: '@ai-sdk/openai' } },
            },
          },
        }),
      };
    }
    if (String(url).startsWith('https://api.deepseek.com/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }) };
    }
    if (String(url).startsWith('https://opencode.ai/zen/go/v1/models')) {
      return { ok: true, json: async () => ({ data: modelList.map((id) => ({ id })) }) };
    }
    if (String(url).startsWith('https://openrouter.ai/api/v1/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'x/one' }, { id: 'y/two' }] }) };
    }
    if (String(url).startsWith('https://api.kimi.com/coding/v1/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'k3' }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const controller = new SyncController({ ctx, state, logger: { info() {}, warn() {}, error() {} } });
  return {
    controller,
    state,
    document,
    mutations,
    cleanup() {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const FULL_LIST = ['kimi-k3', 'deepseek-flash', 'minimax-m3', 'gpt-5.6-luna'];

test('check is read-only and lists new models with placement', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    const payload = await harness.controller.check();
    assert.equal(harness.mutations.length, 0, 'check must never write');
    const go = payload.results.find((result) => result.provider === 'opencode-go');
    assert.deepEqual(go.newItems.map((item) => [item.id, item.target]), [
      ['deepseek-flash', 'opencode-go'],
      ['minimax-m3', 'opencode-go-messages'],
      ['gpt-5.6-luna', 'opencode-go-responses'],
    ]);
    const ds = payload.results.find((result) => result.provider === 'deepseek-official');
    assert.deepEqual(ds.newItems.map((item) => item.id), ['deepseek-flash']);
    assert.deepEqual(harness.state.data.lastCheck.results.find((r) => r.provider === 'opencode-go').newItems[0].entry, undefined, 'entries are stripped from state');
  } finally {
    harness.cleanup();
  }
});

test('openrouter lists but preselects nothing; kimi is preselected; managed toggle works', async () => {
  const harness = makeHarness({ modelList: FULL_LIST, extraProviders: true });
  try {
    const payload = await harness.controller.check();
    const openrouter = payload.results.find((result) => result.provider === 'openrouter');
    assert.equal(openrouter.status, 'ok');
    assert.equal(openrouter.defaultSelected, false);
    assert.equal(openrouter.newItems.length, 2);
    const kimi = payload.results.find((result) => result.provider === 'kimi-coding');
    assert.equal(kimi.status, 'ok');
    assert.equal(kimi.defaultSelected, true);
    assert.deepEqual(kimi.newItems.map((item) => item.id), ['k3']);
    assert.equal(harness.controller.status().managed.openrouter, true);

    harness.controller.setManaged('openrouter', false);
    const after = await harness.controller.check();
    assert.equal(after.results.find((result) => result.provider === 'openrouter').status, 'unmanaged');
    assert.equal(harness.controller.status().managed.openrouter, false);

    harness.controller.setManaged('openrouter', true);
    await harness.controller.applySelection({ openrouter: ['x/one'] });
    const profile = harness.document['llm-pi-ai'].providers.openrouter;
    assert.deepEqual(profile.models.map((model) => model.id), ['x/one']);
    assert.equal(profile.baseURL, 'https://openrouter.ai/api/v1');
    assert.equal(profile.api, undefined, 'single-protocol routes do not need a forced api');
  } finally {
    harness.cleanup();
  }
});

test('applySelection appends only selected ids and creates protocol siblings', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    const outcome = await harness.controller.applySelection({ 'opencode-go': ['deepseek-flash', 'minimax-m3', 'gpt-5.6-luna'] });
    assert.deepEqual(outcome.errors, []);
    const providers = harness.document['llm-pi-ai'].providers;
    assert.deepEqual(providers['opencode-go'].models.map((model) => model.id), ['kimi-k3', 'deepseek-flash']);
    assert.equal(providers['opencode-go'].api, 'openai-completions');
    assert.deepEqual(providers['opencode-go-messages'].models.map((model) => model.id), ['minimax-m3']);
    assert.equal(providers['opencode-go-messages'].api, 'anthropic-messages');
    assert.deepEqual(providers['opencode-go-responses'].models.map((model) => model.id), ['gpt-5.6-luna']);
    assert.deepEqual(harness.state.knownSiblings('opencode-go').sort(), ['opencode-go-messages', 'opencode-go-responses']);

    const before = harness.mutations.length;
    const again = await harness.controller.applySelection({ 'opencode-go': ['deepseek-flash', 'minimax-m3', 'gpt-5.6-luna'] });
    assert.deepEqual(again.errors, []);
    assert.equal(harness.mutations.length, before, 're-adding is a no-op');
  } finally {
    harness.cleanup();
  }
});

test('deepseek additions never remove existing entries', async () => {
  const harness = makeHarness({ modelList: ['kimi-k3'] });
  try {
    await harness.controller.applySelection({ 'deepseek-official': ['deepseek-flash'] });
    assert.deepEqual(harness.document['llm-deepseek'].models.map((model) => model.id), ['deepseek-v4-pro', 'deepseek-flash']);
  } finally {
    harness.cleanup();
  }
});

test('startup auto-repairs v1 misplacements exactly once', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    harness.document['llm-pi-ai'].providers['opencode-go'].models.push({ id: 'minimax-m3', name: 'MiniMax M3' });
    await harness.controller.startup();
    const providers = harness.document['llm-pi-ai'].providers;
    assert.deepEqual(providers['opencode-go'].models.map((model) => model.id), ['kimi-k3']);
    assert.deepEqual(providers['opencode-go-messages'].models.map((model) => model.id), ['minimax-m3']);
    assert.ok(harness.state.data.repairedAt !== null);

    const before = harness.mutations.length;
    await harness.controller.startup();
    assert.equal(harness.mutations.length, before, 'second startup must not repair again');
  } finally {
    harness.cleanup();
  }
});

test('startup never auto-applies additions', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    await harness.controller.startup();
    assert.equal(harness.mutations.length, 0, 'new models are only listed, never auto-added');
    assert.deepEqual(harness.document['llm-pi-ai'].providers['opencode-go'].models.map((model) => model.id), ['kimi-k3']);
  } finally {
    harness.cleanup();
  }
});
