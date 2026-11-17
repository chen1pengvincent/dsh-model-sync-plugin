/**
 * Activation smoke test: the host half loads, mounts its route, and answers
 * `GET /model-sync/api/view` from a fake harness context.
 *
 * This is the closest offline approximation of "the plugin activates in DSH".
 * It exists because an optional plugin that fails to activate is completely
 * silent in the Web host (no dialog, no warning), so catching a broken import or
 * a wrong service name here is the only cheap chance to notice.
 *
 * Run: node --test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as entry from '../lib/index.js'

const PIAI = 'llm-pi-ai'
const DEEPSEEK = 'llm-deepseek'

/** A harness context covering exactly the services this plugin touches. */
function fakeContext(dir) {
  const document = {
    [PIAI]: {
      providers: {
        google: { apiKeyEnv: 'GOOGLE_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
        // What the old plugin left behind: a key no route backs.
        'opencode-go-chat': { displayName: 'opencode-go · Chat Completions', apiKeyEnv: 'OPENCODE_GO_API_KEY' },
      },
    },
    [DEEPSEEK]: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  }
  /** @type {{path: string, handler: Function}[]} */
  const routes = []
  /** @type {(() => void)[]} */
  const disposers = []

  const services = {
    settings: {
      describe: () => Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: 1 })),
      mutate: async () => { throw new Error('the smoke test never writes') },
    },
    llm: {
      listConfigurableProviders: () => [
        { provider: 'google', settingsNs: PIAI, settingsPath: ['providers', 'google'], displayName: 'Google', defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta' },
        { provider: 'deepseek-official', settingsNs: DEEPSEEK, settingsPath: [], displayName: 'DeepSeek' },
      ],
      listModels: async (provider) => (provider === 'google' ? [{ id: 'gemini-4-argon' }] : [{ id: 'deepseek-chat' }]),
      resolveModelInfo: async (provider, id) => ({ provider, id, name: id }),
    },
    credentials: { resolve: async () => ({ value: 'not-a-real-key' }) },
    profileContext: { dir },
    webServer: {
      /** Mirrors `dsh-host-webserver`: returns a disposer. */
      register(spec) {
        routes.push(spec)
        return () => { routes.length = 0 }
      },
    },
  }

  /** @type {any} */
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => services[name],
    effect(execute) {
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    inject(_deps, callback) {
      return callback({ ...ctx, webServer: services.webServer })
    },
  }

  return { ctx, routes, disposers, document }
}

/** A minimal node:http request stand-in that yields one JSON body. */
function fakeRequest({ url, method, body = '' }) {
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body, 'utf8')
    },
  }
}

/** A minimal node:http response stand-in. */
function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
    },
  }
}

test('the host half activates and answers GET view', async () => {
  assert.equal(entry.name, 'dsh-model-sync', 'the exported name must match the package the loader keyed by')
  assert.deepEqual(entry.inject, ['settings'])

  const dir = await mkdtemp(join(tmpdir(), 'model-sync-smoke-'))
  const { ctx, routes, disposers } = fakeContext(dir)

  entry.apply(ctx)

  assert.equal(routes.length, 1, 'exactly one prefix route is mounted')
  assert.equal(routes[0].path, '/model-sync')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(typeof routes[0].handler, 'function')

  const response = fakeResponse()
  await routes[0].handler(fakeRequest({ url: '/model-sync/api/view', method: 'GET' }), response)

  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /application\/json/)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  const view = payload.view
  assert.deepEqual(view.providers.map((row) => row.provider).sort(), ['deepseek-official', 'google'])
  assert.deepEqual(view.foreign, ['opencode-go-chat'], 'the leftover key is reported, not touched')
  assert.ok(!JSON.stringify(view).includes('not-a-real-key'), 'no credential may reach the panel')

  for (const dispose of disposers) dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

test('an unknown verb is a 404 and a write verb is refused without a body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-smoke-'))
  const { ctx, routes, disposers } = fakeContext(dir)
  entry.apply(ctx)

  const missing = fakeResponse()
  await routes[0].handler(fakeRequest({ url: '/model-sync/api/nope', method: 'POST', body: '{}' }), missing)
  assert.equal(missing.status, 404)

  // GET is only allowed for `view`; everything else is POST.
  const wrongMethod = fakeResponse()
  await routes[0].handler(fakeRequest({ url: '/model-sync/api/check', method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)

  for (const dispose of disposers) dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

test('a broken service does not throw out of apply, and leaves a note behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-smoke-'))
  const { ctx } = fakeContext(dir)
  // A harness without the services this plugin needs must not take the host
  // down: activation is silent by design, so the note on disk is the only trace.
  // DSH_HOME is redirected so the failure note lands in the temp directory.
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    ctx.get = () => undefined
    ctx.inject = (_deps, callback) => callback({ ...ctx, webServer: undefined })
    assert.doesNotThrow(() => entry.apply(ctx))
    const note = await readFile(join(dir, 'model-sync', 'activation-error.txt'), 'utf8')
    assert.match(note, /register/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
})

test('a note from a previous session is cleared once this one mounts its route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-smoke-'))
  const stateDir = join(dir, 'model-sync')
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, 'activation-error.txt'), '2026-01-01T00:00:00.000Z\nwebserver: duplicate prefix route "/model-sync"\n', 'utf8')

  const { ctx, disposers } = fakeContext(dir)
  entry.apply(ctx)

  // Activation succeeded, so the old note is stale: keeping it would make the
  // panel (and `scripts/verify.mjs`) report a failure that no longer exists.
  await assert.rejects(readFile(join(stateDir, 'activation-error.txt'), 'utf8'), /ENOENT/)

  for (const dispose of disposers) dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

test('a route that cannot be mounted is recorded rather than silently missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-smoke-'))
  const { ctx } = fakeContext(dir)
  // The shape of a hot reload that kept the old registration: whatever the
  // reason, the panel is about to be missing, and the reason has to be findable.
  ctx.inject = (_deps, callback) => callback({
    ...ctx,
    webServer: { register() { throw new Error('webserver: duplicate prefix route "/model-sync"') } },
  })

  assert.doesNotThrow(() => entry.apply(ctx))
  const note = await readFile(join(dir, 'model-sync', 'activation-error.txt'), 'utf8')
  assert.match(note, /duplicate prefix route/)
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
