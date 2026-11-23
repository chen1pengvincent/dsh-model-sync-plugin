/**
 * The client half is served to the browser verbatim — no bundler, no type check,
 * no test ever runs it. A typo there is invisible until the panel is opened,
 * and the harness reports it as "loaded without registering <id>", which says
 * nothing about which line broke.
 *
 * So this test does the one thing that catches that class of failure: it loads
 * the real file in a sandbox with a fake `__ModuleLoader__` and a fake `react`,
 * checks that the registration id matches the package name, then renders the
 * panel through a fake slot registry and asserts the markup is produced from a
 * representative payload.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

const SOURCE = new URL('../lib/client.js', import.meta.url)
const PACKAGE = new URL('../package.json', import.meta.url)

/** Enough of React to render elements as plain trees, which is all the assertions need. */
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => undefined],
}

/**
 * Flatten a rendered tree, so an assertion can look for text instead of
 * structure. Function components are invoked here because the stub returns
 * elements rather than rendering them: a row is an element whose `type` is
 * `ProviderRow`, and nothing would ever call it otherwise.
 */
function textOf(node) {
  if (node === undefined || node === null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'function') {
    const children = node.children.length === 1 ? node.children[0] : node.children
    return textOf(node.type({ ...(node.props ?? {}), children }))
  }
  return textOf(node.children ?? node.props?.children)
}

/**
 * Visit every element in a rendered tree, expanding function components on the
 * way. Used to reach handlers, which `textOf` deliberately throws away.
 */
function walk(node, visit) {
  if (node === undefined || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node.type === 'function') {
    visit(node)
    const children = node.children.length === 1 ? node.children[0] : node.children
    walk(node.type({ ...(node.props ?? {}), children }), visit)
    return
  }
  visit(node)
  walk(node.children ?? node.props?.children, visit)
}

async function loadClient(options = {}) {
  const source = await readFile(SOURCE, 'utf8')
  const registered = []
  const context = {
    window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
    __dshModelSyncSelectorVersion: 1,
    console,
    fetch: options.fetch ?? (async () => { throw new Error('the panel must not fetch during render') }),
    setTimeout,
    clearTimeout,
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  return { registered, context, react: options.react ?? REACT_STUB }
}

test('the bundle registers an id that matches the package name', async () => {
  const manifest = JSON.parse(await readFile(PACKAGE, 'utf8'))
  const { registered } = await loadClient()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, manifest.name)
  assert.equal(typeof registered[0].factory, 'function')
})

test('the factory only needs react, and returns a module with apply/inject', async () => {
  const { registered } = await loadClient()
  const requested = []
  const module = registered[0].factory((name) => {
    requested.push(name)
    assert.equal(name, 'react')
    return REACT_STUB
  })
  assert.deepEqual(requested, ['react'])
  assert.equal(typeof module.apply, 'function')
  // The bundle runs in a separate VM realm, so the array has that realm's
  // prototype; compare contents, not identity.
  assert.deepEqual(Array.from(module.inject), ['slots'])
})

test('apply registers exactly one settings section and nothing else', async () => {
  const { registered } = await loadClient()
  const module = registered[0].factory(() => REACT_STUB)
  const sections = []
  module.apply({
    slots: {
      inject: (name, factory) => {
        assert.equal(name, 'settings.section')
        factory()
      },
      register: (options, component) => {
        sections.push({ options, component })
        return () => undefined
      },
    },
  })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].options.id, 'model-sync')
  assert.equal(sections[0].options.order, 30)
  assert.equal(sections[0].options.label(), '模型管理')
  assert.equal(typeof sections[0].component, 'function')
})

