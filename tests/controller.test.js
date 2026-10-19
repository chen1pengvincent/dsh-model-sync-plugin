import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncController } from '../lib/sync.js';
import { SyncState } from '../lib/state.js';

async function settle(controller) {
  const deadline = Date.now() + 5000;
  while (controller.refreshing) {
    if (Date.now() > deadline) throw new Error('settle timeout: background refresh did not finish');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

function makeHarness({ modelList, opencodeList = ['claude-opus-5-5', 'mimo-v2.6-flash-free'], extraProviders = false, credentialDescription = { configured: true, source: 'file', writable: true }, settingsShape = 'get' }) {
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
    providers.openrouter = { displayName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY', models: [] };
    providers['kimi-coding'] = { displayName: 'Kimi Coding', apiKeyEnv: 'KIMI_CODING_API_KEY', models: [] };
  }
  const document = {
    'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
    'llm-pi-ai': { providers },
  };
  const mutations = [];
  const mutate = async (ns, ops) => {
    if (document[ns] === undefined) throw new Error(`settings namespace "${ns}" is not registered`);
    mutations.push({ ns, ops });
    applyOps(document[ns], ops);
  };
  const settings = settingsShape === 'describe'
    ? {
        // Entry-based SettingsForms (DSH Desktop 2.0.17+): no get(); reads go through describe().
        describe: () => Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value) })),
        mutate,
      }
    : { get: (ns) => structuredClone(document[ns]), mutate };
  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }), describe: async () => credentialDescription };
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
          opencode: {
            npm: '@ai-sdk/openai-compatible',
            models: {
              'qwen3.8-max': {},
              'claude-haiku-5-5': { provider: { npm: '@ai-sdk/anthropic' } },
              'gemini-4-argon': { provider: { npm: '@ai-sdk/google' } },
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
    if (String(url).startsWith('https://opencode.ai/zen/v1/models')) {
      return { ok: true, json: async () => ({ data: opencodeList.map((id) => ({ id })) }) };
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
    assert.equal(profile.api, 'openai-completions', 'route api is required for models the installed catalog does not describe');
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

test('env-shadowed credential surfaces a warning in check results and persisted state', async () => {
  const harness = makeHarness({
    modelList: FULL_LIST,
    credentialDescription: { configured: true, source: 'env', writable: false },
  });
  try {
    const payload = await harness.controller.check();
    const row = payload.results.find((result) => result.provider === 'opencode-go');
    assert.equal(row.credential.configured, true);
    assert.equal(row.credential.source, 'env');
    assert.equal(row.credential.shadowed, true);
    assert.match(row.credential.warning, /launchctl unsetenv OPENCODE_GO_API_KEY/);
    const persisted = harness.state.data.lastCheck.results.find((result) => result.provider === 'opencode-go');
    assert.equal(persisted.credential.shadowed, true, 'credential fact survives into the persisted display copy');
  } finally {
    harness.cleanup();
  }
});

test('writable file credential reports configured and not shadowed', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    const payload = await harness.controller.check();
    const row = payload.results.find((result) => result.provider === 'opencode-go');
    assert.equal(row.credential.configured, true);
    assert.equal(row.credential.shadowed, false);
    assert.equal(row.credential.warning, undefined);
  } finally {
    harness.cleanup();
  }
});

test('absent credentials describe leaves results without a credential fact', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  const realGet = harness.controller.ctx.get.bind(harness.controller.ctx);
  harness.controller.ctx.get = (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'test-key' }) } : realGet(name));
  try {
    const payload = await harness.controller.check();
    const row = payload.results.find((result) => result.provider === 'opencode-go');
    assert.equal(row.credential, undefined, 'older kernels without describe() are tolerated');
  } finally {
    harness.cleanup();
  }
});

