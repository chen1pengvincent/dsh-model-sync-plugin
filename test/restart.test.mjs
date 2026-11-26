/**
 * What happens across a host restart.
 *
 * The panel cannot be tested by restarting the app inside a test, but the two
 * things that break on restart can: the state file either survives or it does
 * not, and the second boot either writes to the user's settings or it does not.
 * Both halves are exercised here over one directory, with a fake harness whose
 * settings document outlives the controller -- which is exactly the situation a
 * restart creates from the plugin's point of view.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Controller } from '../lib/controller.js'

const PIAI = 'llm-pi-ai'
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * A harness whose settings document and revision counters live outside the
 * controller, so a second controller sees what the first one left behind.
 */
function host(state, options = {}) {
  const document = state.document
  /** @type {{ns: string, ops: any[], revision: number|undefined}[]} */
  const writes = state.writes

  const applyPath = (node, path, value, op) => {
    const copy = node !== null && typeof node === 'object' && !Array.isArray(node) ? { ...node } : {}
    if (path.length === 0) return value === undefined ? copy : value
    const [head, ...rest] = path
    if (rest.length === 0) {
      if (op === 'unset') delete copy[head]
      else copy[head] = structuredClone(value)
      return copy
    }
    copy[head] = applyPath(copy[head], rest, value, op)
    return copy
  }

  const settings = {
    describe() {
      return Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: state.revisions[ns] }))
    },
    async mutate(ns, ops, expectedRevision) {
      writes.push({ ns, ops, revision: expectedRevision })
      if (expectedRevision !== undefined && expectedRevision !== state.revisions[ns]) {
        throw Object.assign(new Error('revision conflict'), { name: 'SettingsConflictError' })
      }
      let value = document[ns]
      for (const op of ops) {
        value = op.op === 'set'
          ? applyPath(value, op.path, structuredClone(op.value), 'set')
          : applyPath(value, op.path, undefined, 'unset')
      }
      document[ns] = value
      state.revisions[ns] += 1
    },
  }

  const llm = {
    listConfigurableProviders: () => [
      {
        provider: 'google',
        settingsNs: PIAI,
        settingsPath: ['providers', 'google'],
        displayName: 'Google',
        defaultBaseURL: GOOGLE_BASE,
        nativeAuth: { env: ['GOOGLE_API_KEY'] },
      },
    ],
    async resolveModelInfo(provider, id) {
      return { provider, id, name: id }
    },
    async listModels(provider) {
      if (provider !== 'google') return []
      // What the route *effectively* serves: a stated list wins over the
      // catalog, which is exactly why `check` diffs against it.
      const stated = document[PIAI].providers.google.models
      const ids = Array.isArray(stated) ? stated.map((model) => model.id) : state.upstream
      return ids.map((id) => ({ id }))
    },
  }

  const credentials = { async resolve() { return { value: 'SECRET-VALUE-DO-NOT-STORE' } } }

  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      if (name === 'llm') return llm
      if (name === 'credentials') return credentials
      if (name === 'profileContext') return { dir: state.dir }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
  }

  return { ctx, writes }
}

/** One controller over one state directory, as `apply()` would build it. */
async function boot(state) {
  const { ctx } = host(state)
  const controller = new Controller(ctx, {
    dir: state.dir,
    egress: { dir: state.dir },
    logger: ctx.logger,
    // Never the network: the listing is the one external call a check makes.
    list: async () => ({ api: 'google-generative-ai', via: 'direct', models: state.upstream.map((id) => ({ id })) }),
    // Never the real lane: a stray sync would rewrite another plugin's config.
    bili: { locate: () => undefined },
  })
  await controller.store.load()
  return controller
}

function initialState(dir) {
  return {
    dir,
    /** The harness settings document: `providers.google` is already configured. */
    document: {
      [PIAI]: {
        providers: {
          google: { apiKeyEnv: 'GOOGLE_API_KEY', baseURL: GOOGLE_BASE, models: [{ id: 'gemini-4-argon' }] },
        },
      },
    },
    revisions: { [PIAI]: 1 },
    writes: [],
    upstream: ['gemini-4-argon'],
  }
}

test('unload cancels an in-flight provider check and waits for it to finish', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-check-dispose-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = initialState(dir)
  const controller = await boot(state)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  controller.list = async ({ signal }) => {
    entered.resolve(signal)
    await release.promise
    return { api: 'google-generative-ai', models: [{ id: 'gemini-4-argon', maxTokens: 500 }] }
  }
  const check = controller.check({ reason: 'schedule' })
  const signal = await entered.promise
  let disposed = false
  const disposing = controller.dispose().then(() => { disposed = true })
  await new Promise((resolve) => setImmediate(resolve))
  const finishedEarly = disposed
  release.resolve()
  const [completed] = await Promise.allSettled([check, disposing])
  assert.ok(signal?.aborted)
  assert.equal(finishedEarly, false)
  assert.equal(completed.status, 'rejected')
  assert.deepEqual(state.writes, [])
  assert.deepEqual(controller.store.data.checks, {})
  assert.equal(controller.store.data.summary, undefined)
})

