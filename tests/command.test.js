import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createModelSyncCommand, formatCheckReport, formatStatus } from '../lib/command.js';
import { acknowledgeCatalog, catalogSummary, updateCatalog } from '../lib/catalog.js';

const AT = 1789033518784;
const rows = (ids) => ids.map((id) => ({ id }));

function catalogSinceViewed(viewedIds, currentIds) {
  const baseline = updateCatalog(undefined, 'synthetic-command-scope', rows(viewedIds), { at: AT });
  assert.equal(acknowledgeCatalog(baseline, catalogSummary(baseline).revision, AT + 1).acknowledged, true);
  return catalogSummary(updateCatalog(baseline, 'synthetic-command-scope', rows(currentIds), { at: AT + 2 }));
}

const PAYLOAD = {
  at: AT,
  results: [
    {
      provider: 'deepseek-official', status: 'ok', newItems: [],
      catalog: catalogSinceViewed(['chat', 'reasoner'], ['chat', 'reasoner']),
    },
    {
      provider: 'opencode-go', status: 'ok', newItems: [{ id: 'a' }, { id: 'b' }], repairs: [{ id: 'x' }],
      // "a" was already viewed but is not enabled; only "b" is a new arrival.
      catalog: catalogSinceViewed(['existing', 'a', 'retired'], ['existing', 'a', 'b']),
    },
    {
      provider: 'opencode', status: 'ok', newItems: [{ id: 'qwen3.8-max' }], repairs: [],
      catalog: catalogSinceViewed(['qwen3.8-max'], ['qwen3.8-max']),
    },
    { provider: 'openrouter', status: 'unmanaged' },
    {
      provider: 'kimi-coding', status: 'discovery-failed',
      reason: '上游暂时不可用，请稍后重试', error: 'SYNTHETIC_PRIVATE_UPSTREAM_ERROR',
    },
  ],
};

test('formatCheckReport separates viewed-catalog changes from models available to add', () => {
  const text = formatCheckReport(PAYLOAD);
  assert.match(text, /DeepSeek：当前 2 个模型，变更 0 个（新增 0，删除 0），可添加 0 个/);
  assert.match(text, /OpenCode Go：当前 3 个模型，变更 2 个（新增 1，删除 1），可添加 2 个，1 个协议修正项/);
  assert.match(text, /^- OpenCode：当前 1 个模型，变更 0 个（新增 0，删除 0），可添加 1 个$/m);
  assert.match(text, /OpenRouter：未纳入检查/);
  assert.match(text, /Kimi Coding：检查失败（上游暂时不可用，请稍后重试）/);
  assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_UPSTREAM_ERROR/);
  assert.match(text, /勾选后点「保存所选」/, 'checking must direct users to explicit selection rather than applying changes');
});

test('formatCheckReport does not turn catalog removals into configuration removals', () => {
  const text = formatCheckReport({ at: AT, results: [{
    provider: 'deepseek-official', status: 'ok', newItems: [],
    catalog: catalogSinceViewed(['keep', 'gone'], ['keep']),
  }] });
  assert.match(text, /当前 1 个模型，变更 1 个（新增 0，删除 1），可添加 0 个/);
  assert.match(text, /当前没有可添加的模型；目录删除不自动移除已启用模型/);
  assert.doesNotMatch(text, /「保存所选」/);
});

test('first discovery establishes a baseline even when its models are available to add', () => {
  const catalog = catalogSummary(updateCatalog(undefined, 'synthetic-first-discovery', rows(['first', 'second']), { at: AT }));
  const text = formatCheckReport({ at: AT, results: [{
    provider: 'opencode-go', status: 'ok', catalog, newItems: rows(['first', 'second']),
  }] });
  assert.match(text, /当前 2 个模型，变更 0 个（新增 0，删除 0），首次发现，已建立基线，可添加 2 个/);
  assert.match(text, /勾选后点「保存所选」/);
});

test('a new catalog arrival can already be enabled and require no addition', () => {
  const text = formatCheckReport({ at: AT, results: [{
    provider: 'opencode-go', status: 'ok', newItems: [],
    catalog: catalogSinceViewed(['keep'], ['keep', 'already-enabled-new']),
  }] });
  assert.match(text, /变更 1 个（新增 1，删除 0），可添加 0 个/);
  assert.match(text, /当前没有可添加的模型/);
});

test('missing catalog statistics are not fabricated from the available-model count', () => {
  const text = formatCheckReport({ at: AT, results: [{ provider: 'opencode-go', status: 'ok', newItems: rows(['a']) }] });
  assert.match(text, /无目录变更统计，可添加 1 个/);
  assert.doesNotMatch(text, /变更 \d+ 个|新增 \d+|首次发现/);
});

test('formatStatus handles empty and populated state', () => {
  assert.match(formatStatus({}), /尚未检查过/);
  const text = formatStatus({ lastCheck: PAYLOAD, lastApply: { at: Date.now(), applied: [{ provider: 'opencode-go', added: 2 }] } });
  assert.match(text, /上次检查：/);
  assert.match(text, /OpenCode Go：当前 3 个模型，变更 2 个（新增 1，删除 1），可添加 2 个/);
  assert.match(text, /上次添加：.*（2 个模型）/);
});

