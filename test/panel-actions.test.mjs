/**
 * The panel's bugs live in the seams between a click and the state it is
 * supposed to change, and the plain-render harness cannot see them: its
 * `useState` returns a do-nothing setter, so every click is a no-op that still
 * "renders fine". That is exactly how `textButton('清空', onClear)` shipped with
 * `onClear(event)` deleting `drafts["[object Object]"]` — the button looked
 * wired, the markup looked right, and the selection never cleared.
 *
 * So this file renders the real panel through a tiny hook runtime: `useState`
 * keeps its value per component instance, a click re-renders the panel, and the
 * assertion is about what the user can read afterwards ("待移除 1" gone) rather
 * than which prop was passed.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

const SOURCE = new URL('../lib/client.js', import.meta.url)

function createRuntime() {
  const slots = new Map()
  const cursor = new Map()
  let current = ''
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState(initial) {
      const values = slots.get(current) ?? []
      const index = cursor.get(current) ?? 0
      cursor.set(current, index + 1)
      if (index >= values.length) values[index] = typeof initial === 'function' ? initial() : initial
      slots.set(current, values)
      // The setter writes into the slot; the next render reads it back. Updates
      // are applied synchronously because the test drives renders by hand.
      const set = (next) => {
        values[index] = typeof next === 'function' ? next(values[index]) : next
      }
      return [values[index], set]
    },
  }
  return {
    react,
    // One hook list per component instance, identified by name + provider, so
    // two cards never share a query or an expansion flag.
    enter(key, run) {
      const previous = current
      current = key
      cursor.set(key, 0)
      try {
        return run()
      } finally {
        current = previous
      }
    },
  }
}

function instanceKey(element) {
  const name = typeof element.type === 'function' ? element.type.name || 'component' : String(element.type)
  const id = element.props?.row?.provider ?? element.props?.key ?? ''
  return `${name}:${id}`
}

function render(element, runtime) {
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map((child) => render(child, runtime))
  if (typeof element.type === 'function') {
    const children = element.children ?? []
    const props = { ...(element.props ?? {}), children: children.length === 1 ? children[0] : children }
    return render(runtime.enter(instanceKey(element), () => element.type(props)), runtime)
  }
  return { type: element.type, props: element.props ?? {}, children: render(element.children ?? [], runtime) }
}

/** Only tags remain after `render`, so this is a plain tree walk. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

async function mount(options = {}) {
  const source = await readFile(SOURCE, 'utf8')
  const runtime = createRuntime()
  const registered = []
  const calls = []
  const context = {
    window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
    console,
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body })
      if (typeof options.fetch === 'function') return options.fetch(url, init)
      return { ok: true, status: 200, async json() { return { ok: true, view: options.view } } }
    },
    setTimeout,
    clearTimeout,
    __dshModelSyncSelectorVersion: 1,
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  const module = registered[0].factory(() => runtime.react)
  let Panel
  module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => {
        Panel = component
        return () => undefined
      },
    },
  })

  // `view` is a prop because the reload lives in an effect and effects never run
  // here; everything else is a test seam (which card starts expanded).
  const element = () => runtime.react.createElement(Panel, { view: options.view, ...(options.props ?? {}) })
  const api = {
    calls,
    tree: render(element(), runtime),
    text() {
      return textOf(api.tree)
    },
    rerender() {
      api.tree = render(element(), runtime)
      return api.tree
    },
    buttons(label) {
      return findAll(api.tree, (node) => node.type === 'button' && textOf(node).trim() === label)
    },
    click(label, index = 0) {
      const button = api.buttons(label)[index]
      assert.ok(button, `no button labelled "${label}"`)
      button.props.onClick()
      return api.rerender()
    },
    /** The checkbox of the row whose label mentions this model id. */
    checkbox(id) {
      const label = findAll(api.tree, (node) => node.type === 'label' && textOf(node).includes(id))[0]
      assert.ok(label, `no row for "${id}"`)
      const input = findAll(label, (node) => node.type === 'input')[0]
      assert.ok(input, `no checkbox for "${id}"`)
      return input
    },
    toggle(id) {
      api.checkbox(id).props.onChange()
      return api.rerender()
    },
  }
  return api
}

function view(overrides = {}) {
  const rows = [
    {
      provider: 'alpha',
      displayName: 'alpha',
      baseURL: 'https://alpha.test/v1',
      api: 'openai-completions',
      explicitModels: true,
      eagerCount: 2,
      eagerIds: ['m-one', 'm-two'],
      ignored: [],
      check: {
        at: Date.now(),
        status: 'ok',
        protocol: 'openai-completions',
        via: 'proxy',
        upstreamCount: 3,
        added: [{ id: 'm-three' }],
        gone: [],
      },
    },
    {
      provider: 'locked',
      displayName: 'locked',
      baseURL: 'https://locked.test/v1',
      api: 'openai-completions',
      hasModelOverrides: true,
      eagerCount: 1,
      eagerIds: ['l-one'],
      ignored: [],
      check: { at: Date.now(), status: 'ok', protocol: 'openai-completions', upstreamCount: 1, added: [], gone: [] },
    },
  ]
  return {
    proxy: { enabled: false, available: true, url: 'http://127.0.0.1:7897', source: 'system' },
    schedule: { enabled: true, hour: 9 },
    summary: { at: Date.now(), providers: rows.length, added: 1 },
    providers: rows,
    problems: [],
    legacy: [],
    foreign: [],
    bili: { enabled: false, found: true, hosts: [], rows: [], written: [], status: 'disabled' },
    gateway: { enabled: false, running: false, entries: [] },
    snapshots: [],
    ...overrides,
  }
}

