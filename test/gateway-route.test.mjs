/**
 * Behaviour tests for routing one provider through the local protocol gateway.
 *
 * The invariant under test: enabling the gateway writes exactly one field —
 * `providers.<route>.baseURL` — and remembers what it replaced. Nothing else in
 * the route moves (no new provider key, no credential copy, no `models` edit),
 * and undoing it puts the route back where it was.
 *
 * The listener itself is faked, so these tests never bind a port.
 *
 * Run: node --test test/gateway-route.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Controller } from '../lib/controller.js'

const PIAI = 'llm-pi-ai'
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** A gateway whose listener is a variable, so no socket is opened. */
function fakeGateway(options = {}) {
  /** @type {any[]} */
  const created = []
  const createGateway = (config) => {
    created.push(config)
    let port = 0
    return {
      config,
      get port() {
        return port === 0 ? undefined : port
      },
      get url() {
        return port === 0 ? undefined : `http://127.0.0.1:${port}`
      },
      async start(preferredPort = 0, forbidden = []) {
        const next = options.reassignedPort ?? (preferredPort !== 0 ? preferredPort : (options.port ?? 41234))
        if (forbidden.includes(next)) throw new Error(`port ${next} is reserved`)
        port = next
      },
      async stop() {
        port = 0
      },
      stats() {
        return { requests: 0, passedThrough: 0, translated: 0 }
      },
    }
  }
  return { createGateway, created }
}

/** Offline `listAll`: one id per protocol, so attribution is never ambiguous. */
function fakeListAll(options = {}) {
  const calls = []
  const listAll = async (request) => {
    calls.push(request)
    if (options.fail === true) throw new Error('no protocol answered a model listing')
    return {
      listings: [],
      // One protocol by default: the baseURL-only tests must not also narrow the
      // route, or they would stop testing what their names say.
      attribution: new Map(options.attribution ?? [['gemini-4-argon', 'google-generative-ai']]),
      claimants: new Map(),
      attempts: options.attempts ?? [],
    }
  }
  return { listAll, calls }
}

function harness(options = {}) {
  const document = {
    [PIAI]: {
      providers: {
        google: { apiKeyEnv: 'GOOGLE_API_KEY', baseURL: GOOGLE_BASE },
        ...(options.providers ?? {}),
      },
    },
  }
  const revisions = { [PIAI]: 1 }
  /** @type {{ns: string, ops: any[], revision: number|undefined}[]} */
  const writes = []

  const apply = (node, path, value, op) => {
    const copy = node !== null && typeof node === 'object' && !Array.isArray(node) ? { ...node } : {}
    if (path.length === 0) return value === undefined ? copy : value
    const [head, ...rest] = path
    if (rest.length === 0) {
      if (op === 'unset') delete copy[head]
      else copy[head] = structuredClone(value)
      return copy
    }
    copy[head] = apply(copy[head], rest, value, op)
    return copy
  }

  const settings = {
    describe() {
      return Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: revisions[ns] }))
    },
    async mutate(ns, ops, expectedRevision) {
      writes.push({ ns, ops, revision: expectedRevision })
      if (expectedRevision !== undefined && expectedRevision !== revisions[ns]) {
        throw Object.assign(new Error('revision conflict'), { name: 'SettingsConflictError' })
      }
      let value = document[ns]
      for (const op of ops) {
        value = op.op === 'set'
          ? apply(value, op.path, structuredClone(op.value), 'set')
          : apply(value, op.path, undefined, 'unset')
      }
      document[ns] = value
      revisions[ns] += 1
    },
  }

  const listed = [
    { provider: 'google', settingsNs: PIAI, settingsPath: ['providers', 'google'], displayName: 'Google', defaultBaseURL: GOOGLE_BASE },
    ...Object.entries(options.providers ?? {}).map(([provider, profile]) => ({
      provider,
      settingsNs: PIAI,
      settingsPath: ['providers', provider],
      displayName: provider,
      defaultBaseURL: profile.defaultBaseURL,
    })),
  ]

  const llm = {
    listConfigurableProviders: () => listed,
    // Like the host: a stated list replaces the catalog, so the route reports
    // exactly what the document says. Without this an apply cannot be read back.
    async listModels(provider) {
      const stated = document[PIAI]?.providers?.[provider]?.models
      if (Array.isArray(stated)) return stated.map((model) => ({ id: model.id }))
      // Two ids, because "this route serves more than one protocol" is the
      // situation narrowing exists for and a single-model route cannot show it.
      return [{ id: 'gemini-4-argon' }, { id: 'gemini-4-carbon' }]
    },
    async resolveModelInfo(provider, id) {
      return options.resolveModelInfo?.(provider, id) ?? { provider, id, name: id }
    },
  }

  const credentials = { async resolve() { return { value: 'SECRET-VALUE-DO-NOT-STORE' } } }

  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      if (name === 'llm') return llm
      if (name === 'credentials') return credentials
      if (name === 'profileContext') return { dir: options.profileDir }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
  }

  return { ctx, document, writes }
}

async function controllerFor(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-gw-'))
  const fake = harness({ ...options, profileDir: dir })
  const gateway = fakeGateway(options.gateway)
  const probe = fakeListAll(options.probe)
  const controller = new Controller(fake.ctx, {
    dir,
    egress: { dir },
    logger: fake.ctx.logger,
    // No live lane, no network, no socket.
    bili: { locate: () => undefined },
    gateway,
    listAll: probe.listAll,
  })
  await controller.store.load()
  return { ...fake, controller, dir, gateway, probe }
}