test('command handler runs check by default and cached status without network or writes', async () => {
  let checks = 0;
  let writes = 0;
  const controller = {
    async check() {
      checks += 1;
      return PAYLOAD;
    },
    status() {
      return { lastCheck: PAYLOAD, lastApply: null };
    },
    async applySelection() { writes += 1; },
    async removeManagedModels() { writes += 1; },
  };
  const command = createModelSyncCommand(controller);
  assert.equal(command.name, 'model-sync');
  assert.match(command.name, /^[a-z][a-z0-9_-]*$/);
  assert.equal(typeof command.handler, 'function');

  const preview = await command.handler({ rawInput: '' });
  assert.equal(preview.kind, 'success');
  assert.match(preview.text, /变更 2 个（新增 1，删除 1），可添加 2 个/);
  assert.match(preview.text, /勾选后点「保存所选」/);
  assert.equal(checks, 1);
  assert.equal(writes, 0, 'a default check must not apply or remove any model');

  const status = await command.handler({ rawInput: 'status' });
  assert.equal(status.kind, 'success');
  assert.match(status.text, /上次检查：/);
  assert.match(status.text, /变更 2 个（新增 1，删除 1），可添加 2 个/);
  assert.equal(checks, 1, 'status must not trigger a network check');
  assert.equal(writes, 0, 'reading cached status must not write settings');
});

test('command handler rejects mutating verbs without checking or writing', async () => {
  let checks = 0;
  let writes = 0;
  const controller = {
    async check() { checks += 1; return PAYLOAD; },
    status() { return {}; },
    async applySelection() { writes += 1; },
    async removeManagedModels() { writes += 1; },
    async repairRoutes() { writes += 1; },
    setManaged() { writes += 1; },
  };
  const command = createModelSyncCommand(controller);
  for (const operation of ['apply', 'save', 'repair', 'remove', 'select']) {
    const result = await command.handler({ rawInput: operation });
    assert.equal(result.kind, 'error', operation);
    assert.match(result.text, /用法/);
  }
  assert.equal(checks, 0, 'an unsupported operation must not even initiate a check');
  assert.equal(writes, 0, 'the command never authorizes mutations in place of explicit UI selection');
});

test('command handler wraps failures without displaying raw error details', async () => {
  const command = createModelSyncCommand({
    async check() { throw new Error('network down: SYNTHETIC_PRIVATE_ERROR_DETAIL'); },
    status() { return {}; },
  });
  const failed = await command.handler({ rawInput: 'check' });
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /模型更新检查失败：/);
  assert.match(failed.text, /错误详情已隐藏，避免泄露凭证/);
  assert.doesNotMatch(failed.text, /network down|SYNTHETIC_PRIVATE_ERROR_DETAIL/);
});

test('command handler displays a safe public message but not its private cause', async () => {
  const error = Object.assign(new Error('SYNTHETIC_PRIVATE_CAUSE'), {
    safe: true, publicMessage: '配置已发生变化，请重新检查',
  });
  const command = createModelSyncCommand({ async check() { throw error; } });
  const failed = await command.handler({ rawInput: 'check' });
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /模型更新检查失败：配置已发生变化，请重新检查/);
  assert.doesNotMatch(failed.text, /SYNTHETIC_PRIVATE_CAUSE/);
});

test('untrusted publicMessage fields cannot bypass the safe-error boundary', async () => {
  for (const fields of [
    { publicMessage: 'SYNTHETIC_UNTRUSTED_MESSAGE' },
    { safe: 'true', publicMessage: 'SYNTHETIC_UNTRUSTED_MESSAGE' },
    { safe: true, publicMessage: { privateDetail: 'SYNTHETIC_UNTRUSTED_MESSAGE' } },
  ]) {
    const error = Object.assign(new Error('SYNTHETIC_PRIVATE_CAUSE'), fields);
    const command = createModelSyncCommand({ async check() { throw error; } });
    const failed = await command.handler({ rawInput: 'check' });
    assert.equal(failed.kind, 'error');
    assert.match(failed.text, /错误详情已隐藏，避免泄露凭证/);
    assert.doesNotMatch(failed.text, /SYNTHETIC_UNTRUSTED_MESSAGE|SYNTHETIC_PRIVATE_CAUSE/);
  }
});

test('a failed route without a safe reason does not render its raw error field', () => {
  const payload = { at: AT, results: [{
    provider: 'kimi-coding', status: 'discovery-failed', error: 'SYNTHETIC_PRIVATE_ROUTE_ERROR',
  }] };
  for (const text of [formatCheckReport(payload), formatStatus({ lastCheck: payload })]) {
    assert.match(text, /Kimi Coding：检查失败/);
    assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_ROUTE_ERROR/);
  }
});

test('shadowed credential renders a warning line under its provider and in cached status', () => {
  const payload = {
    at: AT,
    results: [
      {
        provider: 'opencode-go',
        status: 'ok',
        newItems: [],
        catalog: catalogSinceViewed(['keep'], ['keep']),
        credential: { ref: 'OPENCODE_GO_API_KEY', configured: true, source: 'env', writable: false, shadowed: true, warning: '凭证 OPENCODE_GO_API_KEY 由启动环境变量注入：只读。' },
      },
    ],
  };
  const text = formatCheckReport(payload);
  assert.match(text, /OpenCode Go：当前 1 个模型，变更 0 个（新增 0，删除 0），可添加 0 个/);
  assert.match(text, /⚠️ 凭证 OPENCODE_GO_API_KEY 由启动环境变量注入/);
  const statusText = formatStatus({ lastCheck: payload });
  assert.match(statusText, /⚠️ 凭证 OPENCODE_GO_API_KEY/, 'warning also renders from cached status');
});

test('read-only credential metadata keeps its warning without requiring shadowing', () => {
  const payload = { at: AT, results: [{
    provider: 'opencode-go', status: 'ok', newItems: [],
    catalog: catalogSinceViewed(['keep'], ['keep']),
    credential: { ref: 'SYNTHETIC_READ_ONLY_REFERENCE', readOnly: true, shadowed: false },
  }] };
  for (const text of [formatCheckReport(payload), formatStatus({ lastCheck: payload })]) {
    assert.match(text, /⚠️/);
    assert.match(text, /只读/);
  }
});
