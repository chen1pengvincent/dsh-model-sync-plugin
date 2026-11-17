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
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const API = '/model-sync/api'
    /** Long enough for a real check, short enough that a dead host is visible. */
    const REQUEST_TIMEOUT_MS = 30_000
    const CARD_LIMIT = 200

    /** Fallbacks match the shipped light palette; dark mode comes from tokens. */
    const ui = {
      border: '1px solid var(--dsw-alias-border-l1, #d0d7de)',
      muted: 'var(--dsw-alias-label-secondary, #57606a)',
      dim: 'var(--dsw-alias-label-tertiary, #8c959f)',
      danger: 'var(--dsw-alias-state-error-primary, #cf222e)',
      warning: 'var(--dsw-alias-state-warn-label, #9a6700)',
      success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      blue: 'var(--dsw-alias-state-business-primary, #0969da)',
      radius: '10px',
      panel: 'var(--dsw-alias-bg-layer-2, #ffffff)',
      subtle: 'var(--dsw-alias-bg-module-platform, #f6f8fa)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'addable', label: '待加入 DSH' },
      { id: 'enabled', label: '已加入 DSH' },
    ]

    const PROTOCOL_LABEL = {
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
      const signal = typeof abort === 'function' && typeof abort.timeout === 'function' ? abort.timeout(REQUEST_TIMEOUT_MS) : undefined
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

    function DisplayPanel({ active, refreshKey }) {
      const [catalog, setCatalog] = useState(null)
      const [changes, setChanges] = useState(new Map())
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [saved, setSaved] = useState(false)
      const integrated = globalThis.__dshModelSyncSelectorVersion === 1

      useEffect(() => {
        if (!active) return
        let cancelled = false
        call('display-models').then((payload) => {
          if (cancelled) return
          setCatalog(payload)
          publishVisibility(payload.hidden)
        }).catch((err) => { if (!cancelled) setError(err.message) })
        return () => { cancelled = true }
      }, [active, refreshKey])

      const hidden = new Set((catalog?.hidden ?? []).map((pair) => JSON.stringify(pair)))
      const filter = query.trim().toLowerCase()
      const groups = (catalog?.groups ?? []).map((group) => ({
        ...group,
        models: group.models.filter(({ id, name }) => `${group.name} ${name ?? ''} ${id}`.toLowerCase().includes(filter)),
      })).filter((group) => group.models.length > 0 || group.unavailable)
      const onSave = async () => {
        setBusy(true)
        setError('')
        setSaved(false)
        try {
          const result = await call('visibility', { changes: [...changes.values()] })
          setCatalog((previous) => ({ ...previous, hidden: result.hidden }))
          publishVisibility(result.hidden)
          setChanges(new Map())
          setSaved(true)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { hidden: !active },
        h('p', { style: { color: ui.muted, fontSize: '13px' } }, '控制对话下拉框和 /model 的可选项。隐藏后，模型配置、当前会话和默认模型都保留。'),
        !integrated ? h('p', { role: 'status', style: { color: ui.warning } }, '原生选择器适配尚未加载，请重启 DSH 或核对本机安装。') : null,
        error ? h('p', { role: 'alert', style: { color: ui.danger } }, error) : null,
        saved ? h('p', { role: 'status', style: { color: ui.success } }, '显示设置已保存。可以打开对话下拉框查看。') : null,
        catalog === null ? (error ? null : h('p', null, '读取已配置模型…')) : h(React.Fragment, null,
          h('input', {
            type: 'search', 'aria-label': '搜索已配置模型', placeholder: '搜索模型或供应商',
            value: query, onChange: (event) => setQuery(event.target.value),
          }),
          groups.length === 0 ? h('p', { style: { color: ui.muted } }, '没有匹配的模型。') : null,
          groups.map((group) => h(Section, { key: group.provider, title: group.name ?? group.provider, count: group.models.length },
            group.unavailable ? h('p', { style: { color: ui.warning } }, '此供应商的模型暂时无法读取。') : null,
            group.models.map((model) => {
              const key = JSON.stringify([group.provider, model.id])
              const visible = !hidden.has(key)
              return h('label', { key, style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px', padding: '6px 0', borderTop: ui.border } },
                h('span', { style: { overflowWrap: 'anywhere', minWidth: 0 } }, model.name ?? model.id,
                  model.name && model.name !== model.id ? h('small', { style: { display: 'block', color: ui.muted } }, model.id) : null),
                h('span', null, h('input', {
                  type: 'checkbox', checked: changes.get(key)?.visible ?? visible, disabled: busy || !integrated,
                  'aria-label': `${group.name ?? group.provider} ${model.name ?? model.id} 在对话中显示`,
                  onChange: (event) => {
                    const next = event.target.checked
                    setSaved(false)
                    setChanges((current) => {
                      const draft = new Map(current)
                      if (visible === next) draft.delete(key)
                      else draft.set(key, { provider: group.provider, id: model.id, visible: next })
                      return draft
                    })
                  },
                }), ' 在对话中显示'))
            }))),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '12px' } },
            h('span', { role: 'status', style: { marginRight: 'auto', color: ui.muted } },
              changes.size > 0 ? `待保存 ${changes.size} 项` : '没有待保存的更改'),
            textButton('放弃更改', () => setChanges(new Map()), { disabled: busy || changes.size === 0 }),
            textButton(busy ? '保存中…' : '保存显示设置', onSave, { disabled: busy || !integrated || changes.size === 0 }))))
    }

    function formatTime(value) {
      if (value === undefined || value === null) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (number) => String(number).padStart(2, '0')
      return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function providerName(row) {
      return typeof row.displayName === 'string' && row.displayName.length > 0 ? row.displayName : row.provider
    }

    /** Group rows by the vendor prefix of the model id (`gemini-…` → `gemini`). */
    function vendorOf(id) {
      const text = String(id)
      const dash = text.indexOf('-')
      if (dash > 0) return text.slice(0, dash)
      return text
    }

    function vendorGroups(rows) {
      const groups = new Map()
      for (const row of rows) {
        const id = vendorOf(row.id)
        let group = groups.get(id)
        if (group === undefined) {
          group = { id, rows: [] }
          groups.set(id, group)
        }
        group.rows.push(row)
      }
      return [...groups.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'))
    }

    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
    function compareRows(left, right) {
      const byId = collator.compare(left.id, right.id)
      return byId !== 0 ? byId : 0
    }

    function cardStyle() {
      return { border: ui.border, borderRadius: ui.radius, background: ui.panel, overflow: 'hidden', minWidth: 0 }
    }

    function FilterButton({ active, onClick, children }) {
      return h('button', {
        type: 'button',
        onClick,
        'aria-pressed': active,
        style: {
          border: active ? `1px solid ${ui.blue}` : ui.border,
          background: active ? ui.blue : 'transparent',
          color: active ? '#fff' : ui.muted,
          borderRadius: '999px',
          padding: '3px 9px',
          fontSize: '12px',
          lineHeight: '18px',
          cursor: 'pointer',
        },
      }, children)
    }

    /**
     * A click here never carries anything: every caller passes either an arrow
     * with its own arguments or a zero-argument function. Forwarding the event
     * object is how a handler that expects a provider id ends up deleting
     * `drafts["[object Object]"]`, which fails silently in the UI.
     */
    function textButton(label, onClick, options = {}) {
      return h('button', {
        type: 'button',
        onClick: () => onClick(),
        disabled: options.disabled === true,
        style: {
          border: 'none',
          background: 'none',
          padding: 0,
          color: options.disabled === true ? ui.dim : (options.tone === 'danger' ? ui.danger : ui.blue),
          fontSize: '12px',
          cursor: options.disabled === true ? 'default' : 'pointer',
        },
      }, label)
    }

    function Section({ title, count, children }) {
      return h('section', { style: { marginTop: '16px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px', marginBottom: '8px' } },
          h('h3', { style: { margin: 0, fontSize: '14px' } }, title),
          count === undefined ? null : h('span', { style: { color: ui.dim, fontSize: '12px' } }, String(count))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, children))
    }

    /** The switch the transport row uses; kept identical to the old panel. */
    function Switch({ id, checked, disabled, onChange, label, note, title }) {
      const [focusVisible, setFocusVisible] = useState(false)
      return h('button', {
        id,
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        'aria-describedby': note === undefined ? undefined : `${id}-note`,
        disabled,
        title,
        onClick: () => onChange(!checked),
        onFocus: (event) => {
          try {
            setFocusVisible(event.currentTarget.matches(':focus-visible'))
          } catch {
            setFocusVisible(false)
          }
        },
        onBlur: () => setFocusVisible(false),
        style: {
          flex: 'none',
          position: 'relative',
          width: '40px',
          height: '22px',
          padding: 0,
          border: 'none',
          borderRadius: '999px',
          background: checked ? ui.success : 'var(--dsw-alias-border-l1, #d0d7de)',
          boxShadow: 'inset 0 0 0 1px rgba(27, 31, 36, 0.06)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          outline: focusVisible ? '2px solid #0969da' : 'none',
          outlineOffset: '2px',
          transition: 'background-color 150ms ease',
        },
      }, h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          top: '2px',
          left: '2px',
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(27,31,36,.3)',
          transform: checked ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 150ms ease',
        },
      }))
    }

    function GroupCheckbox({ label, rows, add, disabled, onToggle }) {
      const ref = useRef(null)
      const selected = rows.reduce((total, row) => total + (add.has(row.id) ? 1 : 0), 0)
      const all = rows.length > 0 && selected === rows.length
      const partial = selected > 0 && !all
      useEffect(() => {
        if (ref.current !== null) ref.current.indeterminate = partial
      }, [partial])
      return h('input', {
        ref,
        type: 'checkbox',
        checked: all,
        disabled: disabled || rows.length === 0,
        'aria-label': `选择 ${label}`,
        onChange: () => onToggle(!all),
        style: { flex: 'none', margin: '2px 0 0' },
      })
    }

    /** First few ids, then a count: a wall of 40 ids helps nobody. */
    function previewList(ids) {
      return ids.length <= 8 ? ids.join('、') : `${ids.slice(0, 8).join('、')} 等`
    }

    function tag(text, color, title) {
      return h('span', {
        title,
        style: { color, fontSize: '11px', whiteSpace: 'nowrap' },
      }, text)
    }

    /**
     * One provider card. `draft.add` / `draft.remove` are the two halves of the
     * single draft the bottom bar saves; every row is derived from them plus the
     * last check, so nothing here can drift from what would be written.
     */
    function ProviderCard(props) {
      const { row, expanded, onToggle, draft, query, onQuery, filter, onFilter, showAll, onShowAll, busy, onRowToggle, onGroupToggle, onUnignore, onRoute, onUnroute, routing } = props
      const check = row.check
      const status = check === undefined ? 'needs-check' : String(check.status ?? 'error')
      const addable = Array.isArray(check?.added) ? check.added : []
      const enabled = Array.isArray(row.eagerIds) ? row.eagerIds : []
      const gone = Array.isArray(check?.gone) ? check.gone : []
      const upstreamNew = new Set(check?.upstreamNew ?? [])
      const changed = check?.upstreamChanged ?? []
      const ignored = Array.isArray(row.ignored) ? row.ignored : []
      // A check answers "what is new upstream". It has no bearing on removing a
      // model that is already configured: that list is right here, and blocking
      // it strands the user on exactly the routes a check cannot reach
      // (no directory interface, no endpoint, upstream down).
      const editableRows = status === 'ok'

      const allRows = useMemo(() => {
        const rows = []
        for (const id of enabled) rows.push({ id, kind: 'enabled' })
        for (const model of addable) {
          if (enabled.includes(model.id)) continue
          rows.push({ id: model.id, name: model.name, kind: 'addable', blocked: model.blocked })
        }
        for (const id of ignored) {
          if (enabled.includes(id) || addable.some((model) => model.id === id)) continue
          rows.push({ id, kind: 'ignored' })
        }
        return rows.sort(compareRows)
      }, [enabled, addable, ignored])

      const normalizedQuery = query.trim().toLowerCase()
      const filtered = allRows.filter((entry) => {
        if (normalizedQuery.length > 0 && !`${entry.id} ${entry.name ?? ''}`.toLowerCase().includes(normalizedQuery)) return false
        if (filter === 'addable') return entry.kind === 'addable'
        if (filter === 'enabled') return entry.kind === 'enabled'
        return true
      })
      const visible = showAll ? filtered : filtered.slice(0, CARD_LIMIT)
      const groups = vendorGroups(visible)
      const pendingAdds = draft.add.size
      const atLimit = row.hasModelOverrides === true

      const renderRow = (entry) => {
        const addable = entry.kind === 'addable'
        const disabled = busy || atLimit || !editableRows || entry.blocked !== undefined
        const title = entry.blocked
        return h('div', {
          key: entry.id,
          style: { padding: '4px 0', fontSize: '13px', overflowWrap: 'anywhere' },
        },
          addable ? h('label', { title },
            h('input', {
              type: 'checkbox', checked: draft.add.has(entry.id), disabled,
              onChange: () => onRowToggle(row.provider, entry),
            }), ' ', entry.name ?? entry.id) : h('span', null, entry.id),
          entry.name && entry.name !== entry.id ? h('small', { style: { marginLeft: '6px', color: ui.muted } }, entry.id) : null,
          tag(entry.kind === 'enabled' ? '已加入 DSH' : entry.kind === 'ignored' ? '已忽略'
            : entry.blocked ?? (editableRows ? (upstreamNew.has(entry.id) ? '较上次新增' : '可加入 DSH') : '待重新检查'), addable && disabled ? ui.warning : ui.dim))
      }

      const statusText = STATUS_LABEL[status] ?? status
      const warning = status === 'error'
      const summary = check === undefined
        ? `已启用 ${enabled.length} 个`
        : status === 'adapter' || status === 'no-endpoint'
          ? `已启用 ${enabled.length} 个`
          : `已启用 ${enabled.length} 个${check.upstreamCount > 0 ? ` · 上游 ${check.upstreamCount} 个` : ''}`

      return h('div', { style: cardStyle() },
        h('button', {
          type: 'button',
          onClick: onToggle,
          'aria-expanded': expanded,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            width: '100%',
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            textAlign: 'left',
            padding: '12px 14px',
            font: 'inherit',
            cursor: 'pointer',
          },
        },
          h('strong', { style: { minWidth: 0, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, providerName(row)),
          h('span', { style: { color: ui.dim, fontSize: '12px', whiteSpace: 'nowrap' } }, row.provider === providerName(row) ? '' : row.provider),
          h('span', { style: { color: ui.muted, fontSize: '12px', whiteSpace: 'nowrap' } }, summary),
          addable.length > 0 ? h('span', { style: { color: ui.blue, fontSize: '12px', whiteSpace: 'nowrap' } }, `上游尚未加入的模型 ${addable.length}`) : null,
          statusText ? h('span', { style: { color: warning ? ui.danger : ui.dim, fontSize: '12px', whiteSpace: 'nowrap' } }, statusText) : null,
          pendingAdds > 0 ? h('span', { style: { color: ui.blue, fontSize: '12px', whiteSpace: 'nowrap' } }, `待加入 ${pendingAdds}`) : null,
          row.routedThroughGateway === true ? h('span', { style: { color: ui.dim, fontSize: '12px', whiteSpace: 'nowrap' } }, '经网关') : null,
          h('span', { style: { marginLeft: 'auto', color: ui.dim, fontSize: '12px' } }, expanded ? '▾' : '▸')),
        expanded
          ? h('div', { style: { borderTop: ui.border, padding: '10px 14px 14px' } },
            h('p', { style: { margin: '0 0 8px', color: ui.muted, fontSize: '12px' } },
              status === 'adapter'
                ? `模型配置：已启用 ${enabled.length} 个 · 这个供应商没有可列举的目录接口，不能在这里新增（可以在官方设置里手动增删）`
                : status === 'no-endpoint'
                  ? `模型配置：已启用 ${enabled.length} 个 · 插件不知道这条路由该问哪个地址（地址写在每个模型上），所以列不出上游尚未加入的模型`
                  : status === 'ok'
                  ? `模型配置：已启用 ${enabled.length} 个 · 上游尚未加入的模型 ${addable.length} 个${ignored.length > 0 ? ` · 已忽略 ${ignored.length} 个` : ''}`
                  : `模型配置：已启用 ${enabled.length} 个 · 还没有成功检查过上游目录`),
            status === 'error' && check?.error ? h('p', { role: 'status', style: { margin: '0 0 8px', color: ui.danger, fontSize: '12px' } }, `检查失败：${check.error}${check.lastSuccessAt ? `。已保留 ${formatTime(check.lastSuccessAt)} 的目录` : ''}`) : null,
            atLimit ? h('p', { role: 'status', style: { margin: '0 0 8px', color: ui.warning, fontSize: '12px' } }, '这个供应商设置了 modelOverrides，不能改模型清单；请在官方设置里编辑。') : null,
            check?.complete === false ? h('p', { style: { color: ui.warning, fontSize: '12px' } }, '上游目录尚有后续页，本次仅显示已读取的结果。') : null,
            changed.length > 0 ? h('p', { style: { color: ui.muted, fontSize: '12px' } }, `上游目录信息有变化：${previewList(changed)}`) : null,
            gone.length > 0
              ? h('p', { style: { margin: '0 0 8px', color: ui.warning, fontSize: '12px', overflowWrap: 'anywhere' } },
                `本次上游目录未列出 ${gone.length} 个已配置模型：${previewList(gone)}。配置已保留。`)
              : null,
            allRows.length === 0
              ? h('p', { style: { color: ui.dim, fontSize: '12px' } }, '这条路由还没有模型。')
              : h('div', null,
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '2px 0 8px' } },
                  h('input', {
                    type: 'text',
                    value: query,
                    placeholder: '搜索模型 id / 名称',
                    onChange: (event) => onQuery(event.target.value),
                    style: {
                      flex: '1 1 220px',
                      minWidth: '160px',
                      height: '30px',
                      padding: '0 9px',
                      borderRadius: '7px',
                      border: ui.border,
                      background: 'transparent',
                      color: 'inherit',
                      fontSize: '13px',
                    },
                  }),
                  h('div', { style: { display: 'flex', gap: '5px' } },
                    FILTERS.map((entry) => h(FilterButton, { key: entry.id, active: filter === entry.id, onClick: () => onFilter(entry.id) }, entry.label))),
                  textButton(`选择当前显示的候选（${visible.filter((entry) => entry.kind === 'addable' && entry.blocked === undefined).length}）`,
                    () => onGroupToggle(row.provider, visible.filter((entry) => entry.kind === 'addable' && entry.blocked === undefined).map((entry) => entry.id), true), {
                      disabled: busy || atLimit || !editableRows || visible.every((entry) => entry.kind !== 'addable' || entry.blocked !== undefined),
                    })),
                groups.length === 0
                  ? h('p', { style: { color: ui.dim, fontSize: '12px', margin: '8px 0' } }, '没有匹配的模型')
                  : h('div', { style: { columnWidth: '240px', columnGap: '10px' } },
                    groups.map((group) => {
                      const groupAddable = group.rows.filter((entry) => entry.kind === 'addable' && entry.blocked === undefined)
                      const groupEnabled = group.rows.filter((entry) => entry.kind === 'enabled')
                      const groupSelected = groupAddable.reduce((total, entry) => total + (draft.add.has(entry.id) ? 1 : 0), 0)
                      return h('section', {
                        key: group.id,
                        style: {
                          minWidth: 0,
                          border: ui.border,
                          borderRadius: '8px',
                          padding: '8px 10px',
                          background: ui.subtle,
                          breakInside: 'avoid',
                          pageBreakInside: 'avoid',
                          marginBottom: '10px',
                        },
                      },
                        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '7px', paddingBottom: '4px' } },
                          h(GroupCheckbox, {
                            label: `${group.id} 未添加模型`,
                            rows: groupAddable,
                            add: draft.add,
                            disabled: busy || atLimit || !editableRows,
                            onToggle: (value) => onGroupToggle(row.provider, groupAddable.map((entry) => entry.id), value),
                          }),
                          h('strong', { style: { flex: '1', minWidth: 0, fontSize: '13px', lineHeight: '18px' } }, group.id),
                          groupAddable.length > 0 ? h('span', { style: { color: ui.dim, fontSize: '11px', whiteSpace: 'nowrap' } }, `可选 ${groupSelected}/${groupAddable.length}`) : null,
                          groupEnabled.length > 0 ? h('span', { style: { color: ui.dim, fontSize: '11px', whiteSpace: 'nowrap' } }, `已启用 ${groupEnabled.length}`) : null),
                        h('div', null, group.rows.map(renderRow)))
                    })),
                filtered.length > visible.length
                  ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', color: ui.muted, fontSize: '12px' } },
                    h('span', null, `当前筛选共 ${filtered.length} 个，已显示前 ${visible.length} 个`),
                    textButton('显示全部', onShowAll))
                  : null),
            h('details', { style: { marginTop: '12px' } },
              h('summary', { style: { color: ui.dim, fontSize: '12px', cursor: 'pointer' } }, '维护与诊断'),
              h('div', { style: { marginTop: '8px', color: ui.muted, fontSize: '12px', lineHeight: '1.7' } },
                h('div', null,
                  check === undefined
                    ? '还没有检查过这个供应商。'
                    : `上次检查 ${formatTime(check.at)}${check.protocol ? ` · 协议 ${PROTOCOL_LABEL[check.protocol] ?? check.protocol}` : ''}${check.via === 'proxy' ? ' · 经代理' : check.via === 'direct' ? ' · 直连' : ''}${Number.isInteger(check.upstreamCount) ? ` · 上游 ${check.upstreamCount} 个` : ''}`),
                status === 'error' && check?.error ? h('div', { style: { color: ui.danger } }, `检查失败：${check.error}`) : null,
                ignored.length > 0
                  ? h('div', { style: { marginTop: '6px' } },
                    h('div', null, `已忽略 ${ignored.length} 个上游尚未加入的模型：${ignored.slice(0, 12).join('、')}${ignored.length > 12 ? ` 等 ${ignored.length} 个` : ''}`),
                    textButton('清除忽略名单', () => onUnignore(row.provider), { disabled: busy }))
                  : null,
                h('div', { style: { marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                  h('span', null, row.routedThroughGateway === true
                    ? `协议网关：已收拢协议${check?.protocol ? `为 ${PROTOCOL_LABEL[check.protocol] ?? check.protocol}` : ''}，请求经本机网关转发`
                    : '协议网关：未启用。只有当这条路由需要服务「目录里没有协议」的模型时才需要它'),
                  row.routedThroughGateway === true
                    ? textButton('停止转发', () => onUnroute(row.provider), { disabled: busy || routing, tone: 'danger' })
                    : textButton('交给网关', () => onRoute(row.provider), { disabled: busy || routing || typeof row.baseURL !== 'string' || row.baseURL.length === 0 })),
                h('details', { style: { marginTop: '6px' } },
                  h('summary', { style: { color: ui.dim, cursor: 'pointer' } }, '技术详情'),
                  h('div', { style: { marginTop: '4px', fontFamily: ui.mono, fontSize: '11px', lineHeight: '1.7', overflowWrap: 'anywhere' } },
                    h('div', null, `供应商：${row.provider}`),
                    h('div', null, `地址：${row.baseURL || '(未声明，用适配器默认)'}`),
                    h('div', null, `协议：${row.api ? PROTOCOL_LABEL[row.api] ?? row.api : '(未声明，按目录)'}`),
                    h('div', null, `模型表：${row.explicitModels === true ? '显式列在设置里' : '继承内置目录'}`),
                    h('div', null, `键：${row.key}`))))))
          : null)
    }

    function Panel(props) {
      const [view, setView] = useState(props?.view ?? null)
      const [tab, setTab] = useState('catalog')
      const [reviewing, setReviewing] = useState(false)
      const [showInPicker, setShowInPicker] = useState(false)
      const [displayRevision, setDisplayRevision] = useState(0)
      const [drafts, setDrafts] = useState({})
      const [expanded, setExpanded] = useState(props?.expandedProvider ?? null)
      const [queries, setQueries] = useState({})
      const [filters, setFilters] = useState({})
      const [showAll, setShowAll] = useState({})
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [verdict, setVerdict] = useState(undefined)

      const refresh = useCallback(async () => {
        const payload = await call('view')
        setView(payload.view)
        return payload.view
      }, [])

      useEffect(() => {
        void refresh().catch((err) => setError(err.message))
      }, [refresh])

      const act = useCallback(async (label, run) => {
        setBusy(label)
        setError('')
        setMessage('')
        try {
          const payload = await run()
          if (payload?.view !== undefined) setView(payload.view)
          else await refresh()
          return payload
        } catch (err) {
          setError(err.message)
          return undefined
        } finally {
          setBusy('')
        }
      }, [refresh])

      const check = useCallback(() => act('check', () => call('check', {})), [act])
      const selfCheck = useCallback(async () => {
        const payload = await act('selfcheck', () => call('selfcheck', {}))
        if (payload !== undefined) setVerdict(payload.text)
      }, [act])

      const toggleBili = useCallback(async (enabled) => {
        await act('bili', async () => {
          // Hosts are derived from the configured providers on the host side. The
          // panel used to echo them back, which froze the set at whatever it last
          // showed: a provider added later was never proxied, with no way to see why.
          await call('settings', { bili: { enabled } })
          return call('bili', {})
        })
      }, [act])

      const draftFor = (provider) => drafts[provider] ?? { add: new Set() }

      const onGroupToggle = useCallback((provider, ids, value) => {
        setDrafts((current) => {
          const add = new Set(current[provider]?.add ?? [])
          for (const id of ids) {
            if (value) add.add(id)
            else add.delete(id)
          }
          return { ...current, [provider]: { add } }
        })
      }, [])

      const onRowToggle = (provider, entry) => onGroupToggle(provider, [entry.id], !draftFor(provider).add.has(entry.id))
      const join = async () => {
        const plan = (view?.providers ?? [])
          .map((row) => ({ row, ids: [...draftFor(row.provider).add] }))
          .filter(({ ids }) => ids.length > 0)
        if (plan.length === 0) return
        setBusy('apply')
        setError('')
        setMessage('')
        const failures = []
        let added = 0
        for (const { row, ids } of plan) {
          try {
            const outcome = await call('apply', { provider: row.provider, ids, showInPicker })
            const written = outcome.written ?? []
            added += written.length
            publishVisibility(outcome.hidden)
            setDrafts((current) => {
              const add = new Set(current[row.provider]?.add ?? [])
              for (const id of written) add.delete(id)
              return { ...current, [row.provider]: { add } }
            })
          } catch (error) {
            failures.push(`${providerName(row)}：${error.message}`)
          }
        }
        if (added > 0) {
          setDisplayRevision((current) => current + 1)
          setMessage(`已加入 DSH ${added} 个模型。${showInPicker ? '已在对话中显示。' : '可到「对话显示」开启。'}`)
        }
        try {
          await refresh()
        } catch (error) {
          failures.push(`刷新模型清单失败：${error.message}`)
        } finally {
          setError(failures.join('，'))
          setReviewing(false)
          setBusy('')
        }
      }

      const [confirming, setConfirming] = useState(null)
      useEffect(() => {
        if (confirming === null) return undefined
        const timer = setTimeout(() => setConfirming(null), 6000)
        return () => clearTimeout(timer)
      }, [confirming])
      const confirmed = useCallback((key, action) => {
        if (confirming !== key) {
          setConfirming(key)
          return
        }
        setConfirming(null)
        return action()
      }, [confirming])
      const confirmLabel = (key, label) => (confirming === key ? '再点一次确认' : label)

      const route = useCallback((provider) => act('gateway-route', () => call('gateway-route', { provider })), [act])
      const unroute = useCallback((provider) => act('gateway-unroute', () => call('gateway-unroute', { provider })), [act])
      const unignore = useCallback((provider) => act('unignore', () => call('unignore', { provider })), [act])

      const providers = view?.providers ?? []
      const pendingAdd = providers.reduce((total, row) => total + draftFor(row.provider).add.size, 0)
      const changedProviders = providers.filter((row) => (row.check?.added?.length ?? 0) > 0)
      const totalAdded = providers.reduce((total, row) => total + (row.check?.added?.length ?? 0), 0)
      const bili = view?.bili
      const biliEnabled = bili?.enabled !== false
      const selfCheckRow = view?.selfCheck
      const schedule = view?.schedule ?? { enabled: false, hour: 9 }
      const legacy = view?.legacy ?? []
      const foreign = view?.foreign ?? []
      const problems = view?.problems ?? []

      const summary = view === null
        ? '加载中…'
        : view === undefined
          ? '加载中…'
          : view?.lastCheckAt === undefined
            ? '尚未检查。点「立即检查」读一次上游目录。'
            : `上次检查 ${formatTime(view.lastCheckAt)} · ${changedProviders.length} 个供应商有上游尚未加入的模型（${totalAdded} 项） · 已启用合计 ${providers.reduce((total, row) => total + (row.eagerIds?.length ?? 0), 0)} 个模型`

      const biliLine = (() => {
        if (bili === undefined) return { text: '读取中…', color: ui.muted }
        if (biliEnabled === false) return { text: '已关闭：不会改动 bili 的出口，模型请求按 bili 自己的设置走。', color: ui.muted }
        if (bili?.found !== true) return { text: BILI_LABEL['no-bili'] ?? '没有找到 bili 车道，未写入', color: ui.warning }
        const label = BILI_LABEL[String(bili.status)] ?? String(bili.status ?? '')
        const color = bili.status === 'rejected' || bili.status === 'error' ? ui.danger : bili.status === 'applied' ? ui.success : ui.muted
        const hosts = Array.isArray(bili.hosts) ? bili.hosts : []
        return { text: hosts.length === 0 ? `${label}（还没有需要代理的地址）` : `${label} · ${hosts.length} 个地址`, color }
      })()

      return h('div', { style: { padding: '4px 2px' } },
          h('h2', { style: { margin: '0 0 8px' } }, '模型管理'),
          h('nav', { 'aria-label': '模型管理页面', style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
            h(FilterButton, { active: tab === 'catalog', onClick: () => setTab('catalog') }, '上游目录'),
            h(FilterButton, { active: tab === 'visibility', onClick: () => { setReviewing(false); setTab('visibility') } }, '对话显示')),
          h(DisplayPanel, { active: tab === 'visibility', refreshKey: displayRevision }),
          h('div', { hidden: tab !== 'catalog' },
          h('p', { style: { margin: '0 0 10px', color: ui.muted, fontSize: '13px' } },
            '检查上游并把选中的模型加入 DSH。参数、停用和移除在官方「设置 → 模型」管理。'),
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' } },
            h('div', { style: { color: ui.muted, fontSize: '12px', lineHeight: '20px' } }, summary),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              h('span', {
                title: selfCheckRow?.at === undefined ? '还没有跑过自检' : `${selfCheckRow.ok === true ? '通过' : '有问题'} · ${formatTime(selfCheckRow.at)}`,
                style: { color: selfCheckRow === undefined ? ui.dim : selfCheckRow.ok === true ? ui.success : ui.danger, fontSize: '12px' },
              }, selfCheckRow === undefined ? '自检：未运行' : selfCheckRow.ok === true ? '最近一次自检通过' : `最近一次自检发现 ${selfCheckRow.failures?.length ?? 0} 个问题`),
              textButton('查看', () => setVerdict(selfCheckRow?.text ?? '还没有跑过自检。'), { disabled: false }),
              h('button', {
                type: 'button',
                onClick: selfCheck,
                disabled: busy !== '',
                style: { border: ui.border, borderRadius: '7px', padding: '6px 10px', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: busy === '' ? 'pointer' : 'default' },
              }, busy === 'selfcheck' ? '自检中…' : '自检'),
              h('button', {
                type: 'button',
                onClick: check,
                disabled: busy !== '',
                style: { border: ui.border, borderRadius: '7px', padding: '6px 12px', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px', cursor: busy === '' ? 'pointer' : 'default' },
              }, busy === 'check' ? '检查中…' : '立即检查'))),
          h('details', { style: { margin: '6px 0 12px' } },
            h('summary', { style: { color: ui.muted, marginBottom: '8px' } }, '连接与检查设置'),
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '10px 12px',
              marginBottom: '10px',
              border: ui.border,
              borderRadius: ui.radius,
              background: ui.subtle,
              height: '66px',
              boxSizing: 'border-box',
              overflow: 'hidden',
            },
          },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
              h('label', {
                htmlFor: 'model-sync-proxy',
                style: { fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: busy === '' ? 'pointer' : 'default' },
              }, '让需要代理的模型走系统代理'),
              h('div', {
                id: 'model-sync-proxy-note',
                role: 'status',
                title: bili?.error ?? biliLine.text,
                style: { color: biliLine.color, fontSize: '12px', lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              }, biliLine.text)),
            h(Switch, {
              id: 'model-sync-proxy',
              checked: biliEnabled,
              disabled: busy !== '',
              label: '让需要代理的模型走系统代理',
              note: 'model-sync-proxy-note',
              title: '模型请求由 bili 子进程发出，harness 里的全局代理开关影响不到它；这里改的是 bili 的出口表',
              onChange: toggleBili,
            })),
          h('details', { style: { marginBottom: '10px' } },
            h('summary', { style: { color: ui.dim, fontSize: '12px', cursor: 'pointer' } },
              `网络出口详情 · ${Array.isArray(bili?.rows) && bili.rows.length > 0 ? bili.rows.length : (Array.isArray(bili?.hosts) ? bili.hosts.length : 0)} 个地址 · bili ${bili?.origin ?? '(未找到)'}`),
            h('div', { style: { marginTop: '8px', fontSize: '12px', color: ui.muted, lineHeight: '1.8' } },
              h('div', null, '模型请求由 bili 子进程发出：唯一能改它出口的地方是 bili 的 providers 表，这里只写命中的地址，不动别的配置。'),
              (Array.isArray(bili?.rows) ? bili.rows : []).map((entry) => h('div', {
                key: entry.host,
                style: { fontFamily: ui.mono, fontSize: '11px', overflowWrap: 'anywhere' },
              }, `${entry.host} → ${entry.proxy ?? '直连'}${entry.proxy !== undefined && entry.owned === false
                // Not recorded in this plugin's ledger: an earlier version wrote
                // it, or the user did. Say so, because 撤销 will not touch it.
                ? '（不是本插件写的，撤销不会删）'
                : ''}`)),
              h('div', { style: { marginTop: '6px', display: 'flex', gap: '12px', flexWrap: 'wrap' } },
                textButton('立即同步', () => act('bili', () => call('bili', {})), { disabled: busy !== '' }),
                textButton(confirmLabel('revoke', '撤销插件的声明'), () => confirmed('revoke', () => act('bili', () => call('bili-revoke', {}))), { disabled: busy !== '' || (bili?.written ?? 0) === 0, tone: 'danger' }),
                h('span', { style: { color: ui.dim } }, bili?.configPath ?? '')),
              schedule.enabled === false
                ? h('div', { style: { color: ui.warning } }, '定时检查已关闭：只会在你点「立即检查」时读上游。')
                : null)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px', fontSize: '12px', color: ui.muted } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: busy === '' ? 'pointer' : 'default' } },
              h('input', {
                type: 'checkbox',
                checked: schedule.enabled !== false,
                disabled: busy !== '',
                onChange: (event) => act('settings', () => call('settings', { schedule: { enabled: event.target.checked, hour: schedule.hour ?? 9 } })),
              }),
              '定时检查'),
            h('input', {
              type: 'number',
              min: 0,
              max: 23,
              value: schedule.hour ?? 9,
              disabled: busy !== '' || schedule.enabled === false,
              onChange: (event) => {
                const hour = Number(event.target.value)
                if (!Number.isInteger(hour) || hour < 0 || hour > 23) return
                void act('settings', () => call('settings', { schedule: { enabled: schedule.enabled !== false, hour } }))
              },
              style: { width: '52px', height: '24px', padding: '0 6px', borderRadius: '6px', border: ui.border, background: 'transparent', color: 'inherit', fontSize: '12px' },
            }),
            h('span', null, ':00 自动检查（只读上游，结果留在面板等你确认）'))),
          message ? h('p', { style: { color: ui.success, fontSize: '13px', margin: '6px 0' } }, message) : null,
          error ? h('p', { style: { color: ui.danger, fontSize: '13px', margin: '6px 0', overflowWrap: 'anywhere' } }, error) : null,
          verdict === undefined
            ? null
            : h('div', { style: { border: ui.border, borderRadius: '8px', padding: '8px 10px', margin: '6px 0', background: ui.subtle } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
                h('strong', { style: { fontSize: '12px' } }, '自检结果'),
                textButton('关闭', () => setVerdict(undefined), { tone: 'muted' })),
              h('pre', { style: { margin: '6px 0 0', fontFamily: ui.mono, fontSize: '11px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, verdict)),
          providers.length === 0
            ? h('p', { style: { color: ui.muted } }, '还没有已配置的供应商。先在官方设置 → 模型中配置一个，再回来。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              providers.map((row) => h(ProviderCard, {
                key: row.provider,
                row,
                expanded: expanded === row.provider,
                onToggle: () => {
                  setExpanded((current) => (current === row.provider ? null : row.provider))
                  setQueries((current) => ({ ...current, [row.provider]: '' }))
                  setFilters((current) => ({ ...current, [row.provider]: 'all' }))
                },
                draft: draftFor(row.provider),
                query: queries[row.provider] ?? '',
                onQuery: (value) => setQueries((current) => ({ ...current, [row.provider]: value })),
                filter: filters[row.provider] ?? 'all',
                onFilter: (value) => setFilters((current) => ({ ...current, [row.provider]: value })),
                showAll: showAll[row.provider] === true,
                onShowAll: () => setShowAll((current) => ({ ...current, [row.provider]: true })),
                busy: busy !== '',
                onRowToggle,
                onGroupToggle,
                onUnignore: unignore,
                onRoute: route,
                onUnroute: unroute,
                routing: busy === 'gateway-route' || busy === 'gateway-unroute',
              }))),
          legacy.length > 0
            ? h(Section, { title: '待核对的旧版路由', count: legacy.length },
              h('p', { style: { margin: 0, color: ui.muted, fontSize: '12px' } },
                '请在 DSH「设置 → 模型」核对路由归属、模型配置和使用情况。'),
              h('code', null, legacy.map((entry) => entry.provider).join(', ')))
            : null,
          foreign.length > 0
            ? h(Section, { title: '设置里还有宿主不认识的供应商键', count: foreign.length },
              h('p', { style: { margin: 0, color: ui.muted, fontSize: '12px' } },
                '这些键不是本插件写的，面板不会动它们；列在这里是因为它们同样会让模型列表里多出条目。'),
              h('code', { style: { fontFamily: ui.mono, fontSize: '11px', overflowWrap: 'anywhere' } }, foreign.join(', ')))
            : null,
          problems.length > 0
            ? h(Section, { title: '需要处理的问题', count: problems.length },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: ui.muted } },
                problems.map((entry, index) => h('div', { key: `${entry.provider}-${index}`, style: { overflowWrap: 'anywhere' } }, `${entry.provider}：${entry.reason}`))))
            : null,
          pendingAdd === 0 ? null : h('div', {
            style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginTop: '12px' },
          },
            h('span', { role: 'status', style: { color: ui.muted, marginRight: 'auto' } }, `待加入 DSH ${pendingAdd} 个`),
            textButton('放弃选择', () => { setDrafts({}); setReviewing(false) }, { disabled: busy !== '' }),
            textButton('确认加入', () => { setShowInPicker(false); setReviewing(true) }, { disabled: busy !== '' })),
          reviewing && pendingAdd > 0 ? h(Section, { title: '加入 DSH 模型配置' },
            h('ul', null, providers.filter((row) => draftFor(row.provider).add.size > 0)
              .map((row) => h('li', { key: row.provider }, `${providerName(row)} · ${[...draftFor(row.provider).add].join('、')}`))),
            h('label', null, h('input', {
              type: 'checkbox', checked: showInPicker, disabled: busy !== '',
              onChange: (event) => setShowInPicker(event.target.checked),
            }), ' 同时在对话下拉框显示'),
            globalThis.__dshModelSyncSelectorVersion !== 1
              ? h('p', { role: 'status', style: { color: ui.warning } }, '原生选择器适配尚未加载。') : null,
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
              textButton('返回', () => setReviewing(false), { disabled: busy !== '' }),
              textButton(busy === 'apply' ? '加入中…' : `加入 ${pendingAdd} 个模型`, join, {
                disabled: busy !== '' || globalThis.__dshModelSyncSelectorVersion !== 1,
              }))) : null))
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
