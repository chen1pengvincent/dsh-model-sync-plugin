import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeepseekEntry,
  buildModelsDevIndex,
  buildPiAiEntry,
  classifyProtocol,
  detectRouteRepairs,
  detectRouteUpdates,
  expectedSiblingNames,
  modelsDevMeta,
  modelsUrl,
  parseListing,
  planDeepseekAdditions,
  planRouteChanges,
  primaryProtocol,
  reasoningEffortsFromMeta,
  siblingName,
  stableStringify,
  targetProvider,
  vendorForModel,
} from '../lib/engine.js';
import { BUILTIN_ROUTES } from '../lib/routes.js';

const ROUTE = BUILTIN_ROUTES['opencode-go'];
const DEEPSEEK_ROUTE = BUILTIN_ROUTES['deepseek-official'];
const OPENCODE_ROUTE = BUILTIN_ROUTES.opencode;

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

test('planRouteChanges writes route api+baseURL on single-protocol routes too', () => {
  const route = BUILTIN_ROUTES.openrouter;
  const profiles = { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', models: [] } };
  const additions = [{ id: 'anthropic/claude-opus-5-fast', api: 'openai-completions', target: 'openrouter', entry: { id: 'anthropic/claude-opus-5-fast', name: 'Claude Opus 5 (Fast)' } }];
  const planned = planRouteChanges(route, profiles, { additions, repairs: [] }, 'OPENROUTER_API_KEY');
  assert.ok(planned.operations.some((op) => op.op === 'set' && op.path.join('.') === 'providers.openrouter.api' && op.value === 'openai-completions'));
  assert.ok(planned.operations.some((op) => op.op === 'set' && op.path.join('.') === 'providers.openrouter.baseURL' && op.value === 'https://openrouter.ai/api/v1'));
  assert.deepEqual(planned.createdSiblings, []);
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

const OPENCODE_INDEX = buildModelsDevIndex({
  opencode: {
    npm: '@ai-sdk/openai-compatible',
    models: {
      'qwen3.8-max': {},
      'claude-haiku-5-5': { provider: { npm: '@ai-sdk/anthropic' }, reasoning: true },
      'gemini-4-argon': { provider: { npm: '@ai-sdk/google' } },
      'mistral-large-4': { provider: { npm: '@ai-sdk/mistral' } },
    },
  },
});

test('opencode route is siblingOnly: even the primary protocol targets a sibling', () => {
  assert.equal(targetProvider(OPENCODE_ROUTE, 'openai-completions'), 'opencode-chat');
  assert.equal(targetProvider(OPENCODE_ROUTE, 'anthropic-messages'), 'opencode-messages');
  assert.equal(targetProvider(OPENCODE_ROUTE, 'openai-responses'), 'opencode-responses');
  assert.deepEqual(expectedSiblingNames(OPENCODE_ROUTE), ['opencode-chat', 'opencode-messages', 'opencode-responses']);
});

test('classifyProtocol: models.dev first, then curated family rules', () => {
  assert.deepEqual(classifyProtocol(OPENCODE_ROUTE, 'qwen3.8-max', OPENCODE_INDEX), { api: 'openai-completions', source: 'models.dev' });
  assert.deepEqual(classifyProtocol(OPENCODE_ROUTE, 'claude-haiku-5-5', OPENCODE_INDEX), { api: 'anthropic-messages', source: 'models.dev' });
  assert.deepEqual(classifyProtocol(OPENCODE_ROUTE, 'claude-opus-5-5-backup', OPENCODE_INDEX), { api: 'anthropic-messages', source: 'route-rule' });
  assert.deepEqual(classifyProtocol(OPENCODE_ROUTE, 'mistral-large-4', OPENCODE_INDEX), { api: 'openai-completions', source: 'route-rule' });
  assert.deepEqual(classifyProtocol(OPENCODE_ROUTE, 'gemini-4-argon', OPENCODE_INDEX), { api: undefined, source: 'unknown' });
  assert.deepEqual(classifyProtocol(OPENCODE_ROUTE, 'test', buildModelsDevIndex({})), { api: undefined, source: 'no-metadata' });
  assert.deepEqual(classifyProtocol(OPENCODE_ROUTE, 'claude-opus-5-5-backup', buildModelsDevIndex({})), { api: 'anthropic-messages', source: 'route-rule' });
});

test('detectRouteUpdates on opencode places additions on siblings and skips unmappable ids', () => {
  const profiles = { opencode: { models: [{ id: 'claude-opus-5-5' }, { id: 'mimo-v2.6-flash-free' }] } };
  const discovered = [
    { id: 'claude-opus-5-5' },
    { id: 'mimo-v2.6-flash-free' },
    { id: 'claude-opus-5-5-backup' },
    { id: 'qwen3.8-max' },
    { id: 'mistral-large-4' },
    { id: 'gemini-4-argon' },
    { id: 'test' },
  ];
  const updates = detectRouteUpdates(OPENCODE_ROUTE, discovered, profiles, OPENCODE_INDEX);
  assert.deepEqual(updates.newItems.map((item) => [item.id, item.target]), [
    ['claude-opus-5-5-backup', 'opencode-messages'],
    ['qwen3.8-max', 'opencode-chat'],
    ['mistral-large-4', 'opencode-chat'],
  ]);
  assert.deepEqual(updates.skipped.map((entry) => entry.id).sort(), ['gemini-4-argon', 'test']);
  assert.deepEqual(updates.removed, []);
});

test('siblingOnly repairs ignore the catalog provider row and fix sibling mixups', () => {
  const profiles = {
    opencode: { models: [{ id: 'claude-opus-5-5' }] },
    'opencode-messages': { models: [{ id: 'qwen3.8-max' }, { id: 'claude-haiku-5-5' }] },
  };
  const repairs = detectRouteRepairs(OPENCODE_ROUTE, profiles, OPENCODE_INDEX);
  assert.deepEqual(repairs.map((repair) => [repair.id, repair.from, repair.to]), [
    ['qwen3.8-max', 'opencode-messages', 'opencode-chat'],
  ]);
});

test('planRouteChanges on a siblingOnly route never writes the catalog provider row', () => {
  const profiles = { opencode: { apiKeyEnv: 'OPENCODE_API_KEY', models: [{ id: 'claude-opus-5-5' }] } };
  const additions = [
    {
      id: 'claude-haiku-5-5',
      api: 'anthropic-messages',
      target: 'opencode-messages',
      entry: buildPiAiEntry({ id: 'claude-haiku-5-5' }, undefined, modelsDevMeta(OPENCODE_INDEX, 'opencode', 'claude-haiku-5-5'), OPENCODE_ROUTE, 'anthropic-messages'),
    },
    {
      id: 'deepseek-v4.1-flash-free',
      api: 'openai-completions',
      target: 'opencode-chat',
      entry: buildPiAiEntry({ id: 'deepseek-v4.1-flash-free' }, undefined, undefined, OPENCODE_ROUTE, 'openai-completions'),
    },
  ];
  const planned = planRouteChanges(OPENCODE_ROUTE, profiles, { additions, repairs: [] }, 'OPENCODE_API_KEY');
  assert.ok(!planned.operations.some((op) => op.path.slice(0, 2).join('.') === 'providers.opencode'), 'catalog row untouched');
  const messages = planned.operations.find((op) => op.path.join('.') === 'providers.opencode-messages');
  assert.equal(messages.value.api, 'anthropic-messages');
  assert.equal(messages.value.baseURL, 'https://opencode.ai/zen');
  assert.equal(messages.value.apiKeyEnv, 'OPENCODE_API_KEY');
  assert.deepEqual(messages.value.models[0].compat, { forceAdaptiveThinking: true, supportsTemperature: false });
  const chat = planned.operations.find((op) => op.path.join('.') === 'providers.opencode-chat');
  assert.equal(chat.value.baseURL, 'https://opencode.ai/zen/v1');
  assert.deepEqual(chat.value.models[0].compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: true,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
  });
  assert.deepEqual(planned.createdSiblings.sort(), ['opencode-chat', 'opencode-messages']);
});

test('claude compat rule only applies to 5.x claude models', () => {
  const entry = buildPiAiEntry({ id: 'claude-fable-5-1' }, undefined, undefined, OPENCODE_ROUTE, 'anthropic-messages');
  assert.deepEqual(entry, { id: 'claude-fable-5-1' });
});


test('vendorForModel prefers known publishers and falls back safely', () => {
  const index = buildModelsDevIndex({
    anthropic: { name: 'Anthropic', models: { 'claude-opus-5-5': {} } },
    openai: { name: 'OpenAI', models: { 'gpt-6': {} } },
    openrouter: { name: 'OpenRouter', models: { 'openai/gpt-6': {}, 'acme/new-model': {} } },
    opencode: { name: 'OpenCode', models: { 'deepseek-v4.1-flash-free': {}, 'space-bunny-free': {} } },
  });
  assert.deepEqual(vendorForModel(index, 'claude-opus-5-5'), { vendorId: 'anthropic', vendor: 'Anthropic' });
  assert.deepEqual(vendorForModel(index, 'openai/gpt-6'), { vendorId: 'openai', vendor: 'OpenAI' });
  assert.deepEqual(vendorForModel(index, 'deepseek-v4.1-flash-free'), { vendorId: 'deepseek', vendor: 'DeepSeek' });
  assert.deepEqual(vendorForModel(index, 'space-bunny-free'), { vendorId: 'other', vendor: '其他' });
  const ambiguous = buildModelsDevIndex({
    alibaba: { name: 'Alibaba', models: { 'kimi-k3': {} } },
    moonshotai: { name: 'Moonshot AI', models: { 'kimi-k3': {} } },
  });
  assert.deepEqual(vendorForModel(ambiguous, 'kimi-k3'), { vendorId: 'moonshotai', vendor: 'Moonshot AI' });
  assert.deepEqual(vendorForModel(index, 'acme/new-model'), { vendorId: 'other', vendor: '其他' });
  assert.deepEqual(vendorForModel(buildModelsDevIndex({}), 'claude-opus-5-5'), { vendorId: 'anthropic', vendor: 'Anthropic' });
  assert.deepEqual(vendorForModel(index, 'k3', { vendorId: 'moonshotai', vendor: 'Moonshot AI' }), { vendorId: 'moonshotai', vendor: 'Moonshot AI' });
});
