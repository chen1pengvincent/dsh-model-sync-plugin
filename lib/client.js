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

      return h('div', { className: 'dsh-ms' },
        h('style', null, CSS),
        h('header', { className: 'head' },
          h('h2', null, '模型管理'),
          h('p', { className: 'intro', title: '勾选要在对话下拉框中显示的模型，保存后生效。' },
            '勾选要在对话下拉框中显示的模型，保存后生效。'),
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
                'aria-controls': 'dsh-ms-details', 'aria-expanded': details?.kind === 'settings',
              }),
              button('自检详情', toggleSelfCheck, {
                id: 'dsh-ms-check-trigger', ref: selfCheckTrigger, 'aria-controls': 'dsh-ms-selfcheck', 'aria-expanded': false,
              }),
              button(busy === 'selfcheck' ? '自检中…' : '运行自检', runSelfCheck, { disabled: working }),
              button(busy === 'check' ? '检查中…' : '立即检查', () => act('check', () => call('check', {})), { className: 'btn primary', disabled: working || !view })))),
        h('div', { className: 'pane' },
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
              })))),
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