test('the panel renders providers, legacy keys and the bili egress block', async () => {
  const { registered } = await loadClient()
  const module = registered[0].factory(() => REACT_STUB)
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

  const payload = {
    proxy: { enabled: true, available: true, url: 'http://127.0.0.1:7897', source: 'system' },
    schedule: { enabled: true, hour: 9 },
    summary: { at: Date.now(), providers: 1, added: 2 },
    providers: [{
      provider: 'opencode-go',
      displayName: 'opencode-go',
      baseURL: 'https://opencode.ai/zen/go',
      api: 'openai-completions',
      explicitModels: true,
      eagerCount: 20,
      eagerIds: ['foo-9'],
      check: {
        at: Date.now(),
        status: 'ok',
        protocol: 'openai-completions',
        via: 'proxy',
        upstreamCount: 29,
        added: [{ id: 'foo-9', name: 'foo-9' }],
        gone: [],
      },
      ignored: [],
    }],
    problems: [],
    legacy: [{ provider: 'opencode-chat', parent: 'opencode' }],
    bili: {
      enabled: true,
      found: true,
      origin: 'http://127.0.0.1:18787',
      hostss: [],
      hosts: ['generativelanguage.googleapis.com'],
      rows: [{ host: 'generativelanguage.googleapis.com', key: 'https://generativelanguage.googleapis.com', proxy: 'http://127.0.0.1:7897', present: true }],
      written: ['https://generativelanguage.googleapis.com'],
      status: 'applied',
    },
    gateway: {
      enabled: true,
      running: true,
      port: 41234,
      url: 'http://127.0.0.1:41234',
      entries: [{ provider: 'opencode-go', models: 20, inbound: 'openai-completions', addedAfterRouting: 2 }],
    },
    snapshots: [],
  }

  // The empty state must not throw: a malformed element during render is turned
  // by the harness into a blank settings section with no explanation.
  assert.ok(textOf(Panel({})).length > 0)

  // The populated state is the one that ships. It is seeded through props because
  // the reload lives in an effect, and effects never run here.
  const populated = textOf(Panel({ view: payload }))
  // The template is the one the panel had before this rewrite: a summary line, a
  // transport switch, one collapsed card per provider, and a save bar. Nothing
  // here should need a click to read.
  for (const expected of ['模型管理', '勾选要在对话下拉框中显示的模型', 'opencode-go', '已显示 1 / 1 个', '网络出口详情', 'opencode-chat']) {
    assert.ok(populated.includes(expected), `the populated panel must render "${expected}"`)
  }

  // A payload from a half-upgraded host (no bili, no gateway, no snapshots) must
  // degrade to the parts it does have, not throw.
  const sparse = textOf(Panel({ view: { providers: [], problems: [], legacy: [], schedule: { enabled: false, hour: 9 } } }))
  assert.ok(sparse.length > 0)

  // A problem row from the state guard is shown, because a replaced ledger that
  // looks like an empty one is the difference between "nothing to do" and
  // "something went wrong".
  const withProblem = textOf(Panel({ view: { ...payload, problems: [{ provider: 'state', reason: 'a state file from another version was archived as /x.json' }] } }))
  assert.ok(withProblem.includes('archived as'))
})

test('every toggle opens, and every button is wired', async () => {
  // `useState` is forced to `true`, so rows render in their expanded form. The
  // collapsed-by-default layout meant the expanded branch was never executed by
  // any test -- the same blind spot that hid a missing comma in `client.js`.
  const expanded = {
    ...REACT_STUB,
    useState: (value) => [typeof value === 'boolean' ? true : (typeof value === 'function' ? value() : value), () => undefined],
  }
  const payload = {
    proxy: { enabled: true, available: true, url: 'http://127.0.0.1:7897', source: 'system' },
    schedule: { enabled: true, hour: 9 },
    providers: [{
      provider: 'opencode-go',
      displayName: 'opencode-go',
      baseURL: 'https://opencode.ai/zen/go',
      api: 'openai-completions',
      explicitModels: true,
      eagerCount: 20,
      eagerIds: ['foo-9', 'bar-3'],
      check: {
        at: new Date().toISOString(),
        status: 'ok',
        protocol: 'openai-completions',
        via: 'proxy',
        upstreamCount: 29,
        added: [{ id: 'foo-9', name: 'foo-9' }],
        gone: [{ id: 'old-1', name: 'old-1' }],
      },
      ignored: ['skip-me'],
    }],
    problems: [],
    legacy: [{ provider: 'opencode-chat', parent: 'opencode' }],
    foreign: ['opencode-go-responses'],
    bili: { enabled: true, found: true, origin: 'http://127.0.0.1:18787', hosts: ['generativelanguage.googleapis.com'], rows: [], written: [], status: 'applied' },
    gateway: { enabled: true, running: true, port: 41234, url: 'http://127.0.0.1:41234', entries: [{ provider: 'opencode-go', models: 20 }] },
    snapshots: ['before-apply-1.json'],
    lastCheckAt: '2026-11-16 07:00',
  }

  const { registered } = await loadClient({
    react: expanded,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, view: payload }) }),
  })
  const module = registered[0].factory(() => expanded)
  let Panel
  module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { Panel = component; return () => undefined },
    },
  })

  const tree = Panel({ view: payload, expandedProvider: 'opencode-go' })
  const text = textOf(tree)
  // The expanded row must render ids from a list of objects: an earlier version
  // printed `[object Object]` here, which is why `check.added` is an array.
  assert.ok(text.includes('foo-9'), 'the expanded row lists the proposed ids')
  assert.ok(text.includes('bar-3'), 'the expanded row lists the effective ids')
  assert.ok(text.includes('维护与诊断'), 'the diagnostics fold is there for the rare cases')
  assert.ok(text.includes('上次检查'), 'the last check is dated')

  const handlers = []
  walk(tree, (node) => {
    if (typeof node.props?.onClick === 'function') handlers.push(node.props.onClick)
  })
  assert.ok(handlers.length >= 4, `expected the panel to offer several buttons, saw ${String(handlers.length)}`)
  for (const handler of handlers) {
    // A handler that throws on click is a dead button; catching it here is the
    // only chance before a user finds it.
    assert.doesNotThrow(() => handler(), 'every button must be callable')
  }
})

