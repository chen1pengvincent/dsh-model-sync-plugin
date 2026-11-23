/**
 * Choose which upstream models to add, and which configured models to show.
 *
 * Deliberately dependency-free: `react` is the only import, because the bundle
 * is served raw to the browser (no build step) and `require` resolves against
 * the harness's own module table.
 *
 *   window.__ModuleLoader__.load({ id, factory })
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-sync',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const API = '/model-sync/api'
    /** Long enough for a real check, short enough that a dead host is visible. */
    const REQUEST_TIMEOUT_MS = 30_000

    const PROTOCOL_LABEL = {
      'deepseek-models': 'DeepSeek 官方目录',
      'openai-completions': 'Chat Completions',
      'openai-responses': 'Responses',
      'anthropic-messages': 'Anthropic Messages',
      'google-generative-ai': 'Gemini',
      generative: 'Gemini',
    }

    const STATUS_LABEL = {
      ok: '',
      adapter: '没有目录接口',
      'no-endpoint': '无法检查',
      error: '检查失败',
      'needs-check': '待检查',
    }

    const BILI_LABEL = {
      applied: '已让这些地址走系统代理',
      'applied-unverified': '已写入，但没能回读确认',
      unchanged: '已是最新，无需改动',
      revoked: '已撤销插件的代理声明',
      disabled: '已关闭：不会改动 bili 的出口',
      'no-proxy': '没有检测到系统代理，未写入',
      'no-bili': '没有找到 bili 车道，未写入',
      'no-hosts': '没有需要代理的地址',
      rejected: 'bili 拒绝了这次写入',
      error: '同步时出错',
      busy: '正在同步…',
      'nothing-to-revoke': '没有需要撤销的声明',
    }

    /** One JSON round-trip against the host API. */
    async function call(verb, body) {
      // A host that never answers would leave `busy` set and every button
      // disabled for the rest of the session, so every call is bounded.
      const abort = globalThis.AbortSignal
      const signal = typeof abort === 'function' && typeof abort.timeout === 'function'
        ? abort.timeout(verb === 'check' ? 90_000 : REQUEST_TIMEOUT_MS) : undefined
      const response = await fetch(`${API}/${verb}`, body === undefined
        ? { method: 'GET', headers: { accept: 'application/json' }, signal }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal,
        })
      const type = response.headers?.get?.('content-type') ?? ''
      if (!type.includes('json')) {
        // The usual cause: the host half never activated. The harness keeps
        // that quiet (an optional plugin's activation failure is swallowed in
        // the Web host), so say it here instead of showing a bare status code.
        throw new Error(`插件宿主半没有应答（${API}/${verb} 返回 ${response.status}）。通常是插件未被激活：重启 DSH 后看启动日志，或读 profile 下 model-sync/activation-error.txt。`)
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`插件宿主半返回了无法解析的响应（${response.status}）`)
      }
      if (payload?.ok === false) throw new Error(String(payload.error ?? `the panel API replied ${response.status}`))
      if (!response.ok) throw new Error(`the panel API replied ${response.status}`)
      return payload
    }

    function publishVisibility(hidden) {
      if (!Array.isArray(hidden)) return
      globalThis.__dshModelSyncHidden = new Set(hidden.map((pair) => JSON.stringify(pair)))
      if (typeof globalThis.dispatchEvent === 'function') globalThis.dispatchEvent(new Event('dsh-model-sync:visibility'))
    }

    const FILTERS = [['all', '全部'], ['yes', '已显示'], ['no', '未显示']]
    const OTHER = '其他厂商'
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
    // Namespace aliases and recognizable unqualified model families. Versions
    // never become a group. Unknown unqualified ids share the fallback group.
    const FAMILIES = [
      ['ByteDance', /^(?:bytedance|byte[ -]dance|doubao)(?:[-_. ]|$)/],
      ['Anthropic', /^(?:anthropic|claude)(?:[-_.]|$)/],
      ['OpenAI', /^(?:openai|gpt(?:-oss)?|o[1-9])(?:[-_.]|$)/],
      ['Google', /^(?:google|gemini|gemma)(?:[-_.0-9]|$)/],
      ['DeepSeek', /^deepseek(?:[-_.]|$)/],
      ['Kimi', /^(?:moonshot(?:ai)?|kimi|k[23])(?:[-_.]|$)/],
      ['Qwen', /^(?:alibaba|qwen)(?:[-_.0-9]|$)/],
      ['xAI', /^(?:x-ai|xai|grok)(?:[-_.]|$)/],
      ['Meta', /^(?:meta(?:-llama)?|llama)(?:[-_.0-9]|$)/],
      ['Z.ai', /^(?:z-ai|zhipu(?:ai)?|glm|bigmodel)(?:[-_.0-9]|$)/],
      ['MiniMax', /^minimax(?:[-_.]|$)/],
      ['Mistral AI', /^(?:mistral(?:ai)?|codestral|devstral|magistral|ministral)(?:[-_.0-9]|$)/],
      ['Cohere', /^(?:cohere|command)(?:[-_.]|$)/],
      ['LongCat', /^(?:meituan|longcat)(?:[-_.]|$)/],
      ['IBM', /^(?:ibm|granite)(?:[-_.]|$)/],
      ['OpenRouter', /^openrouter$/],
    ]
    const SINGLE_VENDOR = [
      ['ByteDance', /^(?:bytedance|doubao)(?:[-_.]|$)/, /(?:^|\.)volces\.com$/],
      ['Kimi', /^(?:kimi|moonshot(?:ai)?)(?:[-_.]|$)/, /(?:^|\.)(?:moonshot\.(?:ai|cn)|kimi\.com)$/],
      ['DeepSeek', /^deepseek(?:[-_.]|$)/, /(?:^|\.)deepseek\.com$/],
      ['Anthropic', /^anthropic(?:[-_.]|$)/, /(?:^|\.)anthropic\.com$/],
      ['Google', /^(?:google|gemini)(?:[-_.]|$)/, /(?:^|\.)googleapis\.com$/],
      ['OpenAI', /^openai(?:[-_.]|$)/, /(?:^|\.)openai\.com$/],
      ['xAI', /^xai(?:[-_.]|$)/, /(?:^|\.)x\.ai$/],
      ['Qwen', /^(?:qwen|dashscope)(?:[-_.]|$)/, /(?:^|\.)dashscope\.aliyuncs\.com$/],
      ['MiniMax', /^minimax(?:[-_.]|$)/, /(?:^|\.)minimax\.(?:io|chat)$/],
    ]

    const CSS = `
      .dsh-ms {
        --ms-line:var(--dsw-alias-border-l1,#e2e7ee);
        --ms-muted:var(--dsw-alias-label-secondary,#606c7c);
        --ms-panel:var(--dsw-alias-bg-layer-2,#fff);
        --ms-soft:var(--dsw-alias-bg-module-platform,#f6f8fb);
        --ms-blue:#376bda;
        --ms-card-head:color-mix(in srgb,var(--ms-blue) 10%,var(--ms-panel));
        --ms-link:var(--dsw-alias-state-business-primary,#2559ca);
        --ms-ok:var(--dsw-alias-state-success-primary,#16714c);
        --ms-warn:var(--dsw-alias-state-warn-label,#895629);
        --ms-error:var(--dsw-alias-state-error-primary,#a33529);
        height:100%; min-height:330px; display:grid; gap:8px;
        grid-template-rows:auto minmax(0,1fr); container-type:inline-size;
      }
      .dsh-ms *, .dsh-ms *::before, .dsh-ms *::after { box-sizing:border-box; }
      .dsh-ms h2, .dsh-ms h3, .dsh-ms p { margin:0; }
      .dsh-ms h2 { font-size:24px; line-height:32px; }
      .dsh-ms button, .dsh-ms input { font:inherit; color:inherit; }
      .dsh-ms button:not(:disabled) { cursor:pointer; }
      .dsh-ms button:focus-visible, .dsh-ms input:focus-visible { outline:2px solid var(--ms-link); outline-offset:2px; }
      .dsh-ms .head { display:grid; gap:9px; }
      .dsh-ms .primary:not(:disabled) { background:var(--ms-blue); color:white; }
      .dsh-ms .intro, .dsh-ms .summary, .dsh-ms .clip { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .dsh-ms .intro { height:20px; line-height:20px; font-size:12px; color:var(--ms-muted); }
      .dsh-ms .proxy { height:60px; display:flex; justify-content:space-between; align-items:center; gap:9px;
        padding:6px 12px; border:1px solid var(--ms-line); border-radius:9px; background:var(--ms-soft); }
      .dsh-ms .proxy strong, .dsh-ms .proxy small { display:block; }
      .dsh-ms .proxy strong { font-size:13px; }
      .dsh-ms .proxy small { color:var(--ms-muted); font-size:11px; }
      .dsh-ms .actions { display:flex; align-items:center; gap:6px; flex:none; }
      .dsh-ms .switch { width:40px; height:23px; padding:3px; border:0; border-radius:999px;
        display:flex; align-items:center; background:#79869a; }
      .dsh-ms .switch[aria-checked=true] { background:var(--ms-blue); justify-content:flex-end; }
      .dsh-ms .switch span { width:17px; height:17px; border-radius:50%; background:white; box-shadow:0 1px 2px #18202b35; }
      .dsh-ms .toolbar { height:33px; display:flex; justify-content:space-between; align-items:center; gap:6px; }
      .dsh-ms .summary { color:var(--ms-muted); font-size:11px; }
      .dsh-ms .btn { height:30px; border:1px solid var(--ms-line); border-radius:7px; padding:0 8px;
        color:inherit; background:var(--ms-panel); white-space:nowrap; font-size:12px; }
      .dsh-ms .btn.primary:not(:disabled) { border-color:var(--ms-blue); }
      .dsh-ms .btn:disabled, .dsh-ms .link:disabled, .dsh-ms .switch:disabled { opacity:.55; }
      .dsh-ms .link { border:0; background:none; color:var(--ms-link); border-radius:4px; padding:3px;
        font-size:12px; white-space:nowrap; }
      .dsh-ms .pane { min-height:0; display:grid; gap:7px; grid-template-rows:38px minmax(0,1fr) 44px; }
      .dsh-ms .filter-bar { display:flex; align-items:center; gap:7px; }
      .dsh-ms .search { flex:1; min-width:0; }
      .dsh-ms .search input { width:100%; height:33px; border:1px solid var(--ms-line); border-radius:7px;
        padding:0 9px; font-size:12px; background:var(--ms-panel); }
      .dsh-ms .filter { height:30px; border:1px solid transparent; border-radius:7px; padding:0 7px;
        color:var(--ms-muted); font-size:12px; background:none; white-space:nowrap; }
      .dsh-ms .filter[aria-pressed=true] { background:var(--ms-soft); border-color:var(--ms-line); color:var(--ms-link); font-weight:600; }
      .dsh-ms .list { min-height:0; overflow:auto; scrollbar-gutter:stable; display:grid; gap:8px; align-content:start; padding:2px; }
      .dsh-ms .provider { min-width:0; border:1px solid var(--ms-line); border-radius:9px; background:var(--ms-panel); }
      .dsh-ms .provider-head { width:100%; height:42px; display:flex; align-items:center; gap:8px; text-align:left;
        border:0; border-radius:8px; padding:0 10px; background:var(--ms-card-head); }
      .dsh-ms .provider-head[aria-expanded=true] { border-radius:8px 8px 0 0; }
      .dsh-ms .provider-head:hover { background:color-mix(in srgb,var(--ms-blue) 15%,var(--ms-panel)); }
      .dsh-ms .provider-head strong { font-size:14px; }
      .dsh-ms .provider-head small { font-size:11px; color:var(--ms-muted); }
      .dsh-ms .provider-head .count { margin-inline-start:auto; flex:none; font-size:11px; color:var(--ms-muted); }
      .dsh-ms .provider-body { border-top:1px solid var(--ms-line); padding:8px; }
      .dsh-ms .provider-tools { display:flex; align-items:center; justify-content:space-between; gap:6px; min-height:26px; padding:0 0 4px; }
      .dsh-ms .groups.mixed { column-count:2; column-gap:8px; }
      .dsh-ms .groups.single { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; align-items:start; }
      .dsh-ms .vendor { min-width:0; border:1px solid var(--ms-line); background:var(--ms-panel); border-radius:8px; overflow:hidden; }
      .dsh-ms .mixed .vendor { break-inside:avoid; margin-bottom:8px; }
      .dsh-ms .vendor h3 { display:flex; align-items:center; gap:6px; min-height:30px; padding:0 8px; background:var(--ms-card-head); font-size:12px; font-weight:650; }
      .dsh-ms .vendor h3 small { margin-inline-start:auto; color:var(--ms-muted); font-weight:400; white-space:nowrap; }
      .dsh-ms .model { display:grid; grid-template-columns:14px minmax(0,1fr) auto; align-items:center; gap:6px;
        height:40px; margin:0 8px; border-top:1px solid var(--ms-line); }
      .dsh-ms .single .model:first-child { border-top:0; }
      .dsh-ms .model input, .dsh-ms .vendor input { width:13px; height:13px; margin:0; accent-color:var(--ms-blue); }
      .dsh-ms .model .name { font-size:12px; font-weight:560; line-height:16px; }
      .dsh-ms .model .name small { display:block; color:var(--ms-muted); font-size:10px; font-weight:400; }
      .dsh-ms .badge { flex:none; padding:1px 4px; border-radius:4px; font-size:10px; white-space:nowrap;
        background:var(--ms-panel); color:var(--ms-muted); }
      .dsh-ms .badge.changed { color:var(--ms-link); }
      .dsh-ms .badge.blocked { color:var(--ms-warn); }
      .dsh-ms .notice { padding:12px 3px; font-size:12px; color:var(--ms-muted); }
      .dsh-ms .foot { border-top:1px solid var(--ms-line); display:flex; align-items:center; justify-content:space-between; gap:6px; }
      .dsh-ms .foot .link, .dsh-ms .foot .btn { font-size:11px; }
      .dsh-ms .foot .failed { color:var(--ms-error); }
      .dsh-ms .check-popover, .dsh-ms .detail-popover { position:fixed; inset:auto; margin:0; width:min(320px,calc(100vw - 20px));
        max-height:calc(100vh - 20px); overflow:auto; padding:12px 14px;
        border:1px solid var(--ms-line); border-radius:10px; background:var(--ms-panel);
        color:var(--dsw-alias-label-primary,#18202b); box-shadow:0 9px 29px #18202b30; font-size:12px; }
      .dsh-ms .popover-head { display:flex; justify-content:space-between; align-items:center; }
      .dsh-ms [popover] h3 { font-size:14px; }
      .dsh-ms [popover] dl { margin:8px 0; display:grid; gap:6px; }
      .dsh-ms [popover] dl div { display:flex; justify-content:space-between; gap:10px; }
      .dsh-ms [popover] dt, .dsh-ms [popover] dd { overflow-wrap:anywhere; min-width:0; }
      .dsh-ms [popover] dd { margin:0; color:var(--ms-muted); text-align:right; }
      .dsh-ms [popover] p { margin:6px 0; overflow-wrap:anywhere; }
      .dsh-ms .detail-popover section + section { border-top:1px solid var(--ms-line); padding-top:8px; margin-top:10px; }
      .dsh-ms .detail-popover .actions { flex-wrap:wrap; }
      .dsh-ms .ok { color:var(--ms-ok); } .dsh-ms .warn { color:var(--ms-warn); }
      .dsh-ms .tabs { height:34px; display:flex; align-items:center; gap:18px; border-bottom:1px solid var(--ms-line); }
      .dsh-ms .tab { position:relative; height:34px; border:0; background:none; padding:0 2px; color:var(--ms-muted); font-size:13px; }
      .dsh-ms .tab[aria-selected=true] { color:var(--dsw-alias-label-primary,#18202b); font-weight:650; }
      .dsh-ms .tab[aria-selected=true]::after { content:''; position:absolute; left:0; right:0; bottom:-1px; height:2px; background:var(--ms-blue); border-radius:2px; }
      .dsh-ms .tab-count { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; margin-inline-start:5px;
        padding:0 5px; border-radius:999px; background:var(--ms-blue); color:#fff; font-size:10px; font-weight:600; vertical-align:1px; }
      .dsh-ms .review-tab-panel { min-height:0; height:100%; }
      .dsh-ms .review-page { display:grid; grid-template-rows:auto auto auto minmax(0,1fr); gap:7px; min-height:0; height:100%; }
      .dsh-ms .review-intro h3 { font-size:14px; margin-bottom:3px; }
      .dsh-ms .review-intro p, .dsh-ms .review-intro div { color:var(--ms-muted); font-size:12px; }
      .dsh-ms .review-intro div { display:flex; align-items:center; flex-wrap:wrap; gap:2px 8px; position:relative; }
      .dsh-ms .review-help { display:inline-flex; position:relative; }
      .dsh-ms .review-help-tag { color:var(--ms-link); padding:1px 6px; border:1px solid var(--ms-line); border-radius:5px; background:var(--ms-soft); font-size:11px; }
      .dsh-ms .review-help-content:not([hidden]) { display:grid; gap:6px; }
      .dsh-ms .review-help-content { position:absolute; inset-block-start:100%; inset-inline-end:0; width:min(340px,calc(100cqw - 10px)); z-index:5; padding:8px; background:var(--ms-panel); color:var(--dsw-alias-label-primary,#18202b); border:1px solid var(--ms-line); border-radius:7px; box-shadow:0 6px 18px #0003; line-height:1.5; }
      .dsh-ms .review-help-content b { margin-inline-end:5px; }
      .dsh-ms .review-filters, .dsh-ms .review-options, .dsh-ms .review-savebar { display:flex; flex-wrap:wrap; gap:5px; align-items:center; min-width:0; }
      .dsh-ms .review-savebar { justify-content:space-between; }
      .dsh-ms .review-filters input, .dsh-ms .review-field input[type=number] { background:var(--ms-panel); color:inherit; border:1px solid var(--ms-line); border-radius:7px; padding:5px 7px; font-size:12px; min-width:0; }
      .dsh-ms .review-filters input { flex:1 1 145px; height:30px; }
      .dsh-ms .review-filters select { max-width:100%; }
      .dsh-ms .review-field-filters { display:grid; grid-template-columns:minmax(0,1.5fr) repeat(4,minmax(0,1fr)); }
      .dsh-ms .review-field-filters input, .dsh-ms .review-field-filters select { width:100%; min-width:0; }
      .dsh-ms .review-field-filters select { padding-inline:5px; text-overflow:ellipsis; }
      .dsh-ms .review-workspace { display:grid; grid-template-columns:minmax(245px,.82fr) minmax(0,1.55fr); grid-template-rows:minmax(0,1fr); min-height:0; border:1px solid var(--ms-line); border-radius:8px; overflow:hidden; background:var(--ms-panel); }
      .dsh-ms .review-sidebar, .dsh-ms .review-detail { min-height:0; min-width:0; display:grid; }
      .dsh-ms .review-sidebar { grid-template-rows:auto minmax(0,1fr); border-inline-end:1px solid var(--ms-line); }
      .dsh-ms .review-sidebar > h4 { font-size:11px; margin:0; padding:8px 9px; border-bottom:1px solid var(--ms-line); background:var(--ms-soft); }
      .dsh-ms .review-detail { grid-template:"body" minmax(0,1fr) "save" auto / minmax(0,1fr); }
      .dsh-ms .review-list, .dsh-ms .review-detail-body, .dsh-ms .review-history-list { min-height:0; overflow:auto; overscroll-behavior:contain; }
      .dsh-ms .review-list, .dsh-ms .review-history-list { scrollbar-gutter:stable; }
      .dsh-ms .review-list { padding:4px; }
      .dsh-ms .review-model { width:100%; height:61px; display:grid; grid-template-rows:16px 12px 19px; gap:1px; padding:4px 7px; margin:0 0 2px; overflow:hidden; text-align:start; color:inherit; border:1px solid transparent; border-radius:6px; background:none; }
      .dsh-ms .review-model:hover { background:var(--ms-soft); }
      .dsh-ms .review-model[aria-pressed=true] { border-color:var(--ms-blue); background:var(--ms-card-head); }
      .dsh-ms .review-model-top, .dsh-ms .review-model-meta { display:flex; align-items:center; justify-content:space-between; gap:6px; min-width:0; }
      .dsh-ms .review-model-top strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; line-height:16px; }
      .dsh-ms .review-model > code { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ms-muted); font-size:9px; line-height:12px; }
      .dsh-ms .review-model-provider { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ms-muted); font-size:10px; line-height:19px; }
      .dsh-ms .review-model-badges { flex:none; flex-wrap:nowrap; gap:4px; }
      .dsh-ms .review-current { flex:none; max-width:112px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ms-warn); font-size:10px; line-height:16px; }
      .dsh-ms .review-current.normal { color:var(--ms-ok); }
      .dsh-ms .review-current.gateway { color:var(--ms-error); }
      .dsh-ms .review-field-note { font-size:11px; line-height:14px; color:var(--ms-muted); overflow-wrap:anywhere; }
      .dsh-ms .review-detail-body { grid-area:body; padding:5px 8px; display:grid; gap:3px; align-content:start; }
      .dsh-ms .review-detail-body h4 { font-size:12px; line-height:16px; margin:0; }
      .dsh-ms .review-detail-body .meta-banner { padding:3px 6px; line-height:14px; overflow-wrap:anywhere; }
      .dsh-ms .review-detail .review-savebar { grid-area:save; padding:3px 8px; border-top:1px solid var(--ms-line); background:var(--ms-soft); }
      .dsh-ms .review-field-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; gap:7px; overflow-wrap:anywhere; }
      .dsh-ms .review-field { display:grid; align-content:start; gap:2px; min-width:0; }
      .dsh-ms .review-field > label { font-size:12px; line-height:16px; }
      .dsh-ms .review-field small { color:var(--ms-muted); }
      .dsh-ms .review-field input[type=number] { display:block; width:100%; height:23px; margin-top:2px; padding-block:2px; }
      .dsh-ms .review-field-section { padding-block-start:4px; border-top:1px solid var(--ms-line); }
      .dsh-ms .review-choice-field { border-top:1px solid var(--ms-line); padding-top:3px; }
      .dsh-ms .review-field-caption, .dsh-ms .review-choice-context { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 7px; }
      .dsh-ms .review-choice-field .review-options { gap:2px; }
      .dsh-ms .review-option { display:inline-flex; align-items:center; gap:2px; padding:0 2px; border:1px solid var(--ms-line); border-radius:5px; font-size:11px; line-height:16px; white-space:nowrap; }
      .dsh-ms .review-option:has(input:checked) { background:var(--ms-card-head); }
      .dsh-ms .review-option input { width:11px; height:11px; margin:0; accent-color:var(--ms-blue); }
      .dsh-ms .review-detail-body .link { padding:0 2px; font-size:11px; line-height:16px; }
      .dsh-ms .review-candidate { display:flex; align-items:baseline; flex-wrap:wrap; column-gap:3px; }
      .dsh-ms .review-detail-actions { gap:2px 5px; }
      .dsh-ms .review-detail-actions > p { margin-inline-end:auto; }
      .dsh-ms .review-notice { color:var(--ms-ok); }
      .dsh-ms .review-history { grid-template-rows:auto auto minmax(0,1fr); }
      .dsh-ms .history-entry { margin:0 0 7px; overflow-wrap:anywhere; }
      .dsh-ms .history-entry summary, .dsh-ms .history-entry > div { padding:8px; }
      .dsh-ms .history-entry summary > span { margin-inline-end:6px; }
      .dsh-ms .review-back { display:none; }
      @container (max-width:510px) {
        .dsh-ms .review-help { position:static; }
        .dsh-ms .review-help-content { inset-inline:0 auto; }
        .dsh-ms .review-workspace { grid-template-columns:minmax(0,1fr); }
        .dsh-ms .review-workspace:not([data-detail]) .review-detail, .dsh-ms .review-workspace[data-detail] .review-sidebar { display:none; }
        .dsh-ms .review-detail { grid-template:"back" auto "body" minmax(0,1fr) "save" auto / minmax(0,1fr); }
        .dsh-ms .review-back { display:block; grid-area:back; justify-self:start; margin:3px 6px 0; }
      }
      @container (max-width:440px) {
        .dsh-ms .review-field-filters { grid-template-columns:repeat(4,minmax(0,1fr)); }
        .dsh-ms .review-field-filters input { grid-column:1 / -1; }
      }
      @container (max-width:340px) {
        .dsh-ms .review-field-filters { grid-template-columns:repeat(2,minmax(0,1fr)); }
      }
      .dsh-ms .meta-banner { border:1px solid color-mix(in srgb,var(--ms-warn) 28%,var(--ms-line)); background:color-mix(in srgb,var(--ms-warn) 7%,var(--ms-panel));
        border-radius:8px; padding:9px 11px; color:var(--ms-warn); font-size:11px; line-height:17px; }
      .dsh-ms .meta-select { height:31px; border:1px solid var(--ms-line); border-radius:7px; padding:0 7px; background:var(--ms-panel); font-size:12px; color:inherit; }
      .dsh-ms .meta-card { border:1px solid var(--ms-line); border-radius:9px; background:var(--ms-panel); overflow:hidden; }
      .dsh-ms .meta-tag { display:inline-flex; align-items:center; height:17px; padding:0 5px; border-radius:4px; background:var(--ms-panel); color:var(--ms-muted); font-size:10px; white-space:nowrap; }
      .dsh-ms .meta-tag.warn { color:var(--ms-warn); background:color-mix(in srgb,var(--ms-warn) 10%,var(--ms-panel)); }
      .dsh-ms .meta-tag.blue { color:var(--ms-link); background:color-mix(in srgb,var(--ms-blue) 10%,var(--ms-panel)); }
      .dsh-ms .meta-tag.ok { color:var(--ms-ok); background:color-mix(in srgb,var(--ms-ok) 9%,var(--ms-panel)); }
      @container (max-width:450px) {
        .dsh-ms .groups.mixed { column-count:1; }
        .dsh-ms .groups.single { grid-template-columns:minmax(0,1fr); }
        .dsh-ms .summary:has(+ .actions) { display:none; }
        .dsh-ms .provider-head .route { display:none; }
        .dsh-ms .foot .actions { gap:3px; }
      }
      @container (max-width:340px) {
        .dsh-ms .btn, .dsh-ms .filter { padding-inline:4px; }
        .dsh-ms .proxy, .dsh-ms .actions { gap:3px; }
        .dsh-ms .proxy { padding-inline:6px; }
        .dsh-ms .provider-head { gap:4px; padding-inline:6px; }
      }
    `

    function nameOf(row) {
      return row.displayName || row.name || row.provider
    }

    function formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.valueOf())) return String(value)
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(date)
    }

    function vendorOf(id) {
      const key = id.toLowerCase()
      const slash = key.indexOf('/')
      // OpenRouter's aliases use a leading tilde on the manufacturer's slug.
      const prefix = (slash > 0 ? key.slice(0, slash) : key).replace(/^~/, '')
      return FAMILIES.find(([, match]) => match.test(prefix))?.[0] ?? (slash > 0 ? prefix : OTHER)
    }

    function singleVendor(row, groups) {
      let host = ''
      try { host = new URL(row.baseURL).hostname } catch {}
      if (/^(?:openrouter|opencode(?:-go)?)(?:[-_.]|$)/i.test(row.provider) || /(?:^|\.)(?:openrouter|opencode)\.ai$/.test(host)) {
        return undefined
      }
      return SINGLE_VENDOR.find(([, route, domain]) => route.test(row.provider.toLowerCase()) || domain.test(host))?.[0]
        ?? (groups.size === 1 ? groups.values().next().value : undefined)
    }

    function button(label, onClick, options = {}) {
      return h('button', { type: 'button', className: 'btn', onClick, ...options }, label)
    }

    function link(label, onClick, options = {}) {
      return button(label, onClick, { className: 'link', ...options })
    }

    function positionPopover(panel, source) {
      if (!panel?.matches(':popover-open') || !source?.isConnected) return
      const anchor = source.getBoundingClientRect()
      const top = anchor.bottom + 6
      const below = window.innerHeight - top - 10
      const above = anchor.top - 16
      const openBelow = below >= Math.min(panel.scrollHeight, 200) || below >= above
      panel.style.left = `${Math.max(10, Math.min(anchor.left, window.innerWidth - panel.offsetWidth - 10))}px`
      panel.style.maxHeight = `${Math.max(0, Math.min(360, openBelow ? below : above))}px`
      panel.style.top = `${openBelow ? top : anchor.top - panel.offsetHeight - 6}px`
    }

    function ModelRow({ route, entry, onToggle }) {
      const { id, name, checked, change, blocked, reason, metadata } = entry
      const state = change ? (checked ? '待显示' : '待隐藏') : checked ? '已显示' : reason ? '暂不可选' : '未显示'
      const title = [name || id, reason, metadata?.description,
        metadata?.contextWindow ? `上下文窗口 ${metadata.contextWindow.toLocaleString()}` : '',
        metadata?.maxTokens ? `上游最大输出 ${metadata.maxTokens.toLocaleString()}` : '',
      ].filter(Boolean).join('\n')
      return h('label', { className: 'model', title, 'data-model': id },
        h('input', {
          type: 'checkbox', checked, disabled: blocked,
          'aria-label': `${nameOf(route)} ${name || id} 在对话中显示`,
          'aria-description': reason,
          onChange: (event) => onToggle(entry, event.target.checked),
        }),
        h('span', { className: 'name clip' }, name || id,
          name && name !== id ? h('small', { className: 'clip', title: id }, id) : null),
        h('span', { className: `badge ${change ? 'changed' : reason ? 'blocked' : ''}` }, state))
    }

    function VendorCard({ label, models, route, onToggle }) {
      const selectable = models.filter((model) => !model.blocked)
      const selected = selectable.filter(({ checked }) => checked).length
      return h('section', { className: 'vendor', 'data-vendor': label },
        label === undefined ? null : h('h3', null,
          selectable.length ? h('input', {
            ref: (node) => { if (node) node.indeterminate = selected > 0 && selected < selectable.length },
            type: 'checkbox', checked: selected === selectable.length,
            'aria-label': `在对话中显示 ${label} 当前筛选的模型`,
            onChange: (event) => onToggle(selectable, event.target.checked),
          }) : null,
          h('span', { className: 'clip', title: label }, label),
          h('small', null, `${models.length} 个模型`)),
        models.map((entry) => h(ModelRow, {
          key: entry.id, route, entry, onToggle: (model, value) => onToggle([model], value),
        })))
    }

    function ProviderCard({ row, models, expanded, onExpand, onToggle, onDetails, detailsOpen, selectionDisabled }) {
      const vendor = singleVendor(row, new Set(row.models.map(({ id }) => vendorOf(id))))
      const toSelect = row.models.filter((model) => !model.checked && !model.blocked)
      const toClear = row.models.filter((model) => model.checked && (!model.blocked || model.change))
      const filteredCandidates = models.length < row.models.length
        ? models.filter((model) => !model.checked && !model.blocked)
        : []
      const groups = new Map()
      for (const model of models) {
        const key = vendor ?? vendorOf(model.id)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(model)
      }
      const middle = Math.ceil(models.length / 2)
      const cards = vendor
        ? [models.slice(0, middle), models.slice(middle)].map((items, index) => ({ key: String(index), items }))
        : [...groups].sort(([a], [b]) => collator.compare(a, b)).map(([label, items]) => ({ key: label, label, items }))
      const count = row.models.filter((model) => model.baseline).length
      const check = row.sync?.check
      const status = row.unavailable ? '暂时无法读取' : row.sync && (
        check ? (STATUS_LABEL[check.status] || (check.complete === false ? '目录未读全' : '')) : '待检查')
      const counts = `已显示 ${count} / ${row.models.length} 个`
      return h('article', { className: 'provider', 'data-provider': row.provider },
        button([
          h('strong', { key: 'name', className: 'clip', title: nameOf(row) }, nameOf(row)),
          nameOf(row) === row.provider ? null : h('small', { key: 'route', className: 'route clip' }, row.provider),
          h('span', { key: 'count', className: 'count', title: status || undefined }, status ? `${counts} · ${status}` : counts),
          h('span', { key: 'arrow', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
        ], onExpand, { className: 'provider-head', 'aria-expanded': expanded }),
        expanded ? h('div', { className: 'provider-body' },
          h('div', { className: 'provider-tools' },
            h('div', { className: 'actions', role: 'group', 'aria-label': `${nameOf(row)} 的模型选择` },
              link('全选', () => onToggle(toSelect, true), {
                disabled: selectionDisabled || toSelect.length === 0,
                title: '勾选此供应商全部可选模型，包括筛选范围之外的模型',
              }),
              link('全不选', () => onToggle(toClear, false), {
                disabled: selectionDisabled || toClear.length === 0,
                title: '取消此供应商全部勾选，包括筛选范围之外的模型',
              }),
              filteredCandidates.length > 0
                ? link(`勾选筛选结果（${filteredCandidates.length}）`, () => onToggle(filteredCandidates, true))
                : null),
            row.sync ? link('维护与诊断', onDetails, { 'aria-expanded': detailsOpen, 'aria-controls': 'dsh-ms-details' }) : null),
          models.length === 0 ? h('p', { className: 'notice' }, '没有匹配的模型') : h('div', { className: `groups ${vendor ? 'single' : 'mixed'}` },
            cards.filter(({ items }) => items.length > 0).map(({ key, label, items }) => h(VendorCard, {
              key, label, models: items, route: row, onToggle,
            })))) : null)
    }

    function modelRoutes(view, catalog, drafts, disabled) {
      const configured = new Map((view?.providers ?? []).map((row) => [row.provider, row]))
      const local = new Map((catalog?.groups ?? []).map((row) => [row.provider, row]))
      const hidden = new Set((catalog?.hidden ?? view?.hidden ?? []).map((pair) => JSON.stringify(pair)))
      return [...new Set([...configured.keys(), ...local.keys()])].map((provider) => {
        const sync = configured.get(provider)
        const group = local.get(provider)
        const names = new Map(sync?.modelNames ?? [])
        for (const { id, name } of group?.models ?? []) if (name) names.set(id, name)
        const additions = new Map((sync?.check?.added ?? []).map((model) => [model.id, model]))
        const upstream = new Map((sync?.check?.catalog ?? []).map((model) => [model.id, model]))
        const installed = new Set([...(sync?.eagerIds ?? []), ...(group?.models ?? []).map(({ id }) => id)])
        const ignored = new Set(sync?.ignored ?? [])
        const models = [...new Set([...installed, ...upstream.keys(), ...additions.keys()])].map((id) => {
          const key = JSON.stringify([provider, id])
          const isInstalled = installed.has(id)
          const baseline = isInstalled && !hidden.has(key)
          const metadata = additions.get(id) ?? upstream.get(id)
          let reason
          if (!isInstalled) {
            if (ignored.has(id)) reason = '已忽略。可在「维护与诊断」清除忽略名单。'
            else if (sync?.catalogManaged) reason = '由账号目录管理。'
            else if (sync?.hasModelOverrides) reason = '此路由使用模型覆盖，请在 DSH「设置 → 模型」调整。'
            else if (sync?.check?.status !== 'ok' || !additions.has(id)) reason = '请先检查此供应商的上游目录。'
            else reason = metadata?.blocked
          }
          return {
            id, name: names.get(id) ?? metadata?.name, installed: isInstalled, baseline,
            checked: drafts.get(key)?.visible ?? baseline, change: drafts.has(key),
            blocked: disabled || reason !== undefined, reason, metadata,
          }
        })
        return { provider, displayName: sync?.displayName ?? group?.name, baseURL: sync?.baseURL, unavailable: group?.unavailable, sync, models }
      })
    }

    const REVIEW_FIELDS = {
      contextWindow: '上下文窗口', maxTokens: '最大输出', input: '输入模态', reasoningEfforts: '推理档位',
    }
    const INPUT_LABEL = { text: '文本', image: '图像', audio: '音频', video: '视频', pdf: 'PDF' }
    const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const REVIEW_LEVEL = { official: '官方', partial: '部分核实', unverified: '待核实' }
    const REVIEW_RANK = { unverified: 0, partial: 1, official: 2 }
    const REVIEW_ISSUE = { missing: '缺字段', conflict: '字段差异', route: '路由待确认', gateway: '网关未就绪', absent: '上游目录暂缺' }
    const REVIEW_ISSUE_HELP = {
      missing: '所需字段仍未确认；未知值保持空白，不猜测。',
      conflict: '当前配置、官方证据或已确认值之间存在差异。',
      route: '模型条目尚未满足当前路由的调用条件。',
      gateway: '该路由依赖网关，但当前网关未就绪。',
      absent: '本次完整官方目录没有列出该模型，现有配置保留。',
    }
    // `host` can also be a previously confirmed official-API value. Keep its
    // broader label instead of misattributing old ledger rows to the native catalog.
    const REVIEW_SOURCE = { official: '官方 API', 'models.dev': 'models.dev 精准匹配', user: '人工填写', host: '本机已确认' }
    const HISTORY_TYPE = { check: '检查更新', discovery: '目录发现', field: '字段变更', selection: '模型选择', decision: '人工处理' }
    const HISTORY_STATUS = { ok: '成功', error: '失败', 'no-endpoint': '跳过', adapter: 'DSH 内置目录' }
    const reviewKey = (model) => JSON.stringify([model.provider, model.id])

    function reviewFieldValue(field, value) {
      if (field === 'contextWindow' || field === 'maxTokens') return value === '' ? undefined : Number(value)
      return value
    }

    function sameReviewValue(left, right) {
      if (left === right) return true
      if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false
      const keys = Object.keys(left)
      return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
    }

    function reviewValue(value) {
      if (value == null) return '未设置'
      if (Array.isArray(value)) return value.map((mode) => INPUT_LABEL[mode] ?? mode).join('、')
      if (typeof value === 'object') return Object.keys(value).join('、')
      return typeof value === 'number' ? value.toLocaleString('zh-CN') : String(value)
    }

    function reviewSelect(label, value, onChange, options) {
      return h('select', { className: 'meta-select', 'aria-label': label, value, onChange: (event) => onChange(event.target.value) },
        options.map(([id, name]) => h('option', { key: id, value: id }, name)))
    }

    function ConfidenceHelp() {
      const [open, setOpen] = useState(false)
      return h('span', { className: 'review-help',
        onPointerEnter: (event) => { if (event.pointerType === 'mouse') setOpen(true) },
        onPointerLeave: (event) => { if (event.pointerType === 'mouse') setOpen(false) },
        onKeyDown: (event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false) } },
      }, button('可信度与数据来源 ⓘ', (event) => setOpen(event.nativeEvent?.pointerType === 'mouse' || !open), {
        className: 'review-help-tag', 'aria-expanded': open, 'aria-controls': 'dsh-ms-confidence-rules',
        onFocus: (event) => { if (event.currentTarget.matches(':focus-visible')) setOpen(true) }, onBlur: () => setOpen(false),
      }), h('span', { id: 'dsh-ms-confidence-rules', role: 'tooltip', className: 'review-help-content', hidden: !open },
        h('span', null, h('b', null, '官方'), '三项关键字段均与当前路由的官方 API 证据匹配，且没有未解决的字段冲突。'),
        h('span', null, h('b', null, '部分核实'), '已有部分字段证据，但尚未达到三项关键字段均为官方 API 的标准。'),
        h('span', null, h('b', null, '待核实'), '缺少可核验的字段来源，或仍有字段冲突。'),
        h('small', null, '五层数据来源：1. 官方 API；2. DSH 内置目录；3. models.dev 精准匹配；4. models.dev 泛化（仅辅助展示，不自动补数值）；5. 人工填写。'),
        h('small', null, '五层是统一表达口径，实际自动写入仍受字段缺失、人工保护和本次官方检查是否成功等规则约束。关键字段包括上下文窗口、最大输出和输入模态；信息状态与路由可用状态分别判断。')))
    }

    function MetadataTab({ view, working, act, error, refresh, drafts, setDrafts, jump, onHistory, onConnection }) {
      const [mode, setMode] = useState(jump?.id ? 'all' : 'pending')
      const [query, setQuery] = useState(jump?.id ?? '')
      const [provider, setProvider] = useState(jump?.provider ?? 'all')
      const [level, setLevel] = useState('all')
      const [kind, setKind] = useState('all')
      const [sort, setSort] = useState('recent')
      const [selected, setSelected] = useState(jump?.id ? reviewKey(jump) : '')
      const [detail, setDetail] = useState(Boolean(jump?.id))
      const [confirmation, setConfirmation] = useState(null)
      const [notice, setNotice] = useState(null)
      const list = useRef(null)
      const body = useRef(null)
      const models = view?.review?.models ?? []
      const providers = [...new Map(models.map((row) => [row.provider, row.displayName || row.provider]))]
      const search = query.trim().toLowerCase()
      const rows = models.filter((row) => (mode !== 'pending' || kind === 'none' || row.pending) && (mode !== 'edited' || row.edited) &&
        (provider === 'all' || provider === row.provider) && (level === 'all' || level === row.level) &&
        (kind === 'all' || (kind === 'none' ? row.issues.length === 0 : row.issues.some((issue) => issue.kind === kind))) &&
        [row.id, row.name, row.provider, row.displayName].filter(Boolean).join(' ').toLowerCase().includes(search))
      const compare = {
        recent: () => 0, name: (a, b) => collator.compare(a.name, b.name),
        provider: (a, b) => collator.compare(a.displayName || a.provider, b.displayName || b.provider),
        low: (a, b) => REVIEW_RANK[a.level] - REVIEW_RANK[b.level], high: (a, b) => REVIEW_RANK[b.level] - REVIEW_RANK[a.level],
      }[sort]
      rows.sort((a, b) => compare(a, b) || b.updatedAt - a.updatedAt || collator.compare(reviewKey(a), reviewKey(b)))
      const model = models.find((row) => selected && reviewKey(row) === selected) ?? rows[0]
      const key = model && reviewKey(model)
      const draft = drafts.get(key) ?? {}
      const dirty = Object.keys(draft).length > 0
      const chosen = (field) => Object.hasOwn(draft, field) ? draft[field].value : model.fields[field]?.value
      const choose = (field, value, useCandidate = false) => {
        const next = { ...draft }
        if (!useCandidate && sameReviewValue(reviewFieldValue(field, value), model.fields[field]?.value)) delete next[field]
        else next[field] = { value, useCandidate, candidateSource: useCandidate ? model.fields[field].candidateSource : undefined }
        setDrafts((current) => {
          const result = new Map(current)
          if (Object.keys(next).length) result.set(key, next)
          else result.delete(key)
          return result
        })
        setNotice(null)
      }
      const resetDraft = () => setDrafts((current) => { const next = new Map(current); next.delete(key); return next })
      const changeFilter = (setter) => (value) => {
        setter(value); setSelected(''); setDetail(false); setConfirmation(null); setNotice(null)
        if (list.current) list.current.scrollTop = 0
        if (body.current) body.current.scrollTop = 0
      }
      const openModel = (row) => {
        setSelected(reviewKey(row)); setDetail(true); setConfirmation(null); setNotice(null)
        if (body.current) body.current.scrollTop = 0
      }
      const plan = (decision) => {
        const changes = decision ? undefined : Object.fromEntries(Object.entries(draft).map(([field, row]) => [field, {
          ...row, value: reviewFieldValue(field, row.value),
        }]))
        const before = Object.fromEntries(Object.entries(changes ?? {}).map(([name]) => [name, model.fields[name].observed ?? model.fields[name].value]))
        setSelected(key)
        setConfirmation({ before, officialDifference: model.issues.some(({ kind }) => kind === 'conflict'),
          request: { provider: model.provider, routeKey: model.routeKey, id: model.id, revision: model.revision,
            reviewRevision: model.reviewRevision, fingerprint: model.fingerprint, changes, decision } })
        if (body.current) body.current.scrollTop = 0
      }
      const submit = async () => {
        const { request, officialDifference } = confirmation
        const result = await act('review-save', () => call('review-save', request))
        setConfirmation(null)
        if (!result) { await refresh().catch(() => {}); return }
        if (!request.decision) resetDraft()
        setNotice(request.decision === 'ignore' ? (officialDifference ? '已记录本次处理，官方值差异仍待确认' : '已忽略本次提醒')
          : request.decision === 'keep' ? '已保留并锁定当前值' : '已保存模型信息')
      }
      const revert = async () => {
        if (!globalThis.confirm?.('撤销本模型的自动补全？已确认的手动配置会保留。')) return
        const result = await act('metadata-revert', () => call('metadata-revert', { provider: model.provider, id: model.id }))
        if (result) setNotice(result.notice ?? '已撤销自动补全')
      }

      const badge = (row) => h('span', {
        className: `meta-tag ${row.level === 'official' ? 'ok' : row.level === 'partial' ? 'blue' : 'warn'}`,
        title: `信息状态：${REVIEW_LEVEL[row.level]}。只描述资料证据，不代表路由一定可调用。`,
      }, REVIEW_LEVEL[row.level])
      const currentStatus = (row) => {
        const primary = row.issues[0]
        if (!primary) return { label: '正常', kind: 'normal', title: '当前无字段、路由、网关或目录问题' }
        const title = row.issues.map((issue) => {
          const label = REVIEW_ISSUE[issue.kind] ?? issue.kind
          const field = issue.field ? ` · ${REVIEW_FIELDS[issue.field]}` : ''
          return `${label}${field}：${issue.text ?? REVIEW_ISSUE_HELP[issue.kind] ?? '请查看详情'}`
        }).join('\n')
        return {
          label: `${REVIEW_ISSUE[primary.kind] ?? primary.kind}${row.issues.length > 1 ? ` ＋${row.issues.length - 1}` : ''}`,
          kind: primary.kind,
          title,
        }
      }
      const fieldEvidence = (name) => {
        const field = model.fields[name]
        const candidate = field.candidate !== undefined && (field.observed !== undefined ||
          !sameReviewValue(field.candidate, field.value) || field.candidateSource !== field.source || field.locked)
        const source = field.source ? REVIEW_SOURCE[field.source] : '尚未确认'
        return {
          source: h('span', null, Object.hasOwn(draft, name) ? '待保存' : field.locked ? `已锁定 · ${source}` : source),
          candidate: candidate ? h('div', { className: 'review-candidate' },
            h('span', null, REVIEW_SOURCE[field.candidateSource]), h('span', null, reviewValue(field.candidate)),
            link('使用候选值', () => choose(name, field.candidate, true), { disabled: working })) : null,
          observed: field.observed !== undefined ? h('div', null, `当前配置 · ${reviewValue(field.observed)}`) : null,
        }
      }
      const numberField = (name) => {
        const { source, candidate, observed } = fieldEvidence(name)
        return h('div', { className: 'review-field', key: name },
          h('label', null, h('strong', null, REVIEW_FIELDS[name]), h('small', null, ' tokens'),
            h('input', { type: 'number', min: 1, step: 1, 'aria-label': REVIEW_FIELDS[name], placeholder: '尚未确认', value: chosen(name) ?? '',
              onChange: (event) => choose(name, event.target.value), disabled: working })),
          h('div', { className: 'review-field-note' }, source, candidate, observed))
      }
      const choiceField = (name, options, context) => {
        const { source, candidate, observed } = fieldEvidence(name)
        return h('section', { className: 'review-field review-choice-field', 'aria-label': REVIEW_FIELDS[name] },
          h('div', { className: 'review-field-caption' }, h('h4', null, REVIEW_FIELDS[name]), h('span', { className: 'review-field-note' }, source)),
          h('div', { className: 'review-options' }, options),
          candidate ? h('div', { className: 'review-field-note' }, candidate) : null,
          observed || context ? h('div', { className: 'review-field-note review-choice-context' }, observed, context) : null)
      }
      const inputModes = () => {
        const selectedModes = chosen('input') ?? []
        const options = Object.entries(INPUT_LABEL).map(([id, name]) =>
          h('label', { key: id, className: 'review-option' }, h('input', { type: 'checkbox', checked: selectedModes.includes(id), disabled: working,
            onChange: (event) => choose('input', Object.keys(INPUT_LABEL).filter((item) => item === id ? event.target.checked : selectedModes.includes(item))),
          }), name))
        const availability = selectedModes.length > 0 && reviewValue(selectedModes) !== reviewValue(model.inputAvailable)
          ? h('p', null, `当前对话可发送${(model.inputAvailable ?? []).length ? `：${reviewValue(model.inputAvailable)}` : '的模态尚未确认'}。`) : null
        return choiceField('input', options, availability)
      }
      const reasoning = () => {
        const previous = chosen('reasoningEfforts') ?? {}
        const options = EFFORT_LEVELS.map((id) =>
          h('label', { key: id, className: 'review-option' }, h('input', { type: 'checkbox', checked: Object.hasOwn(previous, id), disabled: working,
            onChange: (event) => {
              const next = { ...previous }
              if (event.target.checked) next[id] = model.fields.reasoningEfforts.value?.[id] ?? model.fields.reasoningEfforts.candidate?.[id] ?? id
              else delete next[id]
              choose('reasoningEfforts', next)
            },
          }), id))
        return choiceField('reasoningEfforts', options)
      }
      const issues = new Map()
      for (const { kind, field, text } of model?.issues ?? []) {
        const help = text ?? REVIEW_ISSUE_HELP[kind] ?? '请查看当前路由配置。'
        const key = JSON.stringify([kind, help])
        if (!issues.has(key)) issues.set(key, { label: REVIEW_ISSUE[kind] ?? kind, fields: [], help, detail: kind === 'conflict' ? text : help })
        if (field) issues.get(key).fields.push(REVIEW_FIELDS[field] ?? field)
      }
      const content = model ? h('div', { className: 'review-detail-body', ref: body },
        error ? h('p', { className: 'meta-banner', role: 'alert' }, error) : null,
        confirmation ? h(React.Fragment, null,
          h('h4', null, confirmation.request.decision === 'ignore' ? '忽略本次提醒' : confirmation.request.decision === 'keep' ? '保留当前配置' : '核对待保存配置'),
          h('p', { className: 'review-field-note' }, confirmation.request.decision ? '官方值与当前配置有差异时仍会提醒。' : '只更新当前供应商路由下这个模型的所选字段。'),
          ...Object.entries(confirmation.request.changes ?? {}).map(([name, change]) => h('section', { key: name, className: 'review-field-section' },
            h('h4', null, REVIEW_FIELDS[name]), change.useCandidate && sameReviewValue(confirmation.before[name], change.value)
              ? h('p', { className: 'review-field-note' }, `确认来源 · ${REVIEW_SOURCE[change.candidateSource]} · ${reviewValue(change.value)}`)
              : h('div', { className: 'review-field-grid' },
                h('div', null, h('small', null, '保存前'), h('p', null, reviewValue(confirmation.before[name]))),
                h('div', null, h('small', null, '保存后'), h('p', null, reviewValue(change.value),
                  change.useCandidate ? h('small', null, ` · ${REVIEW_SOURCE[change.candidateSource]}`) : null))))))
          : h(React.Fragment, null,
            notice ? h('p', { role: 'status', className: 'review-notice' }, notice, ' ', link('查看相关记录', () => onHistory(model))) : null,
            issues.size ? h('div', { className: 'meta-banner' }, [...issues].map(([key, { label, fields, help, detail }]) =>
              h('div', { key, title: help }, [label, fields.join('、'), detail].filter(Boolean).join(' · ')))) : null,
            model.canWrite ? null : h('p', { className: 'review-field-note' }, '此路由没有可写模型条目，可以保留草稿。'),
            h('div', { className: 'review-field-grid' }, ['contextWindow', 'maxTokens'].map(numberField)),
            inputModes(), reasoning(),
            h('div', { className: 'review-options review-detail-actions' },
              h('p', { className: 'review-field-note' }, model.protocol ? `调用协议 · ${model.protocol}` : '调用协议 · 继承当前路由'),
              model.keepable ? link('保留我的值', () => plan('keep'), { disabled: working }) : null,
              model.pending ? link('忽略本次', () => plan('ignore'), { disabled: working }) : null,
              model.canRevert ? link('撤销补全', revert, { disabled: working }) : null,
              model.issues.some((issue) => issue.kind === 'gateway') ? link('查看连接设置', onConnection) : null,
              link('查看相关记录', () => onHistory(model))))) : h('p', { className: 'notice' }, '筛选结果为空。')
      const footer = model && h('footer', { className: 'review-savebar' },
        h('span', { className: 'summary', role: 'status' }, confirmation ? '待确认' : dirty ? `${Object.keys(draft).length} 项${model.canWrite ? '待保存' : '草稿'}` : '无待保存变更'),
        h('div', { className: 'review-options' }, confirmation ? [button('返回配置', () => setConfirmation(null), { key: 'back', disabled: working }),
          button(confirmation.request.decision ? '确认处理' : '确认保存', submit, { key: 'confirm', className: 'btn primary', disabled: working })]
          : [button('放弃修改', resetDraft, { key: 'discard', disabled: working || !dirty }),
            button('预览并保存', () => plan(), { key: 'preview', className: 'btn primary', disabled: working || !dirty || !model.canWrite })]))

      return h('div', { className: 'review-page' },
        h('header', { className: 'review-intro' }, h('h3', null, '待确认模型信息'),
          h('div', null, h('span', null, '核对模型字段、来源和路由异常，再决定如何处理。'), h(ConfidenceHelp))),
        h('div', { className: 'review-filters review-field-filters' }, h('input', { type: 'search', value: query, placeholder: '搜索模型、ID 或供应商', 'aria-label': '搜索待确认模型', onChange: (event) => changeFilter(setQuery)(event.target.value) }),
          reviewSelect('筛选供应商', provider, changeFilter(setProvider), [['all','全部供应商'], ...providers]),
          reviewSelect('筛选可信度', level, changeFilter(setLevel), [['all','全部可信度'], ...Object.entries(REVIEW_LEVEL)]),
          reviewSelect('筛选当前状态', kind, changeFilter(setKind), [['all','全部状态'], ...Object.entries(REVIEW_ISSUE), ['none','正常（无当前问题）']]),
          reviewSelect('排序', sort, changeFilter(setSort), [['recent','最近更新'],['low','可信度从低到高'],['high','可信度从高到低'],['name','模型名称 A–Z'],['provider','供应商 A–Z']])),
        h('div', { className: 'review-savebar' }, h('div', { className: 'review-options' }, [['pending','待处理'],['all','全部模型信息'],['edited','我改过']].map(([id, label]) =>
          button(label, () => changeFilter(setMode)(id), { key: id, className: 'filter', 'aria-pressed': mode === id }))), h('span', { className: 'summary' }, `${rows.length} 个模型`)),
        h('div', { className: 'review-workspace', 'data-detail': detail || undefined },
          h('aside', { className: 'review-sidebar', 'aria-label': '模型列表' }, h('h4', null, '模型列表'),
            h('div', { className: 'review-list', ref: list }, rows.map((row) => {
              const status = currentStatus(row)
              const providerName = row.displayName || row.provider
              return h('button', {
                key: reviewKey(row), className: 'review-model', type: 'button',
                'aria-label': `${row.name}，当前状态：${status.label}，信息状态：${REVIEW_LEVEL[row.level]}`,
                'aria-pressed': key === reviewKey(row), onClick: () => openModel(row),
              },
                h('span', { className: 'review-model-top' },
                  h('strong', { title: row.name }, row.name),
                  h('span', { className: `review-current ${status.kind}`, title: status.title }, status.label)),
                h('code', { title: row.id }, row.id),
                h('span', { className: 'review-model-meta' },
                  h('span', { className: 'review-model-provider', title: providerName }, providerName),
                  h('span', { className: 'review-options review-model-badges' }, badge(row),
                    drafts.has(reviewKey(row)) ? h('span', { className: 'meta-tag blue' }, '草稿') : null)))
            }))),
          h('section', { className: 'review-detail', 'aria-label': '模型配置' },
            detail ? link('返回模型列表', () => setDetail(false), { className: 'link review-back' }) : null, content, footer)))
    }

    function HistoryTab({ view, jump, onModel }) {
      const [query, setQuery] = useState(jump?.id ?? '')
      const [provider, setProvider] = useState(jump?.provider ?? 'all')
      const [type, setType] = useState('all')
      const providers = [...new Map((view?.providers ?? []).map((row) => [row.provider, row.displayName || row.provider]))]
      const label = new Map(providers)
      const models = new Set((view?.review?.models ?? []).map(reviewKey))
      const search = query.trim().toLowerCase()
      const rows = (view?.review?.history ?? []).filter((row) => (provider === 'all' || provider === row.provider) &&
        (type === 'all' || type === row.type) && [row.title, row.provider, row.model].filter(Boolean).join(' ').toLowerCase().includes(search))
      return h('div', { className: 'review-page review-history' },
        h('header', { className: 'review-intro' }, h('h3', null, '同步历史'), h('p', null, '查看目录检查、字段变更和模型选择的结果。')),
        h('div', { className: 'review-filters' }, h('input', { type: 'search', value: query, placeholder: '搜索模型 ID 或记录', 'aria-label': '搜索同步记录', onChange: (event) => setQuery(event.target.value) }),
          reviewSelect('筛选供应商', provider, setProvider, [['all','全部供应商'], ...providers]),
          reviewSelect('筛选记录类型', type, setType, [['all','全部类型'], ...Object.entries(HISTORY_TYPE)])),
        h('div', { className: 'review-history-list' }, rows.length ? rows.map((row, index) => {
          const model = { provider: row.provider, id: row.model }
          return h('details', { className: 'meta-card history-entry', key: `${row.at}:${row.provider}:${index}`, open: jump?.id !== undefined && index === 0 || undefined },
            h('summary', null, h('span', null, formatTime(row.at)), h('span', { className: 'meta-tag' }, HISTORY_TYPE[row.type]),
              h('span', { className: 'meta-tag' }, label.get(row.provider) ?? row.provider), HISTORY_STATUS[row.status] ? h('span', { className: 'meta-tag' }, HISTORY_STATUS[row.status]) : null,
              h('strong', null, row.title)),
            h('div', null, row.model ? h('code', null, row.model) : null,
              row.field && (row.from !== undefined || row.to !== undefined) ? h('p', null, `${REVIEW_FIELDS[row.field] ?? row.field} · ${reviewValue(row.from)} → ${reviewValue(row.to)}`) : null,
              row.model && models.has(reviewKey(model)) ? link('查看模型信息', () => onModel(model)) : null))
        }) : h('p', { className: 'notice' }, '没有符合条件的同步记录。')))
    }

    function Panel(props) {
      const [view, setView] = useState(props?.view ?? null)
      const [catalog, setCatalog] = useState(null)
      const [catalogError, setCatalogError] = useState('')
      const [expanded, setExpanded] = useState(props?.expandedProvider ?? null)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [drafts, setDrafts] = useState(new Map())
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [details, setDetails] = useState(null)
      const [confirmingRevoke, setConfirmingRevoke] = useState(false)
      const [tab, setTab] = useState('manage')
      const [reviewDrafts, setReviewDrafts] = useState(() => new Map())
      const [reviewJump, setReviewJump] = useState(null)
      const [historyJump, setHistoryJump] = useState(null)
      const selfCheckTrigger = useRef(null)
      const selfCheckPopover = useRef(null)
      const detailsPopover = useRef(null)
      const detailsOrigin = useRef(null)
      const hoverTimer = useRef(null)
      const pinned = useRef(false)
      const list = useRef(null)
      const working = busy !== ''
      const integrated = globalThis.__dshModelSyncSelectorVersion === 1

      const refreshDisplay = useCallback(async () => {
        try {
          const payload = await call('display-models')
          setCatalog(payload)
          setCatalogError('')
          publishVisibility(payload.hidden)
        } catch (err) {
          setCatalogError(err.message)
        }
      }, [])

      const refresh = useCallback(async () => {
        const payload = await call('view')
        setView(payload.view)
        return payload.view
      }, [])

      useEffect(() => {
        void refresh().catch((err) => setError(err.message))
        void refreshDisplay()
      }, [refresh, refreshDisplay])

      const act = async (label, run) => {
        if (working) return undefined
        setBusy(label)
        setError('')
        setMessage('')
        try {
          const payload = await run()
          if (payload?.view) setView(payload.view)
          else await refresh()
          if (label === 'check') await refreshDisplay()
          if (label === 'check' && payload?.sync !== undefined) {
            const counts = payload.sync?.fields ?? {}
            const updated = payload.sync?.updated ?? counts.updated ?? 0
            const promoted = counts.promoted ?? 0
            const adopted = counts.adopted ?? 0
            const incomplete = new Map((payload.sync.incomplete ?? []).map(({ provider, reason }) => [provider, reason]))
            const results = Array.isArray(payload.results) ? payload.results : []
            const failed = results.filter((row) => row.status !== 'ok' || row.complete === false || incomplete.has(row.provider))
            const outcome = failed.length === 0 ? '检查完成' : failed.length === results.length ? '检查未全部完成' : '部分检查完成'
            const details = failed.map((row) => {
              const name = nameOf(view?.providers?.find(({ provider }) => provider === row.provider) ?? row)
              const reason = incomplete.get(row.provider) ?? (row.status === 'no-endpoint' ? '没有目录端点' : row.status === 'ok' ? '目录未读全' : '目录检查失败')
              return `${name}（${reason}）`
            })
            const progress = `更新 ${updated} 个字段，确认 ${promoted} 项来源，采纳 ${adopted} 项当前配置`
            setMessage(`${outcome}：${progress}。${details.length ? `未完成：${details.join('、')}。` : ''}对话显示选择不变。`)
          }
          return payload
        } catch (err) {
          setError(err.message)
          return undefined
        } finally {
          setBusy('')
        }
      }

      const positionSelfCheck = () => positionPopover(selfCheckPopover.current, selfCheckTrigger.current)
      const positionDetails = () => positionPopover(detailsPopover.current, detailsOrigin.current)
      useEffect(() => {
        const reposition = () => {
          positionSelfCheck()
          positionDetails()
        }
        // Settings also listens for Escape on the document. Close the open
        // popover first so dismissing it keeps the current settings section.
        const dismissPopover = (event) => {
          if (event.key !== 'Escape') return
          const panel = [detailsPopover.current, selfCheckPopover.current].find((node) => node?.matches(':popover-open'))
          if (!panel) return
          event.preventDefault()
          event.stopPropagation()
          panel.hidePopover()
        }
        window.addEventListener?.('resize', reposition)
        window.addEventListener?.('keydown', dismissPopover, true)
        return () => {
          window.removeEventListener?.('resize', reposition)
          window.removeEventListener?.('keydown', dismissPopover, true)
          clearTimeout(hoverTimer.current)
        }
      }, [])
      useEffect(() => { positionDetails() }, [details, view, error])

      const toggleSelfCheck = () => {
        selfCheckPopover.current?.togglePopover({ source: selfCheckTrigger.current })
        positionSelfCheck()
      }

      const runSelfCheck = async () => {
        const result = await act('selfcheck', () => call('selfcheck', {}))
        if (result && selfCheckTrigger.current) {
          selfCheckPopover.current?.showPopover({ source: selfCheckTrigger.current })
          positionSelfCheck()
        }
      }

      const cancelHoverClose = () => clearTimeout(hoverTimer.current)
      const closeDetails = () => {
        cancelHoverClose()
        detailsPopover.current?.hidePopover()
      }
      const queueHoverClose = () => {
        cancelHoverClose()
        if (!pinned.current) hoverTimer.current = setTimeout(closeDetails, 180)
      }
      const openDetails = (event, kind, provider, pin = true) => {
        const source = event?.currentTarget
        if (!source || (!pin && pinned.current)) return
        cancelHoverClose()
        const panel = detailsPopover.current
        if (pin && pinned.current && detailsOrigin.current === source && panel?.matches(':popover-open')) {
          closeDetails()
          return
        }
        detailsOrigin.current = source
        pinned.current = pin
        setConfirmingRevoke(false)
        setDetails({ kind, provider })
        selfCheckPopover.current?.hidePopover()
        panel?.showPopover({ source })
        positionDetails()
      }

      const routes = modelRoutes(view, catalog, drafts, working || !integrated)
      const search = query.trim().toLowerCase()
      const filtered = routes.map((row) => ({
        row,
        models: row.models.filter((model) => (
          (search === '' || `${nameOf(row)} ${row.provider} ${model.name ?? ''} ${model.id} ${vendorOf(model.id)}`.toLowerCase().includes(search))
          && (filter === 'all' || model.baseline === (filter === 'yes'))
        )).sort((a, b) => collator.compare(a.name || a.id, b.name || b.id)),
      })).filter(({ row, models }) => models.length > 0 || row.unavailable)

      const onToggle = (provider, entries, visible) => {
        setMessage('')
        setError('')
        setDrafts((current) => {
          const next = new Map(current)
          for (const { id, baseline, installed } of entries) {
            const key = JSON.stringify([provider, id])
            if (visible === baseline) next.delete(key)
            else next.set(key, { provider, id, installed, visible })
          }
          return next
        })
      }

      const saveModels = async () => {
        setBusy('save')
        setError('')
        setMessage('')
        const plan = new Map()
        for (const [key, change] of drafts) {
          if (!plan.has(change.provider)) plan.set(change.provider, { keys: [], ids: [], pickerChanges: [] })
          const row = plan.get(change.provider)
          row.keys.push(key)
          if (change.installed) row.pickerChanges.push({ id: change.id, visible: change.visible })
          else row.ids.push(change.id)
        }
        const failures = []
        let saved = 0
        try {
          for (const [provider, { keys, ids, pickerChanges }] of plan) {
            try {
              const result = ids.length > 0
                ? await call('apply', { provider, ids, removeIds: [], showInPicker: true, pickerChanges })
                : await call('visibility', { changes: pickerChanges.map((change) => ({ provider, ...change })) })
              saved += keys.length
              setCatalog((current) => current && { ...current, hidden: result.hidden })
              publishVisibility(result.hidden)
              setDrafts((current) => {
                const next = new Map(current)
                for (const key of keys) next.delete(key)
                return next
              })
            } catch (err) {
              failures.push(`${nameOf(routes.find((row) => row.provider === provider) ?? { provider })}：${err.message}`)
            }
          }
          if (saved > 0) setMessage(`已保存 ${saved} 项对话显示选择。`)
          await Promise.all([refresh(), refreshDisplay()])
        } catch (err) {
          failures.push(`刷新清单失败：${err.message}`)
        } finally {
          setError(failures.join('；'))
          setBusy('')
        }
      }

      const reset = () => {
        setDrafts(new Map())
        setError('')
        setMessage('')
      }

      const bili = view?.bili
      const biliEnabled = bili?.enabled !== false
      const biliLabel = !bili ? '读取中…' : !biliEnabled ? '已关闭 · 按宿主配置出网'
        : bili.status ? (BILI_LABEL[bili.status] ?? bili.status) : '已开启 · 检测到系统代理时应用'
      const schedule = view?.schedule ?? { enabled: false, hour: 9 }
      const selfCheck = view?.selfCheck
      const summary = view === null ? '读取供应商…' : !view.lastCheckAt ? '尚未检查上游目录'
        : `上次检查 ${formatTime(view.lastCheckAt)} · ${view.providers?.length ?? 0} 个供应商`
      const diagnostic = view?.providers?.find((row) => row.provider === details?.provider)
      const pendingCount = view?.review?.pendingCount ?? view?.metadata?.pendingCount ?? 0
      const footerText = error || catalogError || (!integrated ? '请重启 DSH 加载对话选择器适配。' : '')
        || (drafts.size > 0 ? `${drafts.size} 项选择待保存` : message || '没有待保存的选择')

      const infoPairs = (pairs) => h('dl', { key: 'facts' }, pairs.map(([label, value]) => h('div', { key: label },
        h('dt', null, label), h('dd', null, value))))
      const updateSchedule = (next) => act('settings', () => call('settings', { schedule: { ...schedule, ...next } }))
      const detailsTitle = details?.kind === 'network' ? '网络出口详情'
        : details?.kind === 'provider' ? '维护与诊断' : '连接与检查设置'
      const detailContents = details?.kind === 'network'
        ? [
            h('p', { key: 'origin' }, `bili 车道 · ${bili?.origin ?? '未找到'}`),
            infoPairs((bili?.rows ?? []).map((entry) => [entry.host,
              `${entry.proxy ?? '直连'}${entry.proxy && entry.owned === false ? '（现有声明）' : ''}`])),
            h('p', { key: 'status' }, biliLabel),
          ]
        : details?.kind === 'provider' && diagnostic
          ? [
              h('p', { key: 'name' }, nameOf(diagnostic)),
              infoPairs([
                ['供应商', diagnostic.provider],
                ['地址', diagnostic.baseURL ?? '适配器默认'],
                ['协议', PROTOCOL_LABEL[diagnostic.api] ?? diagnostic.api ?? '按目录'],
                ['模型清单', diagnostic.explicitModels ? '已指定清单' : '继承内置目录'],
                ['最近检查', formatTime(diagnostic.check?.at) || '尚未检查'],
              ]),
              diagnostic.check?.error ? h('p', { key: 'error', className: 'warn' }, diagnostic.check.error) : null,
              diagnostic.catalogManaged ? h('p', { key: 'managed' }, '模型由账号目录提供，可在这里勾选要显示的模型。') : null,
              diagnostic.check?.status === 'no-endpoint' && !diagnostic.catalogManaged
                ? h('p', { key: 'endpoint' }, '当前路由没有可用于检查的目录地址。') : null,
              diagnostic.check?.complete === false ? h('p', { key: 'partial', className: 'warn' }, '上游目录仅部分读到，当前显示已读取的模型。') : null,
              diagnostic.check?.gone?.length ? h('p', { key: 'gone' }, `上游本次未列出：${diagnostic.check.gone.join('、')}`) : null,
              diagnostic.check?.upstreamChanged?.length ? h('p', { key: 'changed' }, `上游资料有变化：${diagnostic.check.upstreamChanged.join('、')}`) : null,
              (diagnostic.ignored ?? []).length ? h('div', { key: 'ignored' },
                h('p', null, `已忽略：${diagnostic.ignored.join('、')}`),
                button('清除忽略名单', () => act('unignore', () => call('unignore', { provider: diagnostic.provider })), { disabled: working })) : null,
              h('div', { key: 'gateway', className: 'actions' },
                diagnostic.routedThroughGateway
                  ? button('停止转发', () => act('gateway-unroute', () => call('gateway-unroute', { provider: diagnostic.provider })), { disabled: working })
                  : button('交给网关', () => act('gateway-route', () => call('gateway-route', { provider: diagnostic.provider })), { disabled: working || !diagnostic.baseURL }),
                button('检查此供应商', () => act('check', () => call('check', { provider: diagnostic.provider })), { disabled: working })),
            ]
          : [
              h('section', { key: 'schedule' }, h('p', null, h('label', null,
                h('input', {
                  type: 'checkbox', checked: schedule.enabled !== false, disabled: working || !view,
                  onChange: (event) => updateSchedule({ enabled: event.target.checked }),
                }), ' 定时检查')),
              h('p', null, h('label', null, '每天 ',
                h('select', {
                  value: schedule.hour ?? 9, disabled: working || !schedule.enabled,
                  onChange: (event) => {
                    const hour = Number(event.target.value)
                    if (Number.isInteger(hour) && hour >= 0 && hour < 24) return updateSchedule({ hour })
                  },
                }, Array.from({ length: 24 }, (_, hour) => h('option', { value: hour, key: hour },
                  `${String(hour).padStart(2, '0')}:00`))), ' 检查上游目录'))),
              h('section', { key: 'proxy' },
                h('h3', null, '代理同步'),
                h('p', null, bili?.configPath),
                h('div', { className: 'actions' },
                  button('立即同步', () => act('bili', () => call('bili', {})), { disabled: working }),
                  button(confirmingRevoke ? '确认撤销' : '撤销插件的声明', () => {
                    if (!confirmingRevoke) return setConfirmingRevoke(true)
                    setConfirmingRevoke(false)
                    return act('bili', () => call('bili-revoke', {}))
                  }, { disabled: working || (bili?.written ?? 0) === 0 }))),
              (view?.legacy ?? []).length ? h('p', { key: 'legacy' }, `待核对的旧版路由：${view.legacy.map((row) => row.provider).join('、')}`) : null,
              (view?.foreign ?? []).length ? h('p', { key: 'foreign' }, `待核对的供应商键：${view.foreign.join('、')}`) : null,
              (view?.problems ?? []).map(({ provider, reason }, index) => h('p', { key: index, className: 'warn' }, `${provider}：${reason}`)),
            ]

      const onTabKey = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const pages = ['manage', 'metadata', 'history']
        const next = event.key === 'Home' ? pages[0] : event.key === 'End' ? pages.at(-1)
          : pages[(pages.indexOf(tab) + (event.key === 'ArrowLeft' ? 2 : 1)) % pages.length]
        setTab(next)
        globalThis.setTimeout?.(() => {
          globalThis.document?.getElementById(`dsh-ms-tab-${next}`)?.focus()
        }, 0)
      }

      return h('div', { className: 'dsh-ms' },
        h('style', null, CSS),
        h('header', { className: 'head' },
          h('h2', null, '模型管理'),
          h('p', { className: 'intro', title: '勾选要在对话下拉框中显示的模型，保存后生效。' },
            '勾选要在对话下拉框中显示的模型，保存后生效。'),
          h('div', { className: 'tabs', role: 'tablist', 'aria-label': '模型管理页面' },
            h('button', {
              id: 'dsh-ms-tab-manage', type: 'button', role: 'tab',
              className: `tab ${tab === 'manage' ? 'active' : ''}`,
              'aria-selected': tab === 'manage',
              tabIndex: tab === 'manage' ? 0 : -1,
              onClick: () => setTab('manage'), onKeyDown: onTabKey,
            }, '模型管理'),
            h('button', {
              id: 'dsh-ms-tab-metadata', type: 'button', role: 'tab',
              className: `tab ${tab === 'metadata' ? 'active' : ''}`,
              'aria-selected': tab === 'metadata',
              tabIndex: tab === 'metadata' ? 0 : -1,
              onClick: () => { setReviewJump(null); setTab('metadata') }, onKeyDown: onTabKey,
            }, '待确认模型信息', pendingCount > 0
              ? h('span', { className: 'tab-count' }, String(pendingCount))
              : null),
            h('button', { id: 'dsh-ms-tab-history', type: 'button', role: 'tab', className: 'tab',
              'aria-selected': tab === 'history', tabIndex: tab === 'history' ? 0 : -1,
              onClick: () => { setHistoryJump(null); setTab('history') }, onKeyDown: onTabKey,
            }, '同步历史')),
          tab === 'manage' ? h(React.Fragment, null,
          h('section', { className: 'proxy', 'aria-label': '系统代理' },
            h('div', { className: 'clip' },
              h('strong', { id: 'dsh-ms-proxy-label', className: 'clip', title: '让需要代理的模型走系统代理' }, '让需要代理的模型走系统代理'),
              h('small', { id: 'dsh-ms-proxy-note', className: 'clip', title: bili?.error ?? biliLabel }, biliLabel)),
            h('div', { className: 'actions' },
              link('网络出口详情', (event) => openDetails(event, 'network'), {
                'aria-controls': 'dsh-ms-details', 'aria-expanded': details?.kind === 'network',
                onPointerEnter: (event) => { if (event.pointerType === 'mouse') openDetails(event, 'network', undefined, false) },
                onPointerLeave: queueHoverClose,
                onFocus: (event) => { if (event.currentTarget.matches(':focus-visible')) openDetails(event, 'network', undefined, false) },
                onBlur: queueHoverClose,
              }),
              h('button', {
                type: 'button', className: 'switch', role: 'switch', 'aria-checked': biliEnabled,
                'aria-labelledby': 'dsh-ms-proxy-label', 'aria-describedby': 'dsh-ms-proxy-note',
                disabled: working || !view, onClick: () => act('settings', () => call('settings', { bili: { enabled: !biliEnabled } })),
              }, h('span', { 'aria-hidden': true })))),
          h('div', { className: 'toolbar' },
            h('p', { className: 'summary', title: summary }, summary),
            h('div', { className: 'actions' },
              button('连接设置', (event) => openDetails(event, 'settings'), {
                id: 'dsh-ms-connection-trigger', 'aria-controls': 'dsh-ms-details', 'aria-expanded': details?.kind === 'settings',
              }),
              button('自检详情', toggleSelfCheck, {
                id: 'dsh-ms-check-trigger', ref: selfCheckTrigger, 'aria-controls': 'dsh-ms-selfcheck', 'aria-expanded': false,
              }),
              button(busy === 'selfcheck' ? '自查中…' : '自查', runSelfCheck, { disabled: working }),
              button(busy === 'check' ? '检查中…' : '检查更新', () => act('check', () => call('check', {})), { className: 'btn primary', disabled: working || !view })))) : null),
        tab === 'manage' ? h('div', { className: 'pane', id: 'dsh-ms-panel-manage', role: 'tabpanel', 'aria-labelledby': 'dsh-ms-tab-manage' },
          h('div', { className: 'filter-bar' },
            h('label', { className: 'search' }, h('input', {
              type: 'search', value: query,
              placeholder: '搜索模型名称、ID 或供应商', 'aria-label': '搜索模型名称、ID 或供应商',
              onChange: (event) => {
                setQuery(event.target.value)
                if (list.current) list.current.scrollTop = 0
              },
            })),
            h('div', { className: 'actions' }, FILTERS.map(([id, label]) => button(label,
              () => setFilter(id), { key: id, className: 'filter', 'aria-pressed': filter === id })))),
          h('div', { className: 'list', ref: list, onScroll: () => { if (details?.kind === 'provider') closeDetails() } },
            filtered.length === 0 ? h('p', { className: 'notice' },
              view === null && !error ? '读取模型…' : '没有匹配的模型。')
              : filtered.map(({ row, models }) => h(ProviderCard, {
                key: row.provider, row, models,
                expanded: expanded === row.provider || (search !== '' && expanded === null),
                onExpand: () => setExpanded(expanded === row.provider || (search !== '' && expanded === null) ? '' : row.provider),
                onToggle: (entries, value) => onToggle(row.provider, entries, value),
                selectionDisabled: working || !integrated,
                onDetails: (event) => openDetails(event, 'provider', row.provider),
                detailsOpen: details?.kind === 'provider' && details.provider === row.provider,
              }))),
          h('footer', { className: 'foot' },
            h('span', { className: `summary ${error ? 'failed' : ''}`, role: error ? 'alert' : 'status', title: footerText }, footerText),
            h('div', { className: 'actions' },
              drafts.size > 0 ? link('放弃更改', reset, { disabled: working }) : null,
              button(busy === 'save' ? '保存中…' : '保存模型选择', saveModels, {
                className: 'btn primary', disabled: working || !integrated || drafts.size === 0,
              })))) : tab === 'metadata' ? h('div', { id: 'dsh-ms-panel-metadata', className: 'review-tab-panel', role: 'tabpanel', 'aria-labelledby': 'dsh-ms-tab-metadata' }, h(MetadataTab, {
                view, working, act, error, refresh, drafts: reviewDrafts, setDrafts: setReviewDrafts, jump: reviewJump,
                onHistory: (model) => { setHistoryJump(model); setTab('history') },
                onConnection: () => {
                  setTab('manage')
                  globalThis.setTimeout?.(() => globalThis.document?.getElementById('dsh-ms-connection-trigger')?.click(), 0)
                },
              })) : h('div', { id: 'dsh-ms-panel-history', className: 'review-tab-panel', role: 'tabpanel', 'aria-labelledby': 'dsh-ms-tab-history' }, h(HistoryTab, {
                view, jump: historyJump, onModel: (model) => { setReviewJump(model); setTab('metadata') },
              })),
        h('div', {
          ref: selfCheckPopover, id: 'dsh-ms-selfcheck', className: 'check-popover', popover: 'auto',
          'aria-labelledby': 'dsh-ms-selfcheck-title',
          onToggle: (event) => {
            const open = event.currentTarget.matches(':popover-open')
            selfCheckTrigger.current?.setAttribute('aria-expanded', String(open))
            if (open) positionSelfCheck()
          },
        },
          h('div', { className: 'popover-head' },
            h('h3', { id: 'dsh-ms-selfcheck-title' }, '自检结果'),
            link('关闭', () => selfCheckPopover.current?.hidePopover())),
          selfCheck ? h(React.Fragment, null,
            infoPairs([
              ['检查结果', h('span', { className: selfCheck.ok ? 'ok' : 'warn' }, selfCheck.ok ? '通过' : '有待处理事项')],
              ['已配置供应商', `${view?.providers?.length ?? 0} 个`],
              ['系统代理', biliEnabled ? '已开启' : '已关闭'],
              ['检查时间', formatTime(selfCheck.at)],
            ]),
            (selfCheck.failures ?? []).map(({ message }, index) => h('p', { key: `failure${index}`, className: 'warn' }, message)),
            (selfCheck.warnings ?? []).map(({ message }, index) => h('p', { key: `warning${index}` }, message)),
            h('details', null, h('summary', null, '技术详情'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, selfCheck.text)))
            : h('p', null, '还没有自检结果。')),
        h('div', {
          ref: detailsPopover, id: 'dsh-ms-details', className: 'detail-popover', popover: 'auto',
          'aria-labelledby': 'dsh-ms-details-title',
          onPointerEnter: cancelHoverClose, onPointerLeave: queueHoverClose,
          onToggle: (event) => {
            if (event.currentTarget.matches(':popover-open')) positionDetails()
            else {
              pinned.current = false
              setDetails(null)
            }
          },
        },
          h('div', { className: 'popover-head' },
            h('h3', { id: 'dsh-ms-details-title' }, detailsTitle),
            details?.kind === 'network' ? null : link('关闭', closeDetails)),
          detailContents,
          details?.kind !== 'network' && error ? h('p', { role: 'alert', className: 'warn' }, error) : null))
    }

    function apply(ctx) {
      ctx.effect?.(() => {
        let disposed = false
        const reload = () => call('visibility').then(({ hidden }) => {
          if (!disposed) publishVisibility(hidden)
        }).catch(() => {})
        void reload()
        window.addEventListener('focus', reload)
        return () => {
          disposed = true
          window.removeEventListener('focus', reload)
          publishVisibility([])
        }
      }, 'model-sync: selector visibility')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-sync',
        order: 30,
        label: () => '模型管理',
      }, Panel))
    }

    const module = { apply, inject: ['slots'] }
    return module
  },
})
