import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeepseekEntry,
  buildModelsDevIndex,
  classifyProtocol,
  detectRouteRepairs,
  detectRouteUpdates,
  modelsUrl,
  parseListing,
  planDeepseekAdditions,
  planRouteChanges,
  primaryProtocol,
  reasoningEffortsFromMeta,
  siblingName,
  stableStringify,
  targetProvider,
} from '../lib/engine.js';
import { BUILTIN_ROUTES } from '../lib/routes.js';

const ROUTE = BUILTIN_ROUTES['opencode-go'];
const DEEPSEEK_ROUTE = BUILTIN_ROUTES['deepseek-official'];

const INDEX = buildModelsDevIndex({
  'opencode-go': {
    npm: '@ai-sdk/openai-compatible',
    models: {
      'deepseek-flash': { attachment: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
      'minimax-m3': { provider: { npm: '@ai-sdk/anthropic' } },
      'gpt-5.6-luna': { provider: { npm: '@ai-sdk/openai' }, attachment: true },
    },
  },
});

test('modelsUrl/parseListing/buildModelsDevIndex basics', () => {
  assert.equal(modelsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/models');
  assert.deepEqual(parseListing({ data: [{ id: 'a' }, { id: '' }] }).map((m) => m.id), ['a']);
  assert.equal(INDEX.providers['opencode-go'].models['minimax-m3'].api, 'anthropic-messages');
  assert.equal(INDEX.byModel.get('gpt-5.6-luna').api, 'openai-responses');
});

test('reasoningEffortsFromMeta keeps DSH level names only', () => {
  assert.deepEqual(reasoningEffortsFromMeta({ reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }] }), { low: 'low', high: 'high', max: 'max' });
  assert.equal(reasoningEffortsFromMeta({}), undefined);
});

test('primaryProtocol and targetProvider split mixed routes', () => {
  assert.equal(primaryProtocol(ROUTE), 'openai-completions');
  assert.equal(targetProvider(ROUTE, 'openai-completions'), 'opencode-go');
  assert.equal(targetProvider(ROUTE, 'anthropic-messages'), 'opencode-go-messages');
  assert.equal(targetProvider(ROUTE, 'openai-responses'), 'opencode-go-responses');
  assert.equal(siblingName(ROUTE, 'anthropic-messages'), 'opencode-go-messages');
});

test('classifyProtocol never trusts a profile api (v1 collapse regression)', () => {
  assert.equal(classifyProtocol(ROUTE, 'minimax-m3', INDEX).api, 'anthropic-messages');
  assert.equal(classifyProtocol(ROUTE, 'brand-new', INDEX).api, 'openai-completions');
  assert.deepEqual(classifyProtocol(ROUTE, 'brand-new', buildModelsDevIndex({})), { api: undefined, source: 'no-metadata' });
  const single = BUILTIN_ROUTES['kimi-coding'];
  assert.equal(classifyProtocol(single, 'anything', buildModelsDevIndex({})).api, 'anthropic-messages');
});

test('detectRouteUpdates lists new models with placement, removed, and skips', () => {
  const profiles = { 'opencode-go': { models: [{ id: 'kimi-k3' }] } };
  const updates = detectRouteUpdates(ROUTE, [{ id: 'kimi-k3' }, { id: 'deepseek-flash' }, { id: 'minimax-m3' }, { id: 'gpt-5.6-luna' }], profiles, INDEX);
  assert.deepEqual(updates.newItems.map((item) => [item.id, item.target]), [
    ['deepseek-flash', 'opencode-go'],
    ['minimax-m3', 'opencode-go-messages'],
    ['gpt-5.6-luna', 'opencode-go-responses'],
  ]);
  assert.deepEqual(updates.removed, []);
  const removed = detectRouteUpdates(ROUTE, [{ id: 'kimi-k3' }], { 'opencode-go': { models: [{ id: 'kimi-k3' }, { id: 'gone' }] } }, INDEX);
  assert.deepEqual(removed.removed, [{ id: 'gone', provider: 'opencode-go' }]);
});

test('detectRouteRepairs moves misplaced models back without touching correct ones', () => {
  const profiles = {
    'opencode-go': { models: [{ id: 'kimi-k3' }, { id: 'minimax-m3' }] },
    'opencode-go-responses': { models: [{ id: 'gpt-5.6-luna' }] },
  };
  const repairs = detectRouteRepairs(ROUTE, profiles, INDEX);
  assert.deepEqual(repairs.map((repair) => [repair.id, repair.from, repair.to]), [['minimax-m3', 'opencode-go', 'opencode-go-messages']]);
});

