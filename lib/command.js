/**
 * dsh-model-sync — `/model-sync` human command.
 *
 * A read-only capability other than the settings panel: `check` runs the same
 * discovery pass as the panel (never writes settings) and prints each
 * provider's newly advertised models; `status` reports the cached result.
 * Declared as this plugin's Workshop `capability` because a running harness
 * can register, invoke and observe it without touching the UI.
 */

const ROUTE_LABELS = {
  'deepseek-official': 'DeepSeek',
  'opencode-go': 'OpenCode Go',
  'opencode-go-messages': 'OpenCode Go · Anthropic',
  'opencode-go-responses': 'OpenCode Go · Responses',
  'opencode-go-chat': 'OpenCode Go · Chat',
  opencode: 'OpenCode',
  'opencode-chat': 'OpenCode · Chat',
  'opencode-messages': 'OpenCode · Anthropic',
  'opencode-responses': 'OpenCode · Responses',
  openrouter: 'OpenRouter',
  'kimi-coding': 'Kimi Coding',
};

const USAGE = '用法：/model-sync [check|status]（默认 check）';

function label(provider) {
  return ROUTE_LABELS[provider] ?? provider;
}

function timeText(value) {
  if (typeof value !== 'number') return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function resultLines(results) {
  const lines = [];
  for (const result of results ?? []) {
    const name = result.displayName ?? label(result.provider);
    if (result.status === 'unmanaged') {
      lines.push(`- ${name}：未纳入检查`);
    } else if (result.status !== 'ok') {
      const status = result.status === 'discovery-failed' ? '检查失败' : result.status === 'needs-check' ? '等待检查' : '暂不支持';
      lines.push(`- ${name}：${status}（${result.reason ?? '请重新检查供应商设置'}）`);
    } else {
      const available = (result.newItems ?? []).length;
      const repairs = (result.repairs ?? []).length;
      const catalog = result.catalog;
      const parts = catalog ? [
        `当前 ${catalog.total} 个模型`,
        `变更 ${catalog.changedCount} 个（新增 ${catalog.addedCount}，删除 ${catalog.removedCount}）`,
      ] : ['无目录变更统计'];
      if (catalog?.firstDiscovery && !catalog.changedCount) parts.push('首次发现，已建立基线');
      parts.push(`可添加 ${available} 个`);
      if (repairs > 0) parts.push(`${repairs} 个协议修正项`);
      lines.push(`- ${name}：${parts.join('，')}`);
      if (result.notice) lines.push(`  ${result.notice}`);
    }
    // A read-only credential cannot be changed from the settings page; surface
    // it loudly with the source-specific remedy from the controller.
    if (result.credential?.readOnly === true || result.credential?.shadowed === true) {
      lines.push(`  ⚠️ ${result.credential.warning ?? `凭证 ${result.credential.ref} 为只读，设置页无法修改`}`);
    }
  }
  return lines;
}

/** Render one `check` payload as plain text for a command result. */
export function formatCheckReport(payload) {
  const lines = [`模型更新检查完成（${timeText(payload.at)}）：`, ...resultLines(payload.results)];
  const total = (payload.results ?? []).reduce((sum, result) => sum + (result.newItems ?? []).length, 0);
  lines.push(total > 0 ? '在 设置 → 模型更新 展开供应商下的全部模型，勾选后点「保存所选」。' : '当前没有可添加的模型；目录删除不自动移除已启用模型。');
  return lines.join('\n');
}

/** Render cached controller status without any network access. */
export function formatStatus(state) {
  if (state?.lastCheck === undefined || state.lastCheck === null) {
    return '尚未检查过。运行 /model-sync check，或打开 设置 → 模型更新。';
  }
  const lines = [`上次检查：${timeText(state.lastCheck.at)}`, ...resultLines(state.lastCheck.results)];
  if (state.lastApply !== undefined && state.lastApply !== null) {
    const added = (state.lastApply.applied ?? []).reduce((sum, entry) => sum + (entry.added ?? 0), 0);
    lines.push(`上次添加：${timeText(state.lastApply.at)}（${added} 个模型）`);
  }
  return lines.join('\n');
}

/**
 * Build the `/model-sync` command definition.
 * @param controller - the SyncController instance.
 */
export function createModelSyncCommand(controller) {
  return {
    name: 'model-sync',
    description: '检查各 provider 上游是否有新模型（只读，不写入）',
    input: { hint: 'check | status' },
    handler: async (invocation) => {
      const operation = (invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? 'check';
      try {
        if (operation === 'status') return { kind: 'success', text: formatStatus(controller.status()) };
        if (operation !== 'check') return { kind: 'error', text: USAGE };
        return { kind: 'success', text: formatCheckReport(await controller.check()) };
      } catch (error) {
        return { kind: 'error', text: `模型更新检查失败：${error?.safe === true && typeof error.publicMessage === 'string' ? error.publicMessage : '请检查供应商配置后重试（错误详情已隐藏，避免泄露凭证）'}` };
      }
    },
  };
}