test('reads settings through describe() on entry-based kernels (2.0.17+)', async () => {
  const harness = makeHarness({ modelList: FULL_LIST, settingsShape: 'describe' });
  try {
    const payload = await harness.controller.check();
    const byProvider = Object.fromEntries(payload.results.map((result) => [result.provider, result]));
    assert.equal(byProvider['opencode-go']?.status, 'ok', 'pi-ai route read through describe');
    assert.equal(byProvider['deepseek-official']?.status, 'ok', 'deepseek section read through describe');
    assert.equal(byProvider['opencode-go'].credential?.configured, true, 'credential facts still attach');
  } finally {
    harness.cleanup();
  }
});

test('opencode: candidates land on siblings and apply never touches the catalog row', async () => {
  const opencodeList = ['claude-opus-5-5', 'mimo-v2.6-flash-free', 'claude-haiku-5-5', 'qwen3.8-max', 'gemini-4-argon', 'claude-opus-5-5-backup'];
  const harness = makeHarness({ modelList: FULL_LIST, opencodeList });
  try {
    const payload = await harness.controller.check();
    const opencode = payload.results.find((result) => result.provider === 'opencode');
    assert.equal(opencode.status, 'ok');
    assert.equal(opencode.defaultSelected, false);
    assert.deepEqual(opencode.newItems.map((item) => [item.id, item.target]), [
      ['claude-haiku-5-5', 'opencode-messages'],
      ['qwen3.8-max', 'opencode-chat'],
      ['claude-opus-5-5-backup', 'opencode-messages'],
    ]);
    assert.deepEqual(opencode.skipped.map((entry) => entry.id), ['gemini-4-argon']);

    const outcome = await harness.controller.applySelection({ opencode: ['claude-haiku-5-5', 'qwen3.8-max'] });
    assert.deepEqual(outcome.errors, []);
    const providers = harness.document['llm-pi-ai'].providers;
    assert.deepEqual(providers.opencode.models.map((model) => model.id), ['claude-opus-5-5', 'mimo-v2.6-flash-free'], 'catalog row models are never rewritten');
    assert.equal(providers.opencode.api, undefined, 'no route-level api is written');
    assert.equal(providers.opencode.baseURL, undefined, 'no route-level baseURL is written');
    assert.ok(
      !harness.mutations.some((mutation) => mutation.ops.some((op) => op.path[0] === 'providers' && op.path[1] === 'opencode')),
      'no mutation touches the opencode catalog row',
    );
    assert.deepEqual(providers['opencode-messages'].models.map((model) => model.id), ['claude-haiku-5-5']);
    assert.equal(providers['opencode-messages'].api, 'anthropic-messages');
    assert.equal(providers['opencode-messages'].baseURL, 'https://opencode.ai/zen');
    assert.equal(providers['opencode-messages'].apiKeyEnv, 'OPENCODE_API_KEY');
    assert.deepEqual(providers['opencode-chat'].models.map((model) => model.id), ['qwen3.8-max']);
    assert.equal(providers['opencode-chat'].baseURL, 'https://opencode.ai/zen/v1');
    assert.deepEqual(harness.state.knownSiblings('opencode').sort(), ['opencode-chat', 'opencode-messages']);

    const before = harness.mutations.length;
    await harness.controller.applySelection({}, { repairs: true });
    assert.equal(harness.mutations.length, before, 'repair pass leaves everything alone');
  } finally {
    harness.cleanup();
  }
});

test('describe-shaped settings still apply additions through mutate', async () => {
  const harness = makeHarness({ modelList: FULL_LIST, settingsShape: 'describe' });
  try {
    const outcome = await harness.controller.applySelection({ 'opencode-go': ['minimax-m3'] });
    assert.deepEqual(outcome.errors, []);
    const providers = harness.document['llm-pi-ai'].providers;
    assert.ok(providers['opencode-go-messages']?.models.some((model) => model.id === 'minimax-m3'), 'sibling created via mutate');
  } finally {
    harness.cleanup();
  }
});

