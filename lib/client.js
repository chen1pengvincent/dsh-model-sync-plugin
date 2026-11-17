/**
 * Client half of the 模型更新 surface.
 *
 * One slot, one screen, and the same interaction grammar the panel had before:
 * a summary line with the only two global actions, a transport row with a
 * switch, one collapsible card per configured provider, and a save bar at the
 * bottom that writes everything the user ticked. The v2 additions (self-check,
 * gateway routing, the bili exit list) are folded into the card's own
 * 「维护与诊断」 so the common case stays a list of models.
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
      { id: 'addable', label: '上游新增' },
      { id: 'enabled', label: '已启用' },
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
      const { row, expanded, onToggle, draft, query, onQuery, filter, onFilter, showAll, onShowAll, busy, onRowToggle, onGroupToggle, onClear, onUnignore, onRoute, onUnroute, onRestore, routing, confirmed, confirmLabel } = props
      const check = row.check
      const status = check === undefined ? 'needs-check' : String(check.status ?? 'error')
      const addable = Array.isArray(check?.added) ? check.added : []
      const enabled = Array.isArray(row.eagerIds) ? row.eagerIds : []
      const gone = Array.isArray(check?.gone) ? check.gone : []
      const ignored = Array.isArray(row.ignored) ? row.ignored : []
      // A check answers "what is new upstream". It has no bearing on removing a
      // model that is already configured: that list is right here, and blocking
      // it strands the user on exactly the routes a check cannot reach
      // (no directory interface, no endpoint, upstream down).
      const editableRows = status === 'ok'

      const allRows = useMemo(() => {
        const rows = []
        // A route that inherits the adapter's catalog cannot express "minus one":
        // the host refuses the write, so the row must not look removable here.
        const removable = row.explicitModels === true
        for (const id of enabled) rows.push({ id, kind: 'enabled', removable })
        for (const model of addable) {
          if (enabled.includes(model.id)) continue
          rows.push({ id: model.id, name: model.name, kind: 'addable' })
        }
        for (const id of ignored) {
          if (enabled.includes(id) || addable.some((model) => model.id === id)) continue
          rows.push({ id, kind: 'ignored' })
        }
        return rows.sort(compareRows)
      }, [enabled.join('\u0000'), addable.map((model) => model.id).join('\u0000'), ignored.join('\u0000')])

      const normalizedQuery = query.trim().toLowerCase()
      const filtered = allRows.filter((entry) => {
        if (normalizedQuery.length > 0 && !`${entry.id} ${entry.name ?? ''}`.toLowerCase().includes(normalizedQuery)) return false
        if (filter === 'addable') return entry.kind === 'addable'
        if (filter === 'enabled') return entry.kind === 'enabled'
        return true
      })
      const visible = showAll ? filtered : filtered.slice(0, CARD_LIMIT)
      const groups = vendorGroups(visible)
      const pendingRemovals = draft.remove.size
      const pendingAdds = draft.add.size
      const atLimit = row.hasModelOverrides === true

      // "清空" is an explicit "deselect everything" action, as it was in the
      // version this panel is modelled on. Added rows are not part of the checked
      // set, so deleting the draft alone leaves the already-enabled rows ticked —
      // which is exactly what the user reported as "clear does nothing".
      const clearPlan = (rows) => {
        const removable = rows.filter((entry) => entry.kind === 'enabled' && entry.removable !== false).map((entry) => entry.id)
        const kept = removable[0]
        return { removals: removable.filter((id) => id !== kept), kept }
      }

      const renderRow = (entry) => {
        const isAddable = entry.kind === 'addable'
        const isIgnored = entry.kind === 'ignored'
        const checked = isAddable ? draft.add.has(entry.id) : !draft.remove.has(entry.id)
        // `atLimit` (modelOverrides) makes the host refuse *any* write to this
        // route, additions and removals alike, so nothing here may look selectable.
        const pinned = entry.kind === 'enabled' && entry.removable === false
        const disabled = busy || isIgnored || atLimit || pinned || (isAddable && !editableRows)
        const title = isIgnored
          ? '已加入忽略名单：下次检查不会再提示它，可在「维护与诊断」里清除'
          : atLimit
            ? '这个供应商设置了 modelOverrides，不能改模型清单'
            : pinned
              ? '这条路由用的是内置目录：目录里的模型不能单独移除（只能在官方设置里停用供应商，或先把整份清单物化下来）'
              : undefined
        return h('label', {
          key: entry.id,
          title,
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '7px',
            padding: '3px 0',
            fontSize: '13px',
            lineHeight: '18px',
            cursor: disabled ? 'default' : 'pointer',
          },
        },
          h('input', {
            type: 'checkbox',
            checked,
            disabled,
            onChange: () => onRowToggle(row.provider, entry),
            style: { flex: 'none', margin: '2px 0 0' },
          }),
          h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, entry.name && entry.name !== entry.id ? `${entry.id}` : entry.id),
          entry.name && entry.name !== entry.id ? h('span', { style: { color: ui.dim, fontSize: '11px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name) : null,
          isAddable ? tag('新增', ui.blue) : null,
          !isAddable && !isIgnored && draft.remove.has(entry.id) ? tag('待移除', ui.warning) : null,
          !isAddable && !isIgnored && !draft.remove.has(entry.id) ? tag('已启用', ui.dim) : null,
          isIgnored ? tag('已忽略', ui.dim) : null,
        )
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
          addable.length > 0 ? h('span', { style: { color: ui.blue, fontSize: '12px', whiteSpace: 'nowrap' } }, `上游新增 ${addable.length}`) : null,
          statusText ? h('span', { style: { color: warning ? ui.danger : ui.dim, fontSize: '12px', whiteSpace: 'nowrap' } }, statusText) : null,
          pendingAdds > 0 ? h('span', { style: { color: ui.blue, fontSize: '12px', whiteSpace: 'nowrap' } }, `待加入 ${pendingAdds}`) : null,
          pendingRemovals > 0 ? h('span', { style: { color: ui.warning, fontSize: '12px', whiteSpace: 'nowrap' } }, `待移除 ${pendingRemovals}`) : null,
          row.routedThroughGateway === true ? h('span', { style: { color: ui.dim, fontSize: '12px', whiteSpace: 'nowrap' } }, '经网关') : null,
          h('span', { style: { marginLeft: 'auto', color: ui.dim, fontSize: '12px' } }, expanded ? '▾' : '▸')),
        expanded
          ? h('div', { style: { borderTop: ui.border, padding: '10px 14px 14px' } },
            h('p', { style: { margin: '0 0 8px', color: ui.muted, fontSize: '12px' } },
              status === 'adapter'
                ? `模型配置：已启用 ${enabled.length} 个 · 这个供应商没有可列举的目录接口，不能在这里新增（可以在官方设置里手动增删）`
                : status === 'no-endpoint'
                  ? `模型配置：已启用 ${enabled.length} 个 · 插件不知道这条路由该问哪个地址（地址写在每个模型上），所以列不出上游新增；下面照常可以取消勾选来移除已有模型`
                  : status === 'ok'
                  ? `模型配置：已启用 ${enabled.length} 个 · 上游新增 ${addable.length} 个${ignored.length > 0 ? ` · 已忽略 ${ignored.length} 个` : ''}`
                  : `模型配置：已启用 ${enabled.length} 个 · 还没有成功检查过上游目录`),
            status === 'error' && check?.error ? h('p', { role: 'status', style: { margin: '0 0 8px', color: ui.danger, fontSize: '12px' } }, `检查失败：${check.error}`) : null,
            atLimit ? h('p', { role: 'status', style: { margin: '0 0 8px', color: ui.warning, fontSize: '12px' } }, '这个供应商设置了 modelOverrides，不能改模型清单；请在官方设置里编辑。') : null,
            gone.length > 0
              ? h('p', { style: { margin: '0 0 8px', color: ui.warning, fontSize: '12px', overflowWrap: 'anywhere' } },
                row.explicitModels === true
                  ? `上次检查发现上游已下架 ${gone.length} 个：${previewList(gone)}（仅提示，不自动删除）`
                  // An inherited list is the catalog's, and the catalog is often
                  // wider than what one account may use; calling those "removed
                  // upstream" would accuse the user of a problem they do not have.
                  : `上游清单里没有这 ${gone.length} 个（它们来自内置目录，可能是这个账号没开通）：${previewList(gone)}（仅提示，不自动删除）`)
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
                  textButton('全选', () => onGroupToggle(row.provider, filtered.filter((entry) => entry.kind === 'addable').map((entry) => entry.id), true), {
                    disabled: busy || atLimit || filtered.every((entry) => entry.kind !== 'addable'),
                  }),
                  textButton('清空', () => onClear(row.provider, clearPlan(allRows)), {
                    disabled: busy || (draft.add.size === 0 && clearPlan(allRows).removals.length === 0),
                    tone: 'muted',
                    title: '取消这张卡的全部勾选：待加入的清掉，已启用的转成待移除（至少保留一个）',
                  })),
                groups.length === 0
                  ? h('p', { style: { color: ui.dim, fontSize: '12px', margin: '8px 0' } }, '没有匹配的模型')
                  : h('div', { style: { columnWidth: '240px', columnGap: '10px' } },
                    groups.map((group) => {
                      const groupAddable = group.rows.filter((entry) => entry.kind === 'addable')
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
                    h('div', null, `已忽略 ${ignored.length} 个上游新增：${ignored.slice(0, 12).join('、')}${ignored.length > 12 ? ` 等 ${ignored.length} 个` : ''}`),
                    textButton('清除忽略名单', () => onUnignore(row.provider), { disabled: busy }))
                  : null,
                h('div', { style: { marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                  h('span', null, row.routedThroughGateway === true
                    ? `协议网关：已收拢协议${check?.protocol ? `为 ${PROTOCOL_LABEL[check.protocol] ?? check.protocol}` : ''}，请求经本机网关转发`
                    : '协议网关：未启用。只有当这条路由需要服务「目录里没有协议」的模型时才需要它'),
                  row.routedThroughGateway === true
                    ? textButton('停止转发', () => onUnroute(row.provider), { disabled: busy || routing, tone: 'danger' })
                    : textButton('交给网关', () => onRoute(row.provider), { disabled: busy || routing || typeof row.baseURL !== 'string' || row.baseURL.length === 0 })),
                row.explicitModels === true
                  ? h('div', { style: { marginTop: '6px' } },
                    textButton(confirmLabel(`restore:${row.provider}`, '恢复适配器默认目录'), () => confirmed(`restore:${row.provider}`, () => onRestore(row.provider)), { disabled: busy, tone: 'danger' }),
                    h('span', { style: { color: ui.dim, marginLeft: '6px' } }, '删掉这条路由显式声明的模型表，回到 DSH 自带目录'))
                  : null,
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

    /**
     * A small self-dismissing confirmation. The host does not export one, and a
     * panel that silently disappears after a write is indistinguishable from a
     * panel that failed, so it carries its own.
     */
    function Toast({ text, holdMs, onDone }) {
      useEffect(() => {
        const timer = setTimeout(() => onDone(), holdMs)
        return () => clearTimeout(timer)
      }, [holdMs, onDone])
      return h('div', {
        role: 'status',
        style: {
          position: 'fixed',
          left: '50%',
          bottom: '28px',
          transform: 'translateX(-50%)',
          zIndex: 60,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          maxWidth: 'min(520px, calc(100vw - 48px))',
          padding: '9px 12px',
          borderRadius: '8px',
          background: 'var(--dsw-alias-bg-layer-3, #24292f)',
          color: 'var(--dsw-alias-label-primary, #ffffff)',
          boxShadow: '0 8px 24px rgba(27,31,36,.24)',
          fontSize: '13px',
        },
      },
        h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, text),
        h('button', {
          type: 'button',
          onClick: onDone,
          'aria-label': '关闭提示',
          style: { border: 'none', background: 'none', color: 'inherit', padding: 0, cursor: 'pointer', fontSize: '13px', opacity: 0.8 },
        }, '✕'))
    }

    function Panel(props) {
      const [view, setView] = useState(props?.view ?? null)
      const [drafts, setDrafts] = useState({})
      const [expanded, setExpanded] = useState(props?.expandedProvider ?? null)
      const [queries, setQueries] = useState({})
      const [filters, setFilters] = useState({})
      const [showAll, setShowAll] = useState({})
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [toast, setToast] = useState(null)
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

      const showToast = useCallback((text) => setToast({ text, seq: Date.now() }), [])

      const draftFor = (provider) => drafts[provider] ?? { add: new Set(), remove: new Set() }

      const onRowToggle = useCallback((provider, entry) => {
        setDrafts((current) => {
          const draft = current[provider] ?? { add: new Set(), remove: new Set() }
          const add = new Set(draft.add)
          const remove = new Set(draft.remove)
          if (entry.kind === 'addable') {
            if (add.has(entry.id)) add.delete(entry.id)
            else add.add(entry.id)
          } else if (entry.kind === 'enabled') {
            if (remove.has(entry.id)) remove.delete(entry.id)
            else remove.add(entry.id)
          }
          return { ...current, [provider]: { add, remove } }
        })
      }, [])

      const onGroupToggle = useCallback((provider, ids, value) => {
        setDrafts((current) => {
          const draft = current[provider] ?? { add: new Set(), remove: new Set() }
          const add = new Set(draft.add)
          for (const id of ids) {
            if (value) add.add(id)
            else add.delete(id)
          }
          return { ...current, [provider]: { add, remove: new Set(draft.remove) } }
        })
      }, [])

      const onClear = useCallback((provider, plan) => {
        const removals = Array.isArray(plan?.removals) ? plan.removals : []
        setDrafts((current) => {
          const next = { ...current }
          if (removals.length === 0) {
            delete next[provider]
            return next
          }
          next[provider] = { add: new Set(), remove: new Set(removals) }
          return next
        })
        if (plan?.kept !== undefined) showToast(`至少保留一个模型「${plan.kept}」，不能清空全部`)
      }, [showToast])

      const save = useCallback(async () => {
        const results = view?.providers ?? []
        const plan = results
          .map((row) => ({ row, draft: draftFor(row.provider) }))
          .filter((entry) => entry.draft.add.size > 0 || entry.draft.remove.size > 0)
        if (plan.length === 0) return
        setBusy('apply')
        setError('')
        setMessage('')
        const failures = []
        const notes = []
        let added = 0
        let removed = 0
        // Every item leaves the draft the moment the host accepts it. A save that
        // stopped halfway used to leave the whole draft in place, so the retry
        // re-sent ids that were already written and the host refused them as
        // "already configured" — a dead end with no way to tell what had landed.
        const settle = (provider, kind, ids) => {
          if (ids.length === 0) return
          setDrafts((current) => {
            const previous = current[provider]
            if (previous === undefined) return current
            const next = { ...current }
            const remaining = { add: new Set(previous.add), remove: new Set(previous.remove) }
            for (const id of ids) remaining[kind].delete(id)
            if (remaining.add.size === 0 && remaining.remove.size === 0) delete next[provider]
            else next[provider] = remaining
            return next
          })
        }
        for (const { row, draft } of plan) {
          if (draft.add.size > 0) {
            const ids = [...draft.add]
            try {
              const outcome = await call('apply', { provider: row.provider, ids })
              const written = Array.isArray(outcome?.written) ? outcome.written.map(String) : ids
              added += written.length
              settle(row.provider, 'add', written.length > 0 ? written : ids)
            } catch (err) {
              failures.push(`${providerName(row)}：${err.message}`)
            }
          }
          for (const id of [...draft.remove]) {
            try {
              const outcome = await call('remove', { provider: row.provider, id })
              removed += 1
              settle(row.provider, 'remove', [id])
              // Removing the last model deletes the list, and the route falls back
              // to the built-in catalog. The host explains that; it must not be
              // swallowed, or the model looks like it grew back on its own.
              if (typeof outcome?.note === 'string' && outcome.note.length > 0) notes.push(`${row.provider}：${outcome.note}`)
            } catch (err) {
              failures.push(`${providerName(row)}：${err.message}`)
            }
          }
        }
        setError(failures.join('；'))
        if (notes.length > 0) setMessage(notes.join('；'))
        if (added > 0 || removed > 0) showToast(`已保存：加入 ${added} 个 · 移除 ${removed} 个`)
        try {
          await refresh()
        } catch (err) {
          setError((current) => [current, `保存结果已返回，但读取最新状态失败：${err.message}`].filter(Boolean).join('；'))
        } finally {
          setBusy('')
        }
      }, [draftFor, refresh, showToast, view])

      // These three delete something the user cannot get back from this panel
      // (a materialized model list, the plugin's egress declarations, the leftover
      // provider keys). The previous version asked once via a modal; asking twice
      // is cheaper than a modal and impossible to click through by accident.
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
      const restore = useCallback((provider) => act('restore', () => call('restore', { provider })), [act])

      const providers = view?.providers ?? []
      const pendingAdd = providers.reduce((total, row) => total + draftFor(row.provider).add.size, 0)
      const pendingRemove = providers.reduce((total, row) => total + draftFor(row.provider).remove.size, 0)
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
            : `上次检查 ${formatTime(view.lastCheckAt)} · ${changedProviders.length} 个供应商有上游新增（${totalAdded} 项） · 已启用合计 ${providers.reduce((total, row) => total + (row.eagerIds?.length ?? 0), 0)} 个模型`

      const biliLine = (() => {
        if (bili === undefined) return { text: '读取中…', color: ui.muted }
        if (biliEnabled === false) return { text: '已关闭：不会改动 bili 的出口，模型请求按 bili 自己的设置走。', color: ui.muted }
        if (bili?.found !== true) return { text: BILI_LABEL['no-bili'] ?? '没有找到 bili 车道，未写入', color: ui.warning }
        const label = BILI_LABEL[String(bili.status)] ?? String(bili.status ?? '')
        const color = bili.status === 'rejected' || bili.status === 'error' ? ui.danger : bili.status === 'applied' ? ui.success : ui.muted
        const hosts = Array.isArray(bili.hosts) ? bili.hosts : []
        return { text: hosts.length === 0 ? `${label}（还没有需要代理的地址）` : `${label} · ${hosts.length} 个地址`, color }
      })()

      return h(React.Fragment, null,
        h('div', { style: { padding: '4px 2px' } },
          h('h2', { style: { margin: '0 0 3px' } }, '模型更新'),
          h('p', { style: { margin: '0 0 10px', color: ui.muted, fontSize: '13px' } },
            '只改已配置供应商的模型清单：勾选上游新增的模型、取消勾选即可移除。不会新增供应商，也不会改动供应商本身。'),
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
            h('span', null, ':00 自动检查（只读上游，结果留在面板等你确认）')),
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
                // The card knows its own removals (only it has the row list), so it
                // passes the plan through; wrapping the provider id here dropped it.
                onClear,
                onUnignore: unignore,
                onRoute: route,
                onUnroute: unroute,
                onRestore: restore,
                confirmed,
                confirmLabel,
                routing: busy === 'gateway-route' || busy === 'gateway-unroute',
              }))),
          legacy.length > 0
            ? h(Section, { title: '上一版插件留下的合成供应商', count: legacy.length },
              h('p', { style: { margin: 0, color: ui.muted, fontSize: '12px' } },
                '这些键是旧版本为了跨协议而造的，它们会让官方模型列表里多出供应商。删掉它们不会影响任何真实配置。'),
              h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
                h('code', { style: { fontFamily: ui.mono, fontSize: '11px', overflowWrap: 'anywhere' } }, legacy.map((entry) => entry.provider).join(', ')),
                textButton(confirmLabel('prune', '删除这些合成供应商'), () => confirmed('prune', () => act('prune', () => call('prune', {}))), { disabled: busy !== '', tone: 'danger' })))
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
          providers.length === 0
            ? null
            : h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginTop: '16px', paddingTop: '12px', borderTop: ui.border } },
              h('span', { style: { color: ui.muted, fontSize: '12px' } },
                pendingAdd > 0 || pendingRemove > 0 ? `待保存：加入 ${pendingAdd} 个 · 移除 ${pendingRemove} 个` : '没有待保存的变更'),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                pendingAdd > 0 || pendingRemove > 0
                  ? textButton('清空全部待保存选择', () => setDrafts({}), { disabled: busy !== '', tone: 'muted' })
                  : null,
                h('button', {
                  type: 'button',
                  onClick: save,
                  disabled: (pendingAdd === 0 && pendingRemove === 0) || busy !== '',
                  style: {
                    border: 'none',
                    borderRadius: '7px',
                    padding: '7px 14px',
                    background: (pendingAdd > 0 || pendingRemove > 0) && busy === '' ? ui.blue : ui.subtle,
                    color: (pendingAdd > 0 || pendingRemove > 0) && busy === '' ? '#fff' : ui.dim,
                    font: 'inherit',
                    fontSize: '13px',
                    cursor: (pendingAdd > 0 || pendingRemove > 0) && busy === '' ? 'pointer' : 'default',
                  },
                }, busy === 'apply' ? '保存中…' : '保存全部变更')))),
        toast === null
          ? null
          : h(Toast, {
            key: toast.seq,
            text: toast.text,
            holdMs: 5000,
            onDone: () => setToast((current) => (current !== null && current.seq === toast.seq ? null : current)),
          }))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-sync',
        order: 30,
        label: () => '模型更新',
      }, Panel))
    }

    const module = { apply, inject: ['slots'] }
    return module
  },
})
