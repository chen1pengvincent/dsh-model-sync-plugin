import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createModelSyncCommand, formatCheckReport, formatStatus } from '../lib/command.js';

const PAYLOAD = {
  at: 1789033518784,
  results: [
    { provider: 'deepseek-official', status: 'ok', newItems: [] },
    { provider: 'opencode-go', status: 'ok', newItems: [{ id: 'a' }, { id: 'b' }], repairs: [{ id: 'x' }] },
    { provider: 'openrouter', status: 'unmanaged' },
    { provider: 'kimi-coding', status: 'discovery-failed', error: 'HTTP 503' },
  ],
};

test('formatCheckReport summarises every route in plain language', () => {
  const text = formatCheckReport(PAYLOAD);
  assert.match(text, /DeepSeek：无新增/);
  assert.match(text, /OpenCode Go：2 个新模型，1 个协议修正项/);
  assert.match(text, /OpenRouter：未纳入检查/);
  assert.match(text, /Kimi Coding：检查失败（HTTP 503）/);
  assert.match(text, /「添加所选」/);
});

test('formatCheckReport says no action when there is nothing new', () => {
  const text = formatCheckReport({ at: Date.now(), results: [{ provider: 'deepseek-official', status: 'ok', newItems: [] }] });
  assert.match(text, /当前没有需要添加的模型/);
});

test('formatStatus handles empty and populated state', () => {
  assert.match(formatStatus({}), /尚未检查过/);
  const text = formatStatus({ lastCheck: PAYLOAD, lastApply: { at: Date.now(), applied: [{ provider: 'opencode-go', added: 2 }] } });
  assert.match(text, /上次检查：/);
  assert.match(text, /OpenCode Go：2 个新模型/);
  assert.match(text, /上次添加：.*（2 个模型）/);
});

test('command handler runs check by default and status without network', async () => {
  let checks = 0;
  const controller = {
    async check() {
      checks += 1;
      return PAYLOAD;
    },
    status() {
      return { lastCheck: PAYLOAD, lastApply: null };
    },
  };
  const command = createModelSyncCommand(controller);
  assert.equal(command.name, 'model-sync');
  assert.match(command.name, /^[a-z][a-z0-9_-]*$/);
  assert.equal(typeof command.handler, 'function');

  const preview = await command.handler({ rawInput: '' });
  assert.equal(preview.kind, 'success');
  assert.match(preview.text, /2 个新模型/);
  assert.equal(checks, 1);

  const status = await command.handler({ rawInput: 'status' });
  assert.equal(status.kind, 'success');
  assert.match(status.text, /上次检查：/);
  assert.equal(checks, 1, 'status must not trigger a network check');
});

test('command handler reports usage and wraps failures', async () => {
  const controller = {
    async check() {
      throw new Error('network down');
    },
    status() {
      return {};
    },
  };
  const command = createModelSyncCommand(controller);
  const bad = await command.handler({ rawInput: 'apply' });
  assert.equal(bad.kind, 'error');
  assert.match(bad.text, /用法/);
  const failed = await command.handler({ rawInput: 'check' });
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /网络|network down/);
});