test('configured models are read-only in the upstream catalog', async () => {
  const panel = await mount({ view: view(), props: { expandedProvider: 'alpha' } })
  assert.match(panel.text(), /m-one/)
  assert.equal(findAll(panel.tree, (node) => node.type === 'label' && textOf(node).includes('m-one')).length, 0)
  assert.equal(panel.buttons('清空').length, 0)
  assert.equal(panel.buttons('恢复适配器默认目录').length, 0)
})

test('discarding an upstream draft leaves configured models alone', async () => {
  const panel = await mount({ view: view(), props: { expandedProvider: 'alpha' } })
  panel.toggle('m-three')
  assert.match(panel.text(), /待加入 DSH 1 个/)
  panel.click('放弃选择')
  assert.doesNotMatch(panel.text(), /待加入 DSH 1 个/)
  assert.match(panel.text(), /m-one/)
  assert.equal(panel.calls.length, 0)
})

test('a failed check keeps stale candidates visible and disables selecting them', async () => {
  const payload = view()
  payload.providers[0].check = { ...payload.providers[0].check, status: 'error', error: 'boom', lastSuccessAt: Date.now() }
  const panel = await mount({ view: payload, props: { expandedProvider: 'alpha' } })
  assert.match(panel.text(), /已保留/)
  assert.equal(panel.checkbox('m-three').props.disabled, true)
})

test('every button and switch survives a click without throwing', async () => {
  const panel = await mount({ view: view(), props: { expandedProvider: 'alpha' } })
  const targets = findAll(panel.tree, (node) => typeof node.props?.onClick === 'function' || typeof node.props?.onChange === 'function')
  assert.ok(targets.length > 6)
  // A DOM event, because some controls read `event.target` (the hour field).
  const event = { target: { checked: true, value: '9' } }
  for (const node of targets) {
    if (typeof node.props.onClick === 'function') node.props.onClick(event)
    if (typeof node.props.onChange === 'function') node.props.onChange(event)
  }
  // Handlers that call the API return promises; the rejection path must not
  // surface as an unhandled rejection either.
  await new Promise((resolve) => setTimeout(resolve, 0))
  panel.rerender()
  assert.ok(panel.text().length > 0)
})

test('possible legacy routes have no delete action', async () => {
  const panel = await mount({ view: view({ legacy: [{ provider: 'alpha-chat' }] }) })
  assert.match(panel.text(), /待核对的旧版路由/)
  assert.equal(panel.buttons('删除这些合成供应商').length, 0)
})

test('a save that fails halfway keeps only what is still pending', async () => {
  const payload = view()
  payload.providers.splice(1, 0, {
    provider: 'beta',
    displayName: 'beta',
    baseURL: 'https://beta.test/v1',
    api: 'openai-completions',
    explicitModels: true,
    eagerCount: 1,
    eagerIds: ['b-one'],
    ignored: [],
    check: { at: Date.now(), status: 'ok', protocol: 'openai-completions', upstreamCount: 2, added: [{ id: 'b-two' }], gone: [] },
  })
  const json = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return body },
  })
  const panel = await mount({
    view: payload,
    props: { expandedProvider: 'alpha' },
    // The host accepts beta and refuses alpha, which is the case that used to
    // strand the whole draft and make the retry fail with "already configured".
    fetch: async (url, init) => {
      if (String(url).endsWith('/apply')) {
        const body = JSON.parse(init.body)
        assert.equal(body.showInPicker, false)
        if (body.provider === 'alpha') throw new Error('boom')
        return json({ ok: true, written: ['b-two'] })
      }
      return json({ ok: true, view: payload })
    },
  })

  panel.toggle('m-three')
  // Expand the other card the way a user would, by clicking its header.
  const header = findAll(panel.tree, (node) => node.type === 'button' && textOf(node).includes('beta'))[0]
  assert.ok(header, 'no header button for beta')
  header.props.onClick()
  panel.rerender()
  panel.toggle('b-two')
  assert.match(panel.text(), /待加入 DSH 2 个/)

  panel.click('确认加入')
  assert.equal(panel.checkbox('同时在对话下拉框显示').props.checked, false)
  panel.click('加入 2 个模型')
  // Several awaits deep (each call settles one host round trip), so give the
  // microtask queue more than one turn before reading the panel.
  await new Promise((resolve) => setTimeout(resolve, 50))
  panel.rerender()

  // beta landed and left the draft; alpha did not, and is still queued.
  assert.match(panel.text(), /待加入 DSH 1 个/)
  assert.match(panel.text(), /alpha/)
})