test('the hour field posts the typed hour and refuses everything else', async () => {
  // Everything else in the panel is a button; this is the only control that
  // carries a value, so it is the only place a `hour: NaN` could reach the
  // settings. Numbers out of range must be dropped without posting.
  const payload = {
    providers: [],
    schedule: { enabled: true, hour: 9 },
    problems: [],
    legacy: [],
    foreign: [],
  }
  const posts = []
  const { registered } = await loadClient({
    react: { ...REACT_STUB, useState: (value) => [typeof value === 'function' ? value() : value, () => undefined] },
    fetch: async (url, init) => {
      posts.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, view: payload }) }
    },
  })
  const module = registered[0].factory(() => ({ ...REACT_STUB }))
  let Panel
  module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { Panel = component; return () => undefined },
    },
  })

  const tree = Panel({ view: payload })
  const changed = []
  walk(tree, (node) => {
    if (node.type === 'select' && typeof node.props.onChange === 'function') changed.push(node.props.onChange)
  })
  assert.equal(changed.length, 1, 'the panel must offer exactly one hour field')

  for (const hour of [24, -1, 3.5]) changed[0]({ target: { value: String(hour) } })
  assert.equal(posts.length, 0, 'an impossible hour must not reach the settings')

  changed[0]({ target: { value: '7' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posts.length, 1, 'a valid hour posts exactly one settings write')
  assert.deepEqual(posts[0].body, { schedule: { enabled: true, hour: 7 } })
})

test('a card that failed to check still lets existing models be hidden', async () => {
  // Unchecking an enabled model is a write about what is already configured; it
  // does not need the upstream listing. Locking the whole card when the check
  // failed is what left the user unable to change anything on four cards.
  const expanded = {
    ...REACT_STUB,
    useState: (value) => [typeof value === 'boolean' ? true : (typeof value === 'function' ? value() : value), () => undefined],
  }
  const payload = {
    proxy: { enabled: false, available: true, url: 'http://127.0.0.1:7897', source: 'system' },
    schedule: { enabled: true, hour: 9 },
    providers: [{
      provider: 'opencode',
      displayName: 'opencode',
      api: undefined,
      eagerCount: 1,
      eagerIds: ['kept-1'],
      check: { at: Date.now(), status: 'error', error: 'this route declares no baseURL', added: [{ id: 'new-2' }], gone: [] },
      ignored: [],
    }],
    problems: [],
    legacy: [],
  }
  const { registered } = await loadClient({ react: expanded, fetch: async () => ({ ok: true, json: async () => ({ ok: true, view: payload }) }) })
  const module = registered[0].factory(() => expanded)
  let Panel
  module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { Panel = component; return () => undefined },
    },
  })

  const boxes = []
  walk(Panel({ view: payload, expandedProvider: 'opencode' }), (node) => {
    if (node.type === 'input' && node.props?.type === 'checkbox') boxes.push(node.props)
  })
  assert.ok(boxes.length >= 2, 'the expanded card must render at least two checkboxes')
  const kept = boxes.find((props) => props['aria-label']?.includes('kept-1'))
  const added = boxes.find((props) => props['aria-label']?.includes('new-2'))
  assert.equal(kept?.disabled, false, 'a visible model must stay switchable even when the check failed')
  assert.equal(added?.disabled, true, 'adding still needs a successful check: there is nothing to add without one')
})