/** Apply a user's settings edit just before the gateway's next CAS write. */
function raceNextWrite(ctx, op) {
  const settings = ctx.get('settings')
  const mutate = settings.mutate.bind(settings)
  settings.mutate = async (...args) => {
    settings.mutate = mutate
    await mutate(PIAI, [op])
    return mutate(...args)
  }
}

test('a deleted provider is not recreated on retry and its new listener is closed', async (t) => {
  const { ctx, controller, document, dir } = await controllerFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  raceNextWrite(ctx, { op: 'unset', path: ['providers', 'google'] })
  await assert.rejects(controller.routeGateway({ provider: 'google' }), /changed during/)
  assert.deepEqual(document[PIAI].providers, {})
  assert.deepEqual(controller.store.data.gateway.entries, {})
  assert.equal(controller.gatewayHandle, undefined)
  assert.equal(controller.exitTimer, undefined)
})

test('a settings write that took effect before its reply failed keeps the active listener', async (t) => {
  const { ctx, controller, dir } = await controllerFor()
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  const settings = ctx.get('settings')
  const mutate = settings.mutate.bind(settings)
  settings.mutate = async (...args) => {
    await mutate(...args)
    throw new Error('acknowledgement lost')
  }
  const result = await controller.routeGateway({ provider: 'google' })
  assert.equal(result.baseURL, `${controller.gatewayHandle.url}/g/google`)
  assert.ok(controller.store.data.gateway.entries.google)
})

test('undo recognizes a committed host write whose acknowledgement was lost', async (t) => {
  const { ctx, controller, document, dir } = await controllerFor()
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  await controller.routeGateway({ provider: 'google' })
  const settings = ctx.get('settings')
  const mutate = settings.mutate.bind(settings)
  settings.mutate = async (...args) => {
    await mutate(...args)
    throw new Error('acknowledgement lost')
  }
  await controller.unrouteGateway({ provider: 'google' })
  assert.equal(document[PIAI].providers.google.baseURL, GOOGLE_BASE)
  assert.deepEqual(controller.store.data.gateway.entries, {})
  assert.equal(controller.gatewayHandle, undefined)
})

test('boot clears an already restored route after the final ledger save failed', async (t) => {
  const { controller, document, writes, dir } = await controllerFor()
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  await controller.routeGateway({ provider: 'google' })
  const save = controller.store.save.bind(controller.store)
  controller.store.save = async () => { throw new Error('disk full') }
  await assert.rejects(controller.unrouteGateway({ provider: 'google' }), /disk full/)
  assert.equal(document[PIAI].providers.google.baseURL, GOOGLE_BASE)
  assert.ok(controller.store.data.gateway.entries.google)
  controller.store.save = save
  await controller.stopGateway()
  await controller.store.load()
  await controller.restoreGateway()
  assert.equal(controller.gatewayHandle, undefined)
  assert.deepEqual(controller.store.data.gateway.entries, {})
  assert.equal(writes.length, 2)
})

test('undo and boot retain a route that was reselected while the earlier settings snapshot was in use', async (t) => {
  const { ctx, controller, document, dir } = await controllerFor()
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  const { baseURL } = await controller.routeGateway({ provider: 'google' })
  const edit = (value) => ctx.get('settings').mutate(PIAI, [{ op: 'set', path: ['providers', 'google', 'baseURL'], value }])
  await edit(GOOGLE_BASE)
  const snapshot = controller.store.snapshot.bind(controller.store)
  controller.store.snapshot = async (...args) => {
    const file = await snapshot(...args)
    await edit(baseURL)
    return file
  }
  await assert.rejects(controller.unrouteGateway({ provider: 'google' }), /changed during/)
  assert.ok(controller.store.data.gateway.entries.google)

  await edit(GOOGLE_BASE)
  const llm = ctx.get('llm')
  const list = llm.listModels.bind(llm)
  llm.listModels = async (...args) => {
    llm.listModels = list
    await edit(baseURL)
    return list(...args)
  }
  await controller.reconcileGatewayPort(controller.gatewayHandle.port)
  assert.equal(document[PIAI].providers.google.baseURL, baseURL)
  assert.ok(controller.store.data.gateway.entries.google)
  assert.ok(controller.gatewayHandle)
})

test('a legacy row without port evidence cannot claim an arbitrary loopback service', async (t) => {
  const { controller, document, writes, dir } = await controllerFor()
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  controller.store.data.gateway = { entries: { google: { routeId: 'google', previousBaseURL: GOOGLE_BASE } } }
  const other = 'http://127.0.0.1:42077/g/google'
  document[PIAI].providers.google.baseURL = other
  await controller.restoreGateway()
  await assert.rejects(controller.unrouteGateway({ provider: 'google' }), /no longer points/)
  await controller.revertRoutedBases('unavailable')
  assert.equal(document[PIAI].providers.google.baseURL, other)
  assert.deepEqual(writes, [])
})