test('managedSiblings groups live sibling models by protocol and skips empties', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    harness.state.rememberSiblings('opencode', ['opencode-chat', 'opencode-messages', 'opencode-responses']);
    const providers = harness.document['llm-pi-ai'].providers;
    providers['opencode-messages'] = {
      displayName: 'OpenCode · Anthropic Messages',
      apiKeyEnv: 'OPENCODE_API_KEY',
      models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'] }],
    };
    providers['opencode-chat'] = { displayName: 'OpenCode · Chat Completions', models: [{ id: 'qwen3.8-max', input: ['text', 'audio'] }] };
    providers['opencode-responses'] = { displayName: 'OpenCode · Responses', models: [] };

    const payload = harness.controller.managedSiblings();
    assert.deepEqual(payload.routes.map((route) => route.provider), ['opencode'], 'routes without any sibling models are omitted');
    const route = payload.routes[0];
    assert.equal(route.displayName, 'OpenCode');
    assert.deepEqual(route.siblings.map((sibling) => [sibling.provider, sibling.protocol, sibling.label]), [
      ['opencode-chat', 'openai-completions', 'Chat Completions'],
      ['opencode-messages', 'anthropic-messages', 'Anthropic Messages'],
    ], 'empty sibling is omitted and protocol order is stable');
    assert.deepEqual(route.siblings[0].models, [{ id: 'qwen3.8-max', name: 'qwen3.8-max', input: ['text'] }], 'missing model names fall back to ids and unknown modalities are dropped');
    assert.equal(route.siblings[1].displayName, 'OpenCode · Anthropic Messages');
    assert.deepEqual(route.siblings[1].models, [
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'] },
    ], 'capacity and input fields travel to the managed panel');
  } finally {
    harness.cleanup();
  }
});

