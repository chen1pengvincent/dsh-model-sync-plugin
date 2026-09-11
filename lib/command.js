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
    if (result.status === 'unmanaged') {
      lines.push(`- ${label(result.provider)}：未纳入检查`);
      continue;
    }
    if (result.status === 'discovery-failed') {
      lines.push(`- ${label(result.provider)}：检查失败（${result.error}）`);
      continue;
    }
    const fresh = (result.newItems ?? []).length;
    const repairs = (result.repairs ?? []).length;
    const parts = [fresh > 0 ? `${fresh} 个新模型` : '无新增'];
    if (repairs > 0) parts.push(`${repairs} 个协议修正项`);
    lines.push(`- ${label(result.provider)}：${parts.join('，')}`);
  }
  return lines;
}

/** Render one `check` payload as plain text for a command result. */
export function formatCheckReport(payload) {
  const lines = [`模型更新检查完成（${timeText(payload.at)}）：`, ...resultLines(payload.results)];
  const total = (payload.results ?? []).reduce((sum, result) => sum + (result.newItems ?? []).length, 0);
  lines.push(total > 0 ? '在 设置 → 模型更新 展开列表勾选后点「添加所选」。' : '当前没有需要添加的模型。');
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
        return { kind: 'error', text: `模型更新检查失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
