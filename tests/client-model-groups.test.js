import { test } from 'node:test';
import assert from 'node:assert/strict';

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
};
await import('../lib/client.js?model-groups-test=1');

const client = loaded.factory((id) => {
  if (id === 'react') {
    return {
      createElement() {},
      useCallback() {},
      useEffect() {},
      useMemo() {},
      useRef() {},
      useState() {},
    };
  }
  throw new Error(`unexpected require: ${id}`);
});

const {
  mergeModelGroups,
  transformDirectorySnapshot,
  resolveModelSelection,
  createMergedDirectory,
} = client.__test;

function fixtureGroups() {
  return [
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      models: [{ id: 'primary' }, { id: 'shared', name: 'Shared Primary' }],
    },
    {
      id: 'opencode-go-responses',
      name: 'OpenCode Go · Responses',
      models: [{ id: 'resp', name: 'Response Model' }, { id: 'shared', name: 'Shared Sibling' }],
    },
    {
      id: 'opencode-go-chat',
      name: 'OpenCode Go · Chat Completions',
      models: [{ id: 'chat' }, { id: 'resp', name: 'Response Via Chat' }],
    },
    {
      id: 'opencode-go-messages',
      name: 'OpenCode Go · Anthropic Messages',
      models: [{ id: 'messages' }],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      models: [{ id: 'console' }],
    },
    {
      id: 'opencode-chat',
      name: 'OpenCode · Chat Completions',
      models: [{ id: 'console-chat' }],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [{ id: 'router-model' }],
    },
    {
      id: 'foo',
      name: 'Foo',
      models: [{ id: 'foo-primary' }],
    },
    {
      id: 'foo-chat',
      name: 'Foo · Chat',
      models: [{ id: 'foo-sibling' }],
    },
  ];
}

test('merges only built-in protocol siblings and keeps real providers independent', () => {
  const groups = fixtureGroups();
  const plan = mergeModelGroups(groups);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.groups.map((group) => group.id), ['opencode-go', 'opencode', 'openrouter', 'foo', 'foo-chat']);
  assert.deepEqual(plan.groups[0].models.map((model) => model.id), ['primary', 'shared', 'chat', 'resp', 'messages']);
  assert.deepEqual(plan.groups[1].models.map((model) => model.id), ['console', 'console-chat']);
  assert.deepEqual(plan.groups[2].models.map((model) => model.id), ['router-model']);
  assert.deepEqual(plan.groups[3].models.map((model) => model.id), ['foo-primary']);
  assert.deepEqual(plan.groups[4].models.map((model) => model.id), ['foo-sibling']);
  assert.equal(plan.primaryNames.get('opencode-go'), 'OpenCode Go');
});

test('deduplicates by model id, prefers the primary route, then protocol order', () => {
  const plan = mergeModelGroups(fixtureGroups());
  assert.equal(plan.modelRoutes.get('opencode-go\u0000chat'), 'opencode-go-chat');
  assert.equal(plan.modelRoutes.get('opencode-go\u0000messages'), 'opencode-go-messages');
  assert.equal(plan.modelRoutes.get('opencode-go\u0000resp'), 'opencode-go-chat');
  assert.equal(plan.modelRoutes.get('opencode-go\u0000shared'), undefined);
  assert.equal(plan.modelRoutes.get('opencode\u0000console-chat'), 'opencode-chat');
  assert.equal(plan.modelRoutes.get('foo\u0000foo-sibling'), undefined);
});

test('leaves unrelated groups untouched and returns the identical snapshot when nothing merges', () => {
  const groups = [
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'one' }] },
    { id: 'foo', name: 'Foo', models: [{ id: 'two' }] },
  ];
  const snapshot = { groups, current: { provider: 'openrouter', model: 'one' }, pending: null, failures: [] };
  const plan = mergeModelGroups(groups);
  assert.equal(plan.changed, false);
  assert.equal(plan.groups, groups);
  assert.equal(transformDirectorySnapshot(snapshot), snapshot);
  assert.deepEqual(resolveModelSelection(snapshot, { provider: 'openrouter', model: 'one' }), {
    provider: 'openrouter',
    model: 'one',
  });
});

test('remaps current, pending, default, and failures to the provider group', () => {
  const snapshot = {
    groups: fixtureGroups(),
    current: { provider: 'opencode-go-responses', model: 'resp' },
    pending: { provider: 'opencode-go-chat', model: 'chat' },
    default: { provider: 'opencode-go-messages', model: 'messages' },
    failures: [
      { id: 'opencode-go-responses', name: 'OpenCode Go · Responses', message: 'sibling failed' },
      { id: 'openrouter', name: 'OpenRouter', message: 'real provider failed' },
    ],
    retainedEffort: 'high',
    routable: true,
  };
  const transformed = transformDirectorySnapshot(snapshot);
  assert.equal(transformed.current.provider, 'opencode-go');
  assert.equal(transformed.current.model, 'resp');
  assert.equal(transformed.pending.provider, 'opencode-go');
  assert.equal(transformed.default.provider, 'opencode-go');
  assert.deepEqual(transformed.failures.map((failure) => failure.id), ['opencode-go', 'openrouter']);
  assert.equal(transformed.failures[0].name, 'OpenCode Go');
  assert.equal(transformed.failures[0].message, 'sibling failed');
  assert.equal(transformed.retainedEffort, 'high');
  assert.equal(transformed.routable, true);
});