test('removeSiblingModel drops one model from a sibling and check offers it again', async () => {
  const opencodeList = ['claude-opus-5-5', 'claude-haiku-5-5'];
  const harness = makeHarness({ modelList: FULL_LIST, opencodeList });
  try {
    await harness.controller.applySelection({ opencode: ['claude-haiku-5-5'] });
    const providers = harness.document['llm-pi-ai'].providers;
    assert.deepEqual(providers['opencode-messages'].models.map((model) => model.id), ['claude-haiku-5-5']);

    const outcome = await harness.controller.removeSiblingModel('opencode-messages', 'claude-haiku-5-5');
    assert.deepEqual(outcome, { removed: true, remaining: 0 });
    assert.equal(providers['opencode-messages'], undefined, 'a drained sibling is dropped entirely, never left with an empty models list');
    assert.deepEqual(providers.opencode.models.map((model) => model.id), ['claude-opus-5-5', 'mimo-v2.6-flash-free'], 'catalog row is never touched');
    assert.equal(harness.state.data.lastRemove.provider, 'opencode-messages');
    assert.equal(harness.state.data.lastRemove.modelId, 'claude-haiku-5-5');
    const last = harness.mutations.at(-1);
    assert.deepEqual(last.ops, [{ op: 'unset', path: ['providers', 'opencode-messages'] }]);

    const payload = await harness.controller.check();
    const opencode = payload.results.find((result) => result.provider === 'opencode');
    assert.ok(
      opencode.newItems.some((item) => item.id === 'claude-haiku-5-5' && item.target === 'opencode-messages'),
      'removed model is offered again by check',
    );
    assert.deepEqual(harness.controller.managedSiblings().routes, [], 'empty siblings vanish from the managed panel');
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('removeSiblingModel rejects non-sibling providers and unknown models are read-only no-ops', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    harness.state.rememberSiblings('opencode', ['opencode-chat', 'opencode-messages']);
    await assert.rejects(() => harness.controller.removeSiblingModel('opencode', 'claude-opus-5-5'), /不是插件托管的协议分流路由/);
    await assert.rejects(() => harness.controller.removeSiblingModel('openrouter', 'x/one'), /不是插件托管的协议分流路由/);
    await assert.rejects(() => harness.controller.removeSiblingModel('opencode-messages', ''), /有效字符串/);
    await assert.rejects(() => harness.controller.removeSiblingModel('opencode-messages', 'x'.repeat(201)), /有效字符串/);
    await assert.rejects(() => harness.controller.removeSiblingModels([]), /非空数组/);
    await assert.rejects(() => harness.controller.removeSiblingModels(Array.from({ length: 101 }, () => ({ provider: 'opencode-messages', modelId: 'x' }))), /最多删除 100 个模型/);
    await assert.rejects(
      () => harness.controller.removeSiblingModels([{ provider: 'opencode-messages', modelId: 'ok' }, { provider: 'opencode', modelId: 'nope' }]),
      /不是插件托管的协议分流路由/,
    );
    await assert.rejects(
      () => harness.controller.removeSiblingModels([{ provider: 'opencode-messages', modelId: 'ok' }, { provider: 'openrouter', modelId: 'x/one' }]),
      /不是插件托管的协议分流路由/,
    );

    const providers = harness.document['llm-pi-ai'].providers;
    providers['opencode-messages'] = { models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }] };
    const before = harness.mutations.length;
    const outcome = await harness.controller.removeSiblingModel('opencode-messages', 'nope');
    assert.deepEqual(outcome, { removed: false, remaining: 1 });
    assert.equal(harness.mutations.length, before, 'unknown model never writes');
    assert.equal(harness.state.data.lastRemove, null);
    assert.equal(harness.state.data.lastCheck, null, 'no-op remove does not schedule a background refresh');
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('removeSiblingModels deletes across sibling routes with a single settings write', async () => {
  const opencodeList = ['claude-opus-5-5', 'claude-haiku-5-5', 'qwen3.8-max'];
  const harness = makeHarness({ modelList: FULL_LIST, opencodeList });
  try {
    await harness.controller.applySelection({ opencode: ['claude-haiku-5-5', 'qwen3.8-max'] });
    const providers = harness.document['llm-pi-ai'].providers;
    assert.deepEqual(providers['opencode-messages'].models.map((model) => model.id), ['claude-haiku-5-5']);
    assert.deepEqual(providers['opencode-chat'].models.map((model) => model.id), ['qwen3.8-max']);

    const before = harness.mutations.length;
    const outcome = await harness.controller.removeSiblingModels([
      { provider: 'opencode-messages', modelId: 'claude-haiku-5-5' },
      { provider: 'opencode-chat', modelId: 'qwen3.8-max' },
    ]);
    assert.equal(harness.mutations.length, before + 1, 'one mutate call for the whole batch');
    assert.equal(outcome.removed, 2);
    assert.deepEqual(outcome.results, [
      { provider: 'opencode-messages', modelId: 'claude-haiku-5-5', removed: true, remaining: 0 },
      { provider: 'opencode-chat', modelId: 'qwen3.8-max', removed: true, remaining: 0 },
    ]);
    assert.deepEqual(harness.mutations.at(-1).ops, [
      { op: 'unset', path: ['providers', 'opencode-messages'] },
      { op: 'unset', path: ['providers', 'opencode-chat'] },
    ]);
    assert.equal(providers['opencode-messages'], undefined);
    assert.equal(providers['opencode-chat'], undefined);
    assert.equal(harness.state.data.lastRemove.provider, 'opencode-messages');
    assert.equal(harness.state.data.lastRemove.modelId, 'claude-haiku-5-5');
    assert.deepEqual(harness.state.data.lastRemove.items, [
      { provider: 'opencode-messages', modelId: 'claude-haiku-5-5', removed: true },
      { provider: 'opencode-chat', modelId: 'qwen3.8-max', removed: true },
    ]);
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('removeSiblingModels leaves settings, state and backups alone when nothing matches', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    harness.state.rememberSiblings('opencode', ['opencode-messages']);
    const providers = harness.document['llm-pi-ai'].providers;
    providers['opencode-messages'] = { models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }] };
    let backups = 0;
    const backup = harness.controller.backupSettings.bind(harness.controller);
    harness.controller.backupSettings = () => {
      backups += 1;
      return backup();
    };

    const before = harness.mutations.length;
    const outcome = await harness.controller.removeSiblingModels([
      { provider: 'opencode-messages', modelId: 'nope' },
      { provider: 'opencode-messages', modelId: 'nope' },
    ]);
    assert.deepEqual(outcome, {
      results: [{ provider: 'opencode-messages', modelId: 'nope', removed: false, remaining: 1 }],
      removed: 0,
    });
    assert.equal(harness.mutations.length, before, 'a fully unmatched batch never writes');
    assert.equal(backups, 0, 'nothing changed means no settings backup');
    assert.equal(harness.state.data.lastRemove, null);
    assert.deepEqual(providers['opencode-messages'].models.map((model) => model.id), ['claude-haiku-5-5']);
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('removeSiblingModels dedupes repeated entries and points lastRemove at a removed model on partial hits', async () => {
  const opencodeList = ['claude-opus-5-5', 'claude-haiku-5-5'];
  const harness = makeHarness({ modelList: FULL_LIST, opencodeList });
  try {
    await harness.controller.applySelection({ opencode: ['claude-haiku-5-5'] });
    const before = harness.mutations.length;
    const outcome = await harness.controller.removeSiblingModels([
      { provider: 'opencode-messages', modelId: 'never-added' },
      { provider: 'opencode-messages', modelId: 'claude-haiku-5-5' },
      { provider: 'opencode-messages', modelId: 'claude-haiku-5-5' },
    ]);
    assert.equal(harness.mutations.length, before + 1, 'one mutate for the deduped batch');
    assert.equal(outcome.removed, 1, 'duplicates never inflate the count');
    assert.deepEqual(outcome.results, [
      { provider: 'opencode-messages', modelId: 'never-added', removed: false, remaining: 0 },
      { provider: 'opencode-messages', modelId: 'claude-haiku-5-5', removed: true, remaining: 0 },
    ]);
    assert.equal(harness.state.data.lastRemove.provider, 'opencode-messages');
    assert.equal(harness.state.data.lastRemove.modelId, 'claude-haiku-5-5', 'legacy lastRemove fields point at the first removed model, not the first requested one');
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('removeSiblingModels refuses user-created providers that merely share a builtin sibling name', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    const providers = harness.document['llm-pi-ai'].providers;
    providers['opencode-messages'] = {
      displayName: 'OpenCode · Anthropic Messages',
      models: [{ id: 'my-private-model', name: 'My Private Model' }],
    };
    await assert.rejects(
      () => harness.controller.removeSiblingModel('opencode-messages', 'my-private-model'),
      /用户自建的 provider/,
    );
    assert.deepEqual(harness.controller.managedSiblings().routes, [], 'unregistered sibling never shows up in the managed panel');
    assert.deepEqual(providers['opencode-messages'].models.map((model) => model.id), ['my-private-model']);

    harness.state.rememberSiblings('opencode', ['opencode-messages']);
    const listed = harness.controller.managedSiblings().routes;
    assert.deepEqual(listed.map((route) => [route.provider, route.siblings.map((sibling) => sibling.provider)]), [
      ['opencode', ['opencode-messages']],
    ], 'once the plugin registers the sibling it is manageable again');
    const outcome = await harness.controller.removeSiblingModel('opencode-messages', 'my-private-model');
    assert.deepEqual(outcome, { removed: true, remaining: 0 });
    assert.equal(providers['opencode-messages'], undefined, 'draining drops the plugin-created entry');
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('mixed batch: a drained sibling is unset while a partially drained one keeps the rest', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    harness.state.rememberSiblings('opencode-go', ['opencode-go-messages', 'opencode-go-responses']);
    const providers = harness.document['llm-pi-ai'].providers;
    providers['opencode-go-messages'] = {
      displayName: 'OpenCode Go · Anthropic Messages',
      api: 'anthropic-messages',
      baseURL: 'https://opencode.ai/zen/go',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      models: [{ id: 'minimax-m3', name: 'MiniMax M3' }, { id: 'hy4-preview', name: 'HY4 Preview' }],
    };
    providers['opencode-go-responses'] = {
      displayName: 'OpenCode Go · Responses',
      api: 'openai-responses',
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
    };
    const before = harness.mutations.length;
    const outcome = await harness.controller.removeSiblingModels([
      { provider: 'opencode-go-messages', modelId: 'hy4-preview' },
      { provider: 'opencode-go-responses', modelId: 'gpt-5.6-luna' },
    ]);
    assert.equal(harness.mutations.length, before + 1, 'one mutate for the mixed batch');
    assert.deepEqual(harness.mutations.at(-1).ops, [
      { op: 'set', path: ['providers', 'opencode-go-messages', 'models'], value: [{ id: 'minimax-m3', name: 'MiniMax M3' }] },
      { op: 'unset', path: ['providers', 'opencode-go-responses'] },
    ]);
    assert.equal(outcome.removed, 2);
    assert.deepEqual(outcome.results, [
      { provider: 'opencode-go-messages', modelId: 'hy4-preview', removed: true, remaining: 1 },
      { provider: 'opencode-go-responses', modelId: 'gpt-5.6-luna', removed: true, remaining: 0 },
    ]);
    assert.equal(providers['opencode-go-responses'], undefined);
    assert.deepEqual(providers['opencode-go-messages'].models.map((model) => model.id), ['minimax-m3']);
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('a drained sibling is rebuilt from scratch when re-added', async () => {
  const opencodeList = ['claude-opus-5-5', 'claude-haiku-5-5'];
  const harness = makeHarness({ modelList: FULL_LIST, opencodeList });
  try {
    await harness.controller.applySelection({ opencode: ['claude-haiku-5-5'] });
    const providers = harness.document['llm-pi-ai'].providers;
    assert.equal(providers['opencode-messages'].api, 'anthropic-messages');

    await harness.controller.removeSiblingModel('opencode-messages', 'claude-haiku-5-5');
    assert.equal(providers['opencode-messages'], undefined, 'the drained sibling entry is gone');

    const again = await harness.controller.applySelection({ opencode: ['claude-haiku-5-5'] });
    assert.deepEqual(again.errors, []);
    assert.equal(providers['opencode-messages'].api, 'anthropic-messages', 're-add recreates the entry with its protocol');
    assert.equal(providers['opencode-messages'].baseURL, 'https://opencode.ai/zen');
    assert.equal(providers['opencode-messages'].apiKeyEnv, 'OPENCODE_API_KEY');
    assert.deepEqual(providers['opencode-messages'].models.map((model) => model.id), ['claude-haiku-5-5']);
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('repairs never leave a sibling with an empty models list', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    harness.state.rememberSiblings('opencode-go', ['opencode-go-messages']);
    const providers = harness.document['llm-pi-ai'].providers;
    providers['opencode-go-messages'] = {
      displayName: 'OpenCode Go · Anthropic Messages',
      api: 'anthropic-messages',
      baseURL: 'https://opencode.ai/zen/go',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
    };
    const outcome = await harness.controller.applySelection({}, { repairs: true });
    assert.deepEqual(outcome.errors, []);
    assert.equal(providers['opencode-go-messages'], undefined, 'a repair that drains a sibling unsets it instead of writing an empty list');
    assert.deepEqual(providers['opencode-go-responses'].models.map((model) => model.id), ['gpt-5.6-luna']);
    assert.equal(providers['opencode-go-responses'].api, 'openai-responses');
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});

test('repairs never drain the main route below one model', async () => {
  const harness = makeHarness({ modelList: FULL_LIST });
  try {
    const providers = harness.document['llm-pi-ai'].providers;
    providers['opencode-go'].models = [{ id: 'minimax-m3', name: 'MiniMax M3' }];
    const outcome = await harness.controller.applySelection({}, { repairs: true });
    assert.deepEqual(outcome.errors, []);
    assert.equal(harness.mutations.length, 0, 'a repair that would empty the main route is skipped');
    assert.deepEqual(providers['opencode-go'].models.map((model) => model.id), ['minimax-m3']);
  } finally {
    await settle(harness.controller);
    harness.cleanup();
  }
});