test('a route nothing knows how to reach is described in words, not painted red', async () => {
  const payload = {
    proxy: { enabled: false, available: false },
    schedule: { enabled: true, hour: 9 },
    providers: [{
      provider: 'mystery',
      displayName: 'Mystery',
      eagerCount: 2,
      eagerIds: ['a', 'b'],
      check: { at: Date.now(), status: 'no-endpoint', added: [], gone: [] },
      ignored: [],
    }],
    problems: [],
    legacy: [],
  }
  const { registered } = await loadClient()
  const module = registered[0].factory(() => REACT_STUB)
  let Panel
  module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { Panel = component; return () => undefined },
    },
  })
  const text = textOf(Panel({ view: payload, expandedProvider: 'mystery' }))
  assert.ok(text.includes('无法检查'), 'the neutral status must be shown')
  assert.ok(text.includes('维护与诊断'), 'details remain accessible')
  assert.ok(text.includes('已显示 2 / 2 个'), 'the configured models still render')
})


test('v3.1.2 review rows keep identity, current status and evidence status in three lines', async () => {
  const { registered } = await loadClient()
  const reviewReact = {
    ...REACT_STUB,
    useState: (value) => {
      const initial = typeof value === 'function' ? value() : value
      return [initial === 'manage' ? 'metadata' : initial, () => undefined]
    },
  }
  const module = registered[0].factory(() => reviewReact)
  let Panel
  module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { Panel = component; return () => undefined },
    },
  })
  const model = {
    provider: 'openrouter', routeKey: 'openrouter', id: 'anthropic/claude-haiku-4.5',
    displayName: 'OpenRouter', name: 'Claude Haiku 4.5', level: 'partial', pending: true,
    edited: false, canWrite: true, canRevert: false, revision: 1, reviewRevision: 0,
    updatedAt: 1, protocol: 'openai-completions', fingerprint: 'fingerprint',
    issues: [{ kind: 'missing', field: 'maxTokens' }],
    fields: {
      contextWindow: { value: 200000, source: 'official', candidate: 200000, candidateSource: 'official' },
      maxTokens: { value: 64000, source: 'models.dev', candidate: 64000, candidateSource: 'models.dev' },
      input: { value: ['text'], source: 'user' },
      reasoningEfforts: { value: {}, source: 'host' },
    },
  }
  const tree = Panel({
    view: {
      providers: [], problems: [], legacy: [], schedule: { enabled: false, hour: 9 },
      review: { pendingCount: 1, models: [model], history: [] },
    },
  })
  const text = textOf(tree)
  for (const expected of [
    'Claude Haiku 4.5', 'anthropic/claude-haiku-4.5', 'OpenRouter', '缺字段', '部分核实',
    '官方 API', 'models.dev 精准匹配', '人工填写', '本机已确认', 'DSH 内置目录', 'models.dev 泛化',
    '所需字段仍未确认；未知值保持空白，不猜测。',
  ]) assert.ok(text.includes(expected), `the review panel must render "${expected}"`)

  let row
  walk(tree, (node) => { if (node.props?.className === 'review-model') row = node })
  assert.ok(row, 'the compact review row exists')
  assert.equal(row.children.length, 3, 'name/status, id and provider/evidence are exactly three rows')
  assert.match(row.props['aria-label'], /当前状态：缺字段，信息状态：部分核实/)
  const source = await readFile(SOURCE, 'utf8')
  assert.ok(source.includes('height:61px; display:grid; grid-template-rows:16px 12px 19px'), 'the compact row keeps its 61 px budget')
  assert.ok(source.includes("['none','正常（无当前问题）']"), 'normal models can be filtered explicitly')
})

test('v3.1.2 keeps the original blue-and-white management dimensions', async () => {
  const source = await readFile(SOURCE, 'utf8')
  for (const invariant of [
    '--ms-blue:#376bda',
    '.dsh-ms .proxy { height:60px;',
    '.dsh-ms .toolbar { height:33px;',
    '.dsh-ms .provider-head { width:100%; height:42px;',
    '.dsh-ms .groups.single { display:grid; grid-template-columns:repeat(2,minmax(0,1fr));',
    'height:40px; margin:0 8px; border-top:1px solid var(--ms-line);',
  ]) assert.ok(source.includes(invariant), `the original management invariant remains: ${invariant}`)
})
