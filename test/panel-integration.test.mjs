/**
 * End-to-end wiring test for the two halves that never meet in a unit test:
 * the host controller produces `view()`, and the browser panel consumes it.
 *
 * Each half is tested on its own elsewhere, but a renamed field on either side
 * breaks the pair silently -- the panel renders, it just renders nothing where
 * the row used to be. So this test asks the real controller for a real payload
 * (through the real HTTP route, from the real `apply()`), then hands that exact
 * payload to the real client bundle and checks it comes out with text.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import * as entry from '../lib/index.js'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const PIAI = 'llm-pi-ai'

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => undefined],
}

/** Flatten a rendered tree to text, invoking function components on the way. */
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

function fakeContext(dir) {
  const document = {
    [PIAI]: {
      providers: {
        google: { apiKeyEnv: 'GOOGLE_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta', models: [{ id: 'gemini-4-argon' }] },
        // What the old plugin left behind: a key no route backs.
        'opencode-go-chat': { displayName: 'opencode-go · Chat Completions', apiKeyEnv: 'OPENCODE_GO_API_KEY' },
      },
    },
  }
  const routes = []
  const services = {
    settings: {
      describe: () => Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: 1 })),
      mutate: async () => { throw new Error('this test never writes') },
    },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'google', settingsNs: PIAI, settingsPath: ['providers', 'google'], displayName: 'Google', defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta' },
      ],
      listModels: async (provider) => (provider === 'google' ? [{ id: 'gemini-4-argon' }] : []),
      resolveModelInfo: async (provider, id) => ({ provider, id, name: id }),
    },
    credentials: { resolve: async () => ({ value: 'not-a-real-key' }) },
    profileContext: { dir },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => { routes.length = 0 }
      },
    },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => services[name],
    effect(execute) {
      const disposer = execute()
      return () => {
        try { disposer?.() } catch {}
      }
    },
    inject(_deps, callback) {
      return callback({ ...ctx, webServer: services.webServer })
    },
  }
  return { ctx, routes, document }
}

function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body === undefined ? '' : String(body) },
  }
}

function fakeRequest({ url, method }) {
  return { url, method, headers: {}, async *[Symbol.asyncIterator]() {} }
}

async function loadPanel() {
  const source = await readFile(CLIENT, 'utf8')
  const registered = []
  const context = {
    window: { __ModuleLoader__: { load: (loaded) => registered.push(loaded) } },
    console,
    fetch: async () => { throw new Error('the panel must not fetch during render') },
    setTimeout,
    clearTimeout,
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(registered.length, 1)
  const module = registered[0].factory(() => REACT_STUB)
  let Panel
  module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { Panel = component; return () => undefined },
    },
  })
  return Panel
}

test('the real view payload renders in the real panel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-panel-'))
  const { ctx, routes } = fakeContext(dir)
  entry.apply(ctx)
  assert.equal(routes.length, 1, 'the plugin must mount its route before the view exists')

  const response = fakeResponse()
  await routes[0].handler(fakeRequest({ url: '/model-sync/api/view', method: 'GET' }), response)
  assert.equal(response.status, 200)
  const { view } = JSON.parse(response.body)

  // Any field the panel reads as `view.<field>` must be produced by the host.
  // A rename on one side alone leaves the panel rendering an empty space, and
  // JSON drops keys whose value is undefined, so presence is judged against the
  // controller source rather than the serialized payload.
  const [source, controllerSource] = await Promise.all([
    readFile(CLIENT, 'utf8'),
    readFile(new URL('../lib/controller.js', import.meta.url), 'utf8'),
  ])
  const read = new Set()
  for (const match of source.matchAll(/view\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(match[1])
  assert.ok(read.size >= 6, `expected the panel to read several view fields, saw ${String(read.size)}`)
  for (const field of read) {
    const produced = field in view || controllerSource.includes(field)
    assert.ok(produced, `the panel reads view.${field}, which the host never produces`)
  }

  const Panel = await loadPanel()
  assert.ok(textOf(Panel({})).length > 0, 'the empty state renders')

  const populated = textOf(Panel({ view }))
  assert.ok(populated.length > 0, 'the real payload renders something')
  // A first run must not accuse itself: no state problem row, and the row that
  // is there must say how many models it would keep.
  assert.ok(!populated.includes('could not be moved aside'), 'a fresh install has no state file to reject')
  assert.ok(populated.includes('已启用 1 个'), 'the row states the effective model count')
  for (const expected of ['Google', 'generativelanguage.googleapis.com', 'opencode-go-chat']) {
    assert.ok(populated.includes(expected), `the panel must show "${expected}" from the real payload`)
  }

  // The boot verdict is rendered without a click: it is the first thing the
  // panel is asked after a restart, and a button would hide it until pressed.
  const booted = textOf(Panel({
    view: { ...view, selfCheck: { at: '2026-11-16T10:30:00.000Z', ok: true, failures: [], warnings: [], text: '✅ 没有发现会拦住你的问题' } },
  }))
  assert.ok(booted.includes('最近一次自检通过'), 'a passing boot verdict shows up on its own')
  const unhappy = textOf(Panel({
    view: { ...view, selfCheck: { at: '2026-11-16T10:30:00.000Z', ok: false, failures: [{ area: 'install', message: 'x' }], warnings: [], text: '❌ 1 个问题需要处理' } },
  }))
  assert.ok(unhappy.includes('发现 1 个问题'), 'a failing boot verdict states how many')

  // The self-check verb returns a sentence, not another payload: it must not
  // depend on the panel having rendered anything first.
  const verdict = fakeResponse()
  await routes[0].handler(fakeRequest({ url: '/model-sync/api/selfcheck', method: 'POST' }), verdict)
  assert.equal(verdict.status, 200)
  const verdictBody = JSON.parse(verdict.body)
  const { text, verdict: judged } = verdictBody
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0, 'the verdict prints something')
  assert.equal(judged.ok, text.includes('✅'), 'the last line has to agree with ok')
  // A manual run has to leave the same trace as the boot run, otherwise the
  // first row shows an older verdict than the text under it.
  assert.equal(typeof verdictBody.view?.selfCheck, 'object')
  assert.equal(verdictBody.view.selfCheck.ok, judged.ok)
  assert.equal(verdictBody.view.selfCheck.text, text)

  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