test('disposal while taking the autofill snapshot prevents a late host write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-snapshot-dispose-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = initialState(dir)
  const controller = await boot(state)
  controller.list = async () => ({ api: 'google-generative-ai', models: [{ id: 'gemini-4-argon', maxTokens: 500 }] })
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  controller.snapshotMetadata = async () => {
    entered.resolve()
    await resume.promise
  }
  const check = controller.check()
  await entered.promise
  const disposing = controller.dispose()
  resume.resolve()
  await assert.rejects(check, { name: 'AbortError' })
  await disposing
  assert.deepEqual(state.writes, [])
})

test('self-check reads diagnostics without projecting sessions or building panel rows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-diagnostics-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const controller = await boot(initialState(dir))
  t.after(() => controller.dispose())
  for (const name of ['metadataView', 'reviewView', 'modelUsage']) {
    controller[name] = () => assert.fail(`self-check invoked panel method ${name}`)
  }
  const verdict = await controller.runSelfCheck()
  assert.equal(verdict.ok, true)
  assert.ok(verdict.notes.includes('1 个已配置供应商'))
})

test('disposal during a boot catalog fetch cancels it without arming a late timer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-dispose-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const controller = await boot(initialState(dir))
  let notifyStarted
  const fetching = new Promise((resolve) => { notifyStarted = resolve })
  controller.modelsDevLoader = async ({ signal }) => {
    notifyStarted()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const start = controller.start()
  await fetching
  await controller.dispose()
  await start
  assert.equal(controller.bootTimer, undefined)
  assert.equal(controller.store.data.selfCheck, undefined)
})

test('a restart keeps the schedule, the ignore list and the self-check, and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-restart-'))
  const state = initialState(dir)
  const first = await boot(state)
  try {
    await first.start()
    const before = await first.view()
    assert.equal(before.selfCheck?.ok, true, JSON.stringify(before.selfCheck?.failures))
    assert.equal(existsSync(join(dir, 'state.json')), true, 'the first boot has to leave a state file behind')
    assert.deepEqual(state.writes, [], 'booting must not write to the user settings')

    // The two things a user changes on the first render, then closes the app.
    await first.settings({ schedule: { enabled: false, hour: 7 } })
    await first.ignore({ provider: 'google', ids: ['gemini-not-here-yet'] })
  } finally {
    first.dispose()
  }

  const second = await boot(state)
  try {
    assert.equal(second.store.data.schedule?.hour, 7, 'the hour must survive the restart')
    assert.equal(second.store.data.schedule?.enabled, false)
    assert.deepEqual(second.store.data.ignored?.google, ['gemini-not-here-yet'])
    assert.ok(second.store.data.selfCheck !== undefined, 'the previous verdict is what the first render shows')

    const writes = state.writes.length
    await second.start()
    assert.equal(state.writes.length, writes, 'the second boot must not write either')
    const view = await second.view()
    assert.equal(view.selfCheck?.ok, true)
    assert.ok(view.providers.length > 0, 'the panel needs rows after a restart too')
    assert.equal(view.schedule.hour, 7)
    assert.equal(view.gateway?.running, false, 'the gateway is not started by a plain boot')
  } finally {
    second.dispose()
  }

  await rm(dir, { recursive: true, force: true })
})

test('after a restart the ignored id stays quiet while a new one is written once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-restart-'))
  const state = initialState(dir)
  const first = await boot(state)
  await first.start()
  await first.ignore({ provider: 'google', ids: ['gemini-quiet'] })
  first.dispose()

  // The upstream grew by two ids: one the user silenced, one genuinely new.
  state.upstream = ['gemini-4-argon', 'gemini-quiet', 'gemini-new']
  const second = await boot(state)
  try {
    const checked = await second.check({ provider: 'google' })
    assert.deepEqual(checked.results[0].added.map((row) => row.id), ['gemini-new'], 'the ignored id must not come back as news')

    const applied = await second.apply({ provider: 'google' })
    assert.deepEqual(applied.written, ['gemini-new'])
    assert.equal(state.writes.length, 1, 'one write, not one per model')
    const op = state.writes[0].ops[0]
    assert.deepEqual(op.path, ['providers', 'google', 'models'], 'the write stays inside the model list')
    const ids = op.value.map((row) => row.id).sort()
    assert.deepEqual(ids, ['gemini-4-argon', 'gemini-new'])

    // A snapshot of what was there before the write has to exist on disk: that
    // is the only thing that makes "undo" possible after a restart.
    const snapshots = await readdir(join(dir, 'snapshots'))
    assert.ok(snapshots.length >= 1, 'the write must be preceded by a snapshot')

    // And a second apply from the same state is a no-op: the panel's button is
    // safe to press twice.
    // Pressing the button twice is refused with a sentence, not a second write:
    // the check's additions were consumed by the first apply.
    await assert.rejects(second.apply({ provider: 'google' }), /nothing to add/)
    assert.equal(state.writes.length, 1)
  } finally {
    second.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