test('resolves a visible primary selection back to the sibling route', () => {
  const snapshot = { groups: fixtureGroups() };
  assert.deepEqual(resolveModelSelection(snapshot, { provider: 'opencode-go', model: 'chat' }), {
    provider: 'opencode-go-chat',
    model: 'chat',
  });
  assert.deepEqual(resolveModelSelection(snapshot, { provider: 'opencode-go', model: 'shared' }), {
    provider: 'opencode-go',
    model: 'shared',
  });
  assert.deepEqual(resolveModelSelection(snapshot, { provider: 'openrouter', model: 'router-model' }), {
    provider: 'openrouter',
    model: 'router-model',
  });
});

test('merged directory store updates, load, and select stay transparent', async () => {
  let source = {
    groups: fixtureGroups(),
    current: { provider: 'opencode-go', model: 'shared' },
    pending: null,
    failures: [],
  };
  const sourceListeners = new Set();
  let selected;
  const original = {
    store: {
      getSnapshot: () => source,
      subscribe(listener) {
        sourceListeners.add(listener);
        return () => sourceListeners.delete(listener);
      },
    },
    load: async () => source,
    select: async (selection) => {
      selected = selection;
      return { ok: true };
    },
    reasoningFor: () => ({ defaultEffort: 'high' }),
  };
  const merged = createMergedDirectory(original);
  assert.equal(merged.store.getSnapshot().groups[0].id, 'opencode-go');
  assert.deepEqual(merged.store.getSnapshot().groups[0].models.map((model) => model.id), ['primary', 'shared', 'chat', 'resp', 'messages']);
  assert.equal(merged.store.getSnapshot().current.provider, 'opencode-go');

  let notifications = 0;
  const off = merged.store.subscribe(() => {
    notifications += 1;
  });
  source = {
    ...source,
    current: { provider: 'opencode-go-messages', model: 'messages' },
  };
  for (const listener of [...sourceListeners]) listener();
  assert.equal(notifications, 1);
  assert.equal(merged.store.getSnapshot().current.provider, 'opencode-go');
  off();

  const loaded = await merged.load();
  assert.equal(loaded.groups[0].id, 'opencode-go');
  assert.equal(loaded.groups.some((group) => group.id === 'opencode-go-messages'), false);
  await merged.select({ provider: 'opencode-go', model: 'chat' });
  assert.deepEqual(selected, { provider: 'opencode-go-chat', model: 'chat' });
  assert.deepEqual(merged.reasoningFor(), { defaultEffort: 'high' });
});

test('creates one provider group when the primary route has no catalog row', () => {
  const groups = [
    {
      id: 'opencode-go-responses',
      name: 'OpenCode Go · Responses',
      models: [{ id: 'resp' }],
    },
    {
      id: 'opencode-go-chat',
      name: 'OpenCode Go · Chat Completions',
      models: [{ id: 'chat' }],
    },
  ];
  const plan = mergeModelGroups(groups);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.groups.map((group) => group.id), ['opencode-go']);
  assert.equal(plan.groups[0].name, 'OpenCode Go');
  assert.deepEqual(plan.groups[0].models.map((model) => model.id), ['chat', 'resp']);
  assert.equal(plan.modelRoutes.get('opencode-go\u0000resp'), 'opencode-go-responses');
  assert.equal(plan.modelRoutes.get('opencode-go\u0000chat'), 'opencode-go-chat');
});

test('never creates an empty provider group', () => {
  const groups = [
    { id: 'opencode-go-responses', name: 'OpenCode Go · Responses', models: [] },
  ];
  const plan = mergeModelGroups(groups);
  assert.deepEqual(plan.groups, []);
});

test('maps a failed sibling warning even when its group has no catalog row', () => {
  const failures = [
    { id: 'opencode-go-responses', name: 'OpenCode Go · Responses', message: 'failed' },
    { id: 'openrouter', name: 'OpenRouter', message: 'failed' },
  ];
  const snapshot = { groups: [], failures };
  const transformed = transformDirectorySnapshot(snapshot);
  assert.deepEqual(transformed.failures.map((failure) => failure.id), ['opencode-go', 'openrouter']);
  assert.equal(transformed.failures[0].name, 'OpenCode Go');
  assert.equal(transformed.failures[0].message, 'failed');
  assert.equal(transformed.groups, snapshot.groups);
});

test('passes through a directory with no sibling groups unchanged', async () => {
  const groups = [{ id: 'openrouter', name: 'OpenRouter', models: [{ id: 'one' }] }];
  const snapshot = { groups, current: { provider: 'openrouter', model: 'one' }, pending: null, failures: [] };
  let selected;
  const original = {
    store: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    load: async () => snapshot,
    select: async (selection) => {
      selected = selection;
      return { ok: true };
    },
  };
  const merged = createMergedDirectory(original);
  assert.equal(merged.store.getSnapshot(), snapshot);
  assert.equal(await merged.load(), snapshot);
  await merged.select({ provider: 'openrouter', model: 'one' });
  assert.deepEqual(selected, { provider: 'openrouter', model: 'one' });
});