test('undo preserves the protocol edited during a revision conflict', async (t) => {
  const { ctx, controller, document, dir } = await controllerFor({ probe: { attribution: MIXED } })
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  await controller.routeGateway({ provider: 'google' })
  raceNextWrite(ctx, { op: 'set', path: ['providers', 'google', 'api'], value: 'anthropic-messages' })
  await assert.rejects(controller.unrouteGateway({ provider: 'google' }), /changed during/)
  assert.equal(document[PIAI].providers.google.api, 'anthropic-messages')
  assert.equal(document[PIAI].providers.google.baseURL, 'http://127.0.0.1:41234/g/google')
  assert.ok(controller.store.data.gateway.entries.google)
  await controller.revertRoutedBases('boot')
  assert.equal(document[PIAI].providers.google.api, 'anthropic-messages')
  assert.equal(document[PIAI].providers.google.baseURL, GOOGLE_BASE)
  assert.equal(controller.store.data.gateway.status, 'reverted')
})

test('boot port repair and rollback only write to matching loopback routes', async (t) => {
  const { ctx, controller, document, dir } = await controllerFor({ providers: { other: { baseURL: 'https://api.example/v1' } } })
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  for (const provider of ['google', 'other']) await controller.routeGateway({ provider })

  await controller.reconcileGatewayPort(40000)
  for (const provider of ['google', 'other']) {
    assert.equal(document[PIAI].providers[provider].baseURL, `http://127.0.0.1:40000/g/${provider}`)
  }
  const foreign = 'http://127.0.0.1:42077/g/google'
  raceNextWrite(ctx, { op: 'set', path: ['providers', 'google', 'baseURL'], value: foreign })
  await controller.reconcileGatewayPort(41000)
  assert.equal(document[PIAI].providers.google.baseURL, foreign)
  assert.equal(document[PIAI].providers.other.baseURL, 'http://127.0.0.1:41000/g/other')
  await assert.rejects(controller.unrouteGateway({ provider: 'google' }), /no longer points/)
  await controller.revertRoutedBases('boot')
  assert.equal(document[PIAI].providers.google.baseURL, foreign)
  assert.equal(document[PIAI].providers.other.baseURL, 'https://api.example/v1')
  assert.deepEqual(Object.keys(controller.store.data.gateway.entries), ['google'])
})

test('an inherited upstream address remains inherited after routing and undo', async (t) => {
  const { controller, document, dir } = await controllerFor({ providers: { inherited: { defaultBaseURL: 'https://api.example/v1' } } })
  t.after(() => rm(dir, { recursive: true, force: true }))
  await controller.routeGateway({ provider: 'inherited' })
  assert.equal(controller.store.data.gateway.entries.inherited.upstreamBaseURL, 'https://api.example/v1')
  await controller.unrouteGateway({ provider: 'inherited' })
  assert.equal(Object.hasOwn(document[PIAI].providers.inherited, 'baseURL'), false)
})