test('planRouteChanges appends selected additions and creates siblings', () => {
  const profiles = { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'kimi-k3', name: 'Kimi K3' }] } };
  const additions = [
    { id: 'deepseek-flash', api: 'openai-completions', target: 'opencode-go', entry: { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' } },
    { id: 'minimax-m3', api: 'anthropic-messages', target: 'opencode-go-messages', entry: { id: 'minimax-m3', name: 'MiniMax M3' } },
  ];
  const planned = planRouteChanges(ROUTE, profiles, { additions, repairs: [] }, 'OPENCODE_GO_API_KEY');
  const main = planned.operations.find((op) => op.op === 'set' && op.path.join('.') === 'providers.opencode-go.models');
  assert.deepEqual(main.value.map((model) => model.id), ['kimi-k3', 'deepseek-flash']);
  assert.ok(planned.operations.some((op) => op.op === 'set' && op.path.join('.') === 'providers.opencode-go-messages' && op.value.api === 'anthropic-messages'));
  assert.ok(planned.operations.some((op) => op.op === 'set' && op.path.join('.') === 'providers.opencode-go.api' && op.value === 'openai-completions'));
  assert.deepEqual(planned.createdSiblings, ['opencode-go-messages']);
});

test('planRouteChanges repairs preserve entries verbatim and are idempotent', () => {
  const minimax = { id: 'minimax-m3', name: 'MiniMax M3', input: ['text', 'image'], compat: { supportsStore: false, maxTokensField: 'max_tokens' } };
  const profiles = { 'opencode-go': { models: [{ id: 'kimi-k3' }, minimax] } };
  const repairs = detectRouteRepairs(ROUTE, profiles, INDEX);
  const planned = planRouteChanges(ROUTE, profiles, { additions: [], repairs }, 'OPENCODE_GO_API_KEY');
  const main = planned.operations.find((op) => op.op === 'set' && op.path.join('.') === 'providers.opencode-go.models');
  assert.deepEqual(main.value.map((model) => model.id), ['kimi-k3']);
  const sibling = planned.operations.find((op) => op.op === 'set' && op.path.join('.') === 'providers.opencode-go-messages');
  const moved = sibling.value.models[0];
  assert.deepEqual(moved, { id: 'minimax-m3', name: 'MiniMax M3', input: ['text', 'image'] });

  const after = { 'opencode-go': { models: [{ id: 'kimi-k3' }] }, 'opencode-go-messages': { models: [moved] } };
  const second = detectRouteRepairs(ROUTE, after, INDEX);
  assert.deepEqual(second, []);
  const noop = planRouteChanges(ROUTE, after, { additions: [], repairs: [] }, 'OPENCODE_GO_API_KEY');
  assert.deepEqual(noop.operations.filter((op) => op.path.join('.').includes('models')), []);
});

test('deepseek additions append selected models only', () => {
  const existing = [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }];
  const planned = planDeepseekAdditions(DEEPSEEK_ROUTE, [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], existing, buildModelsDevIndex({}), undefined);
  assert.deepEqual(planned.models.map((model) => model.id), ['deepseek-v4-pro', 'deepseek-flash']);
  const selected = planDeepseekAdditions(DEEPSEEK_ROUTE, [{ id: 'deepseek-flash' }], existing, buildModelsDevIndex({}), []);
  assert.deepEqual(selected.models, existing);
  const entry = buildDeepseekEntry({ id: 'deepseek-flash' }, undefined, { attachment: true, contextWindow: 1000000 }, DEEPSEEK_ROUTE);
  assert.deepEqual(entry.inputModalities, ['text', 'image']);
  assert.equal(entry.imagePixelBudget, 640000);
});

test('planRouteChanges leaves an unrelated same-name provider alone', () => {
  const profiles = {
    'opencode-go': { models: [{ id: 'kimi-k3' }] },
    'opencode-go-messages': { displayName: 'My Own Provider', models: [{ id: 'custom' }] },
  };
  const additions = [{ id: 'minimax-m3', api: 'anthropic-messages', target: 'opencode-go-messages', entry: { id: 'minimax-m3' } }];
  const blocked = planRouteChanges(ROUTE, profiles, { additions, repairs: [] }, 'OPENCODE_GO_API_KEY', []);
  assert.ok(!blocked.operations.some((op) => op.path.join('.').includes('opencode-go-messages')));
  assert.deepEqual(blocked.blocked.map((entry) => entry.provider), ['opencode-go-messages']);

  const allowed = planRouteChanges(ROUTE, profiles, { additions, repairs: [] }, 'OPENCODE_GO_API_KEY', ['opencode-go-messages']);
  const models = allowed.operations.find((op) => op.op === 'set' && op.path.join('.') === 'providers.opencode-go-messages.models');
  assert.deepEqual(models.value.map((model) => model.id), ['custom', 'minimax-m3']);
  assert.deepEqual(allowed.blocked, []);
});

test('stableStringify ignores key order', () => {
  assert.equal(stableStringify({ a: 1, b: [2, 3] }), stableStringify({ b: [2, 3], a: 1 }));
});