test('routing a provider writes only its baseURL and remembers what it replaced', async () => {
  const { controller, document, writes, gateway, dir } = await controllerFor()
  try {
    const done = await controller.routeGateway({ provider: 'google' })

    assert.equal(writes.length, 1)
    assert.equal(writes[0].ns, PIAI)
    assert.deepEqual(writes[0].ops, [{
      op: 'set',
      path: ['providers', 'google', 'baseURL'],
      value: 'http://127.0.0.1:41234/g/google',
    }])
    assert.equal(done.previousBaseURL, GOOGLE_BASE)
    assert.equal(document[PIAI].providers.google.baseURL, 'http://127.0.0.1:41234/g/google')
    // The credential reference is untouched: this plugin never rewrites it.
    assert.equal(document[PIAI].providers.google.apiKeyEnv, 'GOOGLE_API_KEY')
    assert.equal(Object.keys(document[PIAI].providers).length, 1)
    // The probe ran against the real upstream address, not the gateway.
    assert.equal(gateway.created.length, 1)
    assert.equal(controller.store.data.gateway.entries.google.previousBaseURL, GOOGLE_BASE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the gateway state reports the live listener and survives a dispose', async () => {
  const { controller, dir } = await controllerFor()
  try {
    await controller.routeGateway({ provider: 'google' })
    const view = await controller.view()
    assert.equal(view.gateway.running, true)
    assert.equal(view.gateway.url, 'http://127.0.0.1:41234')
    assert.deepEqual(view.gateway.entries.map((row) => row.provider), ['google'])
    assert.equal(view.providers.find((row) => row.provider === 'google').routedThroughGateway, true)

    controller.dispose()
    assert.equal(controller.gatewayHandle, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unloading during gateway startup releases the listener and leaves the route for the next boot', async (t) => {
  const { controller, dir, writes } = await controllerFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const entries = { google: { routeId: 'google', upstreamBaseURL: GOOGLE_BASE } }
  controller.store.data.gateway = { enabled: true, entries }
  let started, release
  const starting = new Promise((resolve) => { started = resolve })
  const ready = new Promise((resolve) => { release = resolve })
  let stops = 0
  controller.gateway = { createGateway: () => ({
    port: 41234,
    start: () => { started(); return ready },
    stop: () => { stops += 1 },
  }) }
  const restoring = controller.restoreGateway()
  await starting
  const disposing = controller.dispose()
  release()
  await Promise.all([restoring, disposing])
  assert.equal(stops, 1)
  assert.equal(controller.gatewayHandle, undefined)
  assert.equal(controller.exitTimer, undefined)
  assert.deepEqual(controller.store.data.gateway.entries, entries)
  assert.deepEqual(writes, [])
})

test('a listener is closed if its port cannot be saved', async (t) => {
  const { controller, dir } = await controllerFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  controller.store.data.gateway = { enabled: true, entries: { google: { routeId: 'google', upstreamBaseURL: GOOGLE_BASE } } }
  const handle = controller.gateway.createGateway({})
  controller.gateway = { createGateway: () => handle }
  controller.store.save = async () => { throw new Error('disk full') }
  await assert.rejects(controller.startGateway(), /disk full/)
  assert.equal(handle.port, undefined)
  assert.equal(controller.gatewayHandle, undefined)
  assert.equal(controller.exitTimer, undefined)
})

test('undoing a route restores the baseURL it had before', async () => {
  const { controller, document, writes, dir } = await controllerFor()
  try {
    await controller.routeGateway({ provider: 'google' })
    const done = await controller.unrouteGateway({ provider: 'google' })

    assert.equal(done.baseURL, GOOGLE_BASE)
    assert.deepEqual(writes.at(-1).ops, [{
      op: 'set',
      path: ['providers', 'google', 'baseURL'],
      value: GOOGLE_BASE,
    }])
    assert.equal(document[PIAI].providers.google.baseURL, GOOGLE_BASE)
    assert.deepEqual(controller.store.data.gateway.entries, {})
    // The last route leaving means the listener must not stay open.
    assert.equal(controller.gatewayHandle, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('undoing a route that had no baseURL deletes the key instead of inventing one', async () => {
  const { controller, document, dir } = await controllerFor()
  try {
    // Simulated: the entry exists but the route inherited its address, so there
    // is nothing to restore and an `unset` is the only honest op.
    await controller.store.save()
    controller.store.data.gateway = {
      enabled: false,
      port: 41234,
      entries: { google: { provider: 'google', routeId: 'google', previousBaseURL: undefined, models: {}, at: Date.now() } },
    }
    document[PIAI].providers.google.baseURL = 'http://127.0.0.1:41234/g/google'
    await controller.store.save()

    await controller.unrouteGateway({ provider: 'google' })
    assert.equal('baseURL' in document[PIAI].providers.google, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a route that already points at this machine is refused', async () => {
  const { controller, dir } = await controllerFor({
    providers: { local: { defaultBaseURL: 'http://127.0.0.1:9999/v1' } },
  })
  try {
    await assert.rejects(
      () => controller.routeGateway({ provider: 'local' }),
      /already points at this machine/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('routing the same provider twice is refused rather than overwriting the memory', async () => {
  const { controller, dir } = await controllerFor()
  try {
    await controller.routeGateway({ provider: 'google' })
    await assert.rejects(() => controller.routeGateway({ provider: 'google' }), /already routed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an upstream that lists nothing leaves no half-written route behind', async () => {
  const { controller, writes, dir } = await controllerFor({ probe: { attribution: [] } })
  try {
    await assert.rejects(
      () => controller.routeGateway({ provider: 'google' }),
      /nothing to route/,
    )
    assert.equal(writes.length, 0)
    assert.deepEqual(controller.store.data.gateway.entries, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a hand-edited baseURL is not silently clobbered by undo', async () => {
  const { controller, document, dir } = await controllerFor()
  try {
    await controller.routeGateway({ provider: 'google' })
    document[PIAI].providers.google.baseURL = 'https://somewhere-else.example/v1'
    await assert.rejects(() => controller.unrouteGateway({ provider: 'google' }), /no longer points at the gateway/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('starting the gateway with nothing routed is refused, not silently idle', async () => {
  const { controller, dir } = await controllerFor()
  try {
    await assert.rejects(() => controller.startGateway(), /nothing is routed|routed through the gateway yet/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the listener never binds the compression lane port', async () => {
  const { controller, gateway, dir } = await controllerFor({ gateway: { port: 18787 } })
  try {
    await assert.rejects(
      () => controller.routeGateway({ provider: 'google' }),
      /18787 is reserved/,
    )
    // The failed start must not leave the route entry behind.
    assert.deepEqual(controller.store.data.gateway.entries, {})
    assert.equal(gateway.created.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a route left pointing at the gateway is picked up again on boot', async () => {
  const { controller, document, dir } = await controllerFor({ gateway: { port: 40000 } })
  try {
    await controller.routeGateway({ provider: 'google' })
    await controller.stopGateway()
    // v3.1.3 stored the old port on the gateway, without a per-route port.
    delete controller.store.data.gateway.entries.google.routedPort
    await controller.store.save()
    await controller.store.load()
    controller.gateway = fakeGateway({ reassignedPort: 41234 })
    await controller.restoreGateway()

    assert.notEqual(controller.gatewayHandle, undefined)
    // The kernel gave a different port, so the stale baseURL was rewritten
    // instead of leaving the route pointed at a dead one.
    assert.equal(document[PIAI].providers.google.baseURL, 'http://127.0.0.1:41234/g/google')
    assert.equal(controller.gatewayHandle.port, 41234)
    assert.equal(controller.store.data.gateway.entries.google.routedPort, 41234)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('if the listener cannot start on boot, the routes are put back rather than left dead', async () => {
  const { controller, document, dir } = await controllerFor({
    gateway: { port: 18787 },   // reserved by the compression lane, so start() throws
  })
  try {
    // Route it while the lane port is still allowed to be claimed by the fake.
    controller.store.data.gateway = {
      enabled: true,
      port: 18787,
      entries: {
        google: {
          provider: 'google',
          routeId: 'google',
          previousBaseURL: GOOGLE_BASE,
          models: { 'gemini-4-argon': 'google-generative-ai' },
          at: Date.now(),
        },
      },
    }
    document[PIAI].providers.google.baseURL = 'http://127.0.0.1:18787/g/google'
    controller.gatewayHandle = undefined

    await controller.restoreGateway()

    assert.equal(controller.gatewayHandle, undefined)
    assert.equal(document[PIAI].providers.google.baseURL, GOOGLE_BASE)
    assert.deepEqual(controller.store.data.gateway.entries, {})
    assert.equal(controller.store.data.gateway.status, 'reverted')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Attribution for a route whose upstream speaks several translatable protocols. */
// Attribution has to cover the route's own model list — a probe that misses one
// of them is exactly the case the narrowing guard refuses.
const MIXED = [
  ['gemini-4-argon', 'openai-completions'],
  ['gemini-4-carbon', 'anthropic-messages'],
]

test('a route serving several translatable protocols is narrowed to one on the way in', async () => {
  // pi-ai answers `model "x" needs an api` for any id the catalog does not
  // describe, and that fails the whole profile. Stating one protocol is what
  // makes such an id storable, so routing must state one too.
  const { controller, document, writes, dir } = await controllerFor({ probe: { attribution: MIXED } })
  try {
    const done = await controller.routeGateway({ provider: 'google' })

    assert.equal(done.inbound, 'openai-completions')
    assert.deepEqual(writes[0].ops, [
      { op: 'set', path: ['providers', 'google', 'baseURL'], value: 'http://127.0.0.1:41234/g/google' },
      { op: 'set', path: ['providers', 'google', 'api'], value: 'openai-completions' },
    ])
    assert.equal(document[PIAI].providers.google.api, 'openai-completions')
    assert.equal(controller.store.data.gateway.entries.google.inbound, 'openai-completions')
    assert.equal(controller.store.data.gateway.entries.google.previousApi, undefined)
    // The upstream address is remembered, not read back from the live baseURL.
    assert.equal(controller.store.data.gateway.entries.google.upstreamBaseURL, GOOGLE_BASE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ids no listing mentions do not block narrowing when every protocol answered', async () => {
  // A route can carry ids the upstream does not publish at all (the account has
  // them listed but disabled). "Not in any listing" is an answer, not a gap, so
  // narrowing must still happen — otherwise such a route could never take a new
  // model, which is the whole point of the gateway.
  const { controller, document, writes, dir } = await controllerFor({
    probe: {
      attribution: [['gemini-4-argon', 'openai-completions'], ['gemini-4-carbon', 'anthropic-messages']],
      attempts: [
        { api: 'openai-completions', ok: true, count: 2 },
        { api: 'anthropic-messages', ok: true, count: 1 },
        // The real shape of a Gemini probe against an OpenAI-shaped upstream:
        // the endpoint answers, with a body that is not a Gemini listing.
        { api: 'google-generative-ai', ok: false, reason: 'the reply has no "models" array' },
      ],
    },
    providers: {
      google: {
        apiKeyEnv: 'GOOGLE_API_KEY',
        baseURL: GOOGLE_BASE,
        models: [{ id: 'gemini-4-argon' }, { id: 'gemini-4-carbon' }, { id: 'gemini-7-krypton' }],
      },
    },
  })
  try {
    const done = await controller.routeGateway({ provider: 'google' })

    assert.equal(done.inbound, 'openai-completions')
    assert.deepEqual(done.unattributed, ['gemini-7-krypton'])
    assert.deepEqual(controller.store.data.gateway.entries.google.unattributed, ['gemini-7-krypton'])
    assert.equal(controller.store.data.gateway.entries.google.blind, undefined)
    assert.equal(document[PIAI].providers.google.api, 'openai-completions')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a protocol that never answered keeps the route un-narrowed', async () => {
  // The dangerous case: the Anthropic listing timed out, so every Anthropic
  // model on the route looks like it speaks whatever protocols did answer.
  const { controller, document, writes, dir } = await controllerFor({
    probe: {
      attribution: [['gemini-4-argon', 'openai-completions'], ['gemini-4-carbon', 'openai-completions']],
      attempts: [
        { api: 'openai-completions', ok: true, count: 2 },
        { api: 'anthropic-messages', ok: false, reason: 'connect ETIMEDOUT' },
      ],
    },
    providers: {
      google: {
        apiKeyEnv: 'GOOGLE_API_KEY',
        baseURL: GOOGLE_BASE,
        models: [{ id: 'gemini-4-argon' }, { id: 'gemini-4-carbon' }, { id: 'gemini-7-krypton' }],
      },
    },
  })
  try {
    const done = await controller.routeGateway({ provider: 'google' })

    assert.equal(done.inbound, undefined)
    assert.deepEqual(done.blind, ['anthropic-messages'])
    assert.deepEqual(writes[0].ops, [
      { op: 'set', path: ['providers', 'google', 'baseURL'], value: 'http://127.0.0.1:41234/g/google' },
    ])
    assert.equal('api' in document[PIAI].providers.google, false)
    const state = await controller.gatewayState()
    assert.deepEqual(state.entries[0].blind, ['anthropic-messages'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a route with a protocol this build cannot encode keeps its api unset', async () => {
  // Narrowing a route it cannot translate would break every request on it, so
  // the lock is refused and the route stays pass-through.
  const { controller, document, dir } = await controllerFor({
    // `typesafe-system-one` is a real protocol name in a pi-ai catalog that no
    // build can encode: that is exactly the case the guard exists for.
    probe: { attribution: [['alpha-1', 'openai-completions'], ['alpha-2', 'typesafe-system-one']] },
  })
  try {
    const done = await controller.routeGateway({ provider: 'google' })

    assert.equal(done.inbound, undefined)
    assert.equal(document[PIAI].providers.google.api, undefined)
    assert.equal(controller.store.data.gateway.entries.google.inbound, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a route that serves a Gemini model is narrowable too', async () => {
  // Gemini used to be the one protocol the gateway could not translate, which
  // left every route holding a Gemini model un-narrowable — and therefore unable
  // to accept an id the installed catalog does not describe.
  const { controller, document, dir } = await controllerFor({
    probe: { attribution: [['gemini-4-argon', 'google-generative-ai'], ['gemini-4-carbon', 'openai-responses']] },
  })
  try {
    const done = await controller.routeGateway({ provider: 'google' })
    assert.equal(done.inbound, 'openai-completions')
    assert.equal(document[PIAI].providers.google.api, 'openai-completions')
    assert.equal(controller.store.data.gateway.entries.google.inbound, 'openai-completions')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('undoing a narrowed route puts the api back the way it found it', async () => {
  const { controller, document, writes, dir } = await controllerFor({ probe: { attribution: MIXED } })
  try {
    await controller.routeGateway({ provider: 'google' })
    await controller.unrouteGateway({ provider: 'google' })

    assert.deepEqual(writes.at(-1).ops, [
      { op: 'set', path: ['providers', 'google', 'baseURL'], value: GOOGLE_BASE },
      { op: 'unset', path: ['providers', 'google', 'api'] },
    ])
    assert.equal(document[PIAI].providers.google.api, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a model added while routed is attributed, remembered, and blocks undo', async () => {
  const attribution = [...MIXED, ['brand-new', 'anthropic-messages']]
  const { controller, document, dir } = await controllerFor({ probe: { attribution } })
  try {
    await controller.routeGateway({ provider: 'google' })
    controller.store.data.checks = {
      google: { at: Date.now(), status: 'ok', protocol: 'openai-completions', added: [{ id: 'brand-new' }], gone: [] },
    }

    const done = await controller.apply({ provider: 'google' })

    assert.deepEqual(done.written, ['brand-new'])
    assert.match(document[PIAI].providers.google.models.map((model) => model.id).join(','), /brand-new/)
    // The gateway has to know how to forward it, and undo has to know it exists.
    assert.equal(controller.gatewayRoutesCache.get('google').models.get('brand-new'), 'anthropic-messages')
    assert.deepEqual(controller.store.data.gateway.entries.google.addedAfterRouting, ['brand-new'])
    await assert.rejects(() => controller.unrouteGateway({ provider: 'google' }), /收拢协议之后加进来/)
    await controller.revertRoutedBases('listener unavailable')
    assert.equal(controller.store.data.gateway.status, 'revert-failed')
    assert.ok(controller.store.data.gateway.entries.google)
    document[PIAI].providers.google.baseURL = GOOGLE_BASE
    delete document[PIAI].providers.google.api
    await controller.reconcileGatewayPort(41234)
    await assert.rejects(controller.unrouteGateway({ provider: 'google' }), /收拢协议之后加进来/)
    assert.ok(controller.store.data.gateway.entries.google)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a model no protocol claims is refused before writing', async () => {
  const { controller, document, writes, dir } = await controllerFor({ probe: { attribution: MIXED } })
  try {
    await controller.routeGateway({ provider: 'google' })
    controller.store.data.checks = {
      google: { at: Date.now(), status: 'ok', protocol: 'openai-completions', added: [{ id: 'ghost' }], gone: [] },
    }

    const count = writes.length
    await assert.rejects(() => controller.apply({ provider: 'google' }), /模型配置未写入/)
    assert.equal(writes.length, count)
    assert.equal(document[PIAI].providers.google.models, undefined)
    assert.deepEqual(controller.store.data.gateway.entries.google.addedAfterRouting, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a routed opencode route keeps the session header it can no longer be given', async () => {
  // The host sends no `x-opencode-session`, and after routing it cannot even see
  // the opencode host — the gateway has to remember it from the upstream URL.
  const { controller, dir } = await controllerFor({
    providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', defaultBaseURL: 'https://opencode.ai/zen/go/v1' } },
    probe: { attribution: MIXED },
  })
  try {
    await controller.routeGateway({ provider: 'opencode-go' })
    const route = controller.gatewayRoutesCache.get('opencode-go')

    assert.equal(route.upstreamBaseURL, 'https://opencode.ai/zen/go/v1')
    // Narrowed to completions, so the route says bearer; the session header is
    // the part the gateway must supply because DSH no longer can.
    assert.match(route.authHeaders['x-opencode-session'], /model-sync-/)
    assert.equal(route.tap, 'openai-completions')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('removing the last gateway-only model makes undo possible again', async () => {
  const attribution = [...MIXED, ['brand-new', 'anthropic-messages']]
  const { controller, dir } = await controllerFor({ probe: { attribution } })
  try {
    await controller.routeGateway({ provider: 'google' })
    controller.store.data.checks = {
      google: { at: Date.now(), status: 'ok', protocol: 'openai-completions', added: [{ id: 'brand-new' }], gone: [] },
    }
    await controller.apply({ provider: 'google' })
    await assert.rejects(() => controller.unrouteGateway({ provider: 'google' }), /收拢协议之后加进来/)

    await controller.remove({ provider: 'google', id: 'brand-new' })

    assert.equal(controller.store.data.gateway.entries.google.addedAfterRouting, undefined)
    const done = await controller.unrouteGateway({ provider: 'google' })
    assert.equal(done.baseURL, GOOGLE_BASE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('gateway rollback follows external DSH model edits and rechecks them on a revision conflict', async (t) => {
  const { ctx, controller, document, dir } = await controllerFor({
    probe: { attribution: [...MIXED, ['brand-new', 'anthropic-messages']] },
  })
  t.after(async () => { await controller.dispose(); await rm(dir, { recursive: true, force: true }) })
  const { baseURL } = await controller.routeGateway({ provider: 'google' })
  controller.store.data.checks = {
    google: { at: Date.now(), status: 'ok', protocol: 'openai-completions', added: [{ id: 'brand-new' }], gone: [] },
  }
  await controller.apply({ provider: 'google' })
  const path = ['providers', 'google', 'models']
  const full = document[PIAI].providers.google.models
  const removed = { op: 'set', path, value: full.filter((model) => model.id !== 'brand-new') }
  const settings = ctx.get('settings')
  await settings.mutate(PIAI, [removed])
  raceNextWrite(ctx, { op: 'set', path, value: full })
  await assert.rejects(controller.unrouteGateway({ provider: 'google' }), /changed during/)
  assert.equal(document[PIAI].providers.google.baseURL, baseURL)
  assert.ok(controller.store.data.gateway.entries.google)
  await settings.mutate(PIAI, [removed])
  await controller.revertRoutedBases('listener unavailable')
  assert.equal(document[PIAI].providers.google.baseURL, GOOGLE_BASE)
  assert.equal(document[PIAI].providers.google.api, undefined)
  assert.deepEqual(controller.store.data.gateway.entries, {})
  assert.equal(controller.store.data.gateway.status, 'reverted')
})

test('a narrowed route can take a model the installed catalog does not describe, with the sizes discovery reported', async () => {
  // pi-ai's schema has no fallback for an id it has never seen: the entry needs
  // `contextWindow` and `maxTokens` itself, so the numbers from the upstream
  // listing are what makes "add a model only the provider has" possible at all.
  const { controller, document, dir } = await controllerFor({
    providers: {
      'opencode-go': { apiKeyEnv: 'OPENCODE_GO_APIKEY', defaultBaseURL: 'https://opencode.ai/zen/go/v1' },
    },
    probe: { attribution: [['gemini-4-argon', 'openai-completions'], ['grok-9-imaginary', 'openai-completions']] },
    resolveModelInfo(provider, id) {
      if (id === 'grok-9-imaginary') throw new Error(`pi-ai provider "${provider}" has no configured model "${id}"`)
      return { provider, id, name: id }
    },
  })
  try {
    await controller.routeGateway({ provider: 'opencode-go' })
    controller.store.data.checks['opencode-go'] = {
      at: Date.now(),
      status: 'ok',
      protocol: 'openai-completions',
      added: [{ id: 'grok-9-imaginary', name: 'Grok 9', contextWindow: 256_000, maxTokens: 64_000 }],
      gone: [],
    }

    await controller.apply({ provider: 'opencode-go' })

    const listed = document[PIAI].providers['opencode-go'].models
    const added = listed.find((model) => model.id === 'grok-9-imaginary')
    assert.deepEqual(added, { id: 'grok-9-imaginary', contextWindow: 256_000, maxTokens: 64_000, name: 'Grok 9' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unnamed external model without sizes is refused instead of written', async () => {
  const { controller, document, dir } = await controllerFor({
    providers: {
      'opencode-go': { apiKeyEnv: 'OPENCODE_GO_APIKEY', defaultBaseURL: 'https://opencode.ai/zen/go/v1' },
    },
    probe: { attribution: [['gemini-4-argon', 'openai-completions'], ['grok-9-imaginary', 'openai-completions']] },
    resolveModelInfo(provider, id) {
      if (id === 'grok-9-imaginary') throw new Error('unknown model')
      return { provider, id, name: id }
    },
  })
  try {
    await controller.routeGateway({ provider: 'opencode-go' })
    const before = structuredClone(document[PIAI].providers['opencode-go'])
    controller.store.data.checks['opencode-go'] = {
      at: Date.now(),
      status: 'ok',
      protocol: 'openai-completions',
      added: [{ id: 'grok-9-imaginary', name: 'Grok 9' }],
      gone: [],
    }

    await assert.rejects(() => controller.apply({ provider: 'opencode-go' }), /上下文窗口/)
    assert.deepEqual(document[PIAI].providers['opencode-go'], before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an entry the catalog cannot describe does not block adding an unrelated model', async () => {
  // A stated list is written back as it stands, so asking the catalog about ids
  // we merely keep would refuse the whole write over an entry we are not
  // touching — and the user would see a message about a model they never chose.
  const { controller, document, dir } = await controllerFor({
    providers: {
      opencode: {
        apiKeyEnv: 'OPENCODE_APIKEY',
        defaultBaseURL: 'https://opencode.ai/zen/v1',
        models: [{ id: 'mystery-1' }],
      },
    },
    probe: { attribution: [['fresh-2', 'openai-completions']] },
    resolveModelInfo(provider, id) {
      if (id === 'mystery-1') throw new Error('unknown model')
      return { provider, id, name: id }
    },
  })
  try {
    controller.store.data.checks['opencode'] = {
      at: Date.now(),
      status: 'ok',
      protocol: 'openai-completions',
      added: [{ id: 'fresh-2', name: 'Fresh 2' }],
      gone: [],
    }

    await controller.apply({ provider: 'opencode' })

    assert.deepEqual(document[PIAI].providers.opencode.models.map((model) => model.id), ['mystery-1', 'fresh-2'])
    assert.deepEqual(document[PIAI].providers.opencode.models[0], { id: 'mystery-1' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the gateway re-reads the machine proxy, so turning it on later moves egress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-gw-exit-'))
  /** @type {string | undefined} */
  let url
  let reachable = true
  const proxyWatcher = { current: async () => ({ url, source: 'test', detail: 'stub' }) }
  const fake = harness({ profileDir: dir })
  const gateway = fakeGateway()
  const controller = new Controller(fake.ctx, {
    dir,
    logger: fake.ctx.logger,
    bili: { locate: () => undefined },
    gateway,
    listAll: fakeListAll().listAll,
    proxyWatcher,
    egress: { dir, probe: async () => ({ reachable, ok: reachable, reason: reachable ? 'ok' : 'refused' }) },
  })
  await controller.store.load()
  try {
    await controller.routeGateway({ provider: 'google' })
    // The exit was resolved when the listener started: nothing to use yet.
    assert.equal(controller.proxyForHost('api.openai.com'), undefined)

    url = 'http://127.0.0.1:7897'
    await controller.refreshExit()
    assert.equal(controller.proxyForHost('api.openai.com'), 'http://127.0.0.1:7897')

    reachable = false
    await controller.refreshExit()
    assert.equal(controller.proxyForHost('api.openai.com'), undefined)
    await controller.view()
    assert.equal(controller.proxyForHost('api.openai.com'), undefined, 'the panel does not overwrite the probed exit')
    reachable = true
    await controller.refreshExit()
    assert.equal(controller.proxyForHost('api.openai.com'), url)

    // Reference directories still go direct: tunnelling to loopback through a
    // proxy only spends the timeout budget.
    url = undefined
    await controller.refreshExit()
    assert.equal(controller.proxyForHost('api.openai.com'), undefined)
  } finally {
    await controller.stopGateway()
    assert.equal(controller.exitTimer, undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a restore that cannot be written keeps the entry instead of forgetting the old address', async () => {
  const { controller, document, dir, writes } = await controllerFor()
  try {
    await controller.routeGateway({ provider: 'google' })
    assert.equal(writes.length, 1)
    // The listener is gone (a restart), and settings refuses the write: dropping
    // the entry here would leave the route pointed at a dead port with nothing
    // left to restore from.
    controller.write = async () => { throw new Error('settings said no') }
    await controller.revertRoutedBases('boot')
    const row = controller.store.data.gateway.entries.google
    assert.ok(row !== undefined, 'the entry has to survive a failed restore')
    assert.equal(controller.store.data.gateway.status, 'revert-failed')
    assert.match(String(controller.store.data.gateway.reason), /settings said no/)
    // The route is still pointed at the gateway, so it must keep saying so.
    assert.match(String(document[PIAI].providers.google.baseURL), /\/g\/google$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('undoing after the listener stopped still refuses a baseURL the user typed', async () => {
  const { controller, document, dir } = await controllerFor()
  try {
    controller.store.data.gateway = {
      enabled: false,
      port: 41234,
      entries: { google: { provider: 'google', routeId: 'google', previousBaseURL: GOOGLE_BASE, models: {}, at: Date.now() } },
    }
    await controller.store.save()
    // The user replaced the gateway URL by hand, and the listener is not running
    // (a restart). A stopped gateway has no `url`, which used to skip the guard.
    document[PIAI].providers.google.baseURL = 'https://my-own-endpoint.example/v1beta'
    await assert.rejects(
      () => controller.unrouteGateway({ provider: 'google' }),
      (error) => error.status === 409 && /no longer points at the gateway/.test(error.message),
    )
    assert.equal(document[PIAI].providers.google.baseURL, 'https://my-own-endpoint.example/v1beta')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two starts at once open one listener', async () => {
  const { controller, document, dir, gateway } = await controllerFor()
  try {
    controller.store.data.gateway = {
      enabled: false,
      port: 41234,
      entries: { google: { provider: 'google', routeId: 'google', previousBaseURL: GOOGLE_BASE, models: { 'gemini-4-argon': 'google-generative-ai' }, at: Date.now() } },
    }
    document[PIAI].providers.google.baseURL = 'http://127.0.0.1:41234/g/google'
    await controller.store.save()
    const [first, second] = await Promise.all([controller.ensureGateway(), controller.ensureGateway()])
    assert.equal(first, second, 'both callers get the same handle')
    assert.equal(gateway.created.length, 1, 'the second call must not bind a second listener')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
