/**
 * Tests for the bili egress-proxy hand-off.
 *
 * Two layers:
 *  - the pure functions, which decide *what* to write into another plugin's
 *    config file. The property that matters is that the edit is minimal and
 *    exactly reversible: everything this plugin did not create must read back
 *    byte-for-byte, because that config belongs to bili, not to us.
 *  - the controller path, against a fake lane, so the file and the HTTP call are
 *    never real. (One accidental `node --test` run already proved why.)
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, stat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Controller } from '../lib/controller.js'
import {
  BiliConfigError, DEFAULT_PROXY_HOSTS, getConfig, locate, parseJsonc, planProviders, putConfig, readConfigFile, readConfigStrict, revertProviders,
} from '../lib/bili.js'
import { ProxyWatcher } from '../lib/proxy.js'

const PIAI = 'llm-pi-ai'
const DEEPSEEK = 'llm-deepseek'
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const PROXY = 'http://127.0.0.1:7897'

/* ------------------------------------------------------------------ parsing */

test('a JSONC config keeps URLs intact while dropping comments and trailing commas', () => {
  const text = `{
    // the lane writes this at startup
    "providers": { "https://api.openai.com": { "proxy": "http://127.0.0.1:7897" } },
    /* block comment with a "quote" */
    "compress": { "maxContextLimit": 0.267, },
  }`
  assert.deepEqual(JSON.parse(parseJsonc(text)), {
    providers: { 'https://api.openai.com': { proxy: 'http://127.0.0.1:7897' } },
    compress: { maxContextLimit: 0.267 },
  })
})

test('a missing config file reads as an empty object instead of throwing', async () => {
  assert.deepEqual(await readConfigFile('/definitely/not/here.json'), {})
})

/* -------------------------------------------------------------- locate lane */

test('locate prefers a live proxy-origin, then the port zone, then gives up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bili-locate-'))
  try {
    const configDir = join(dir, 'config')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(dir, 'port-zone.json'), JSON.stringify({ lanes: { dsh: 18787 } }))
    // No proxy-origin yet: the port zone is the only evidence.
    assert.equal(locate({ dir, isAlive: () => true }).origin, 'http://127.0.0.1:18787')

    await writeFile(join(dir, 'proxy-origin'), JSON.stringify({ origin: 'http://127.0.0.1:19000/', pid: 42, lane: 'dsh' }))
    const live = locate({ dir, isAlive: () => true })
    assert.equal(live.origin, 'http://127.0.0.1:19000')
    assert.equal(live.pid, 42)

    // A zombie pid means the recorded origin is from a previous boot.
    assert.equal(locate({ dir, isAlive: () => false }).origin, 'http://127.0.0.1:18787')

    await rm(join(dir, 'port-zone.json'))
    await rm(join(dir, 'proxy-origin'))
    assert.equal(locate({ dir, isAlive: () => false }), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the config path follows XDG, not the home directory', () => {
  const where = locate({ env: { XDG_CONFIG_HOME: '/tmp/xdg', XDG_STATE_HOME: '/tmp/xdg-state' }, dir: '/tmp/none', isAlive: () => false })
  assert.equal(where, undefined)
  const real = locate({ env: { BILI_CONFIG_FILE: '/tmp/explicit.json', XDG_STATE_HOME: '/tmp/none' }, isAlive: () => false })
  assert.equal(real, undefined)
})

/* ----------------------------------------------------------- edit planning */

test('planning only touches the listed hosts and leaves other keys alone', () => {
  const config = {
    providers: { 'https://api.openai.com': { models: { 'gpt-6': { context: 400_000 } }, proxy: 'http://old:1' } },
    compress: { maxContextLimit: 0.267 },
    security: { adminRelay: true },
  }
  const plan = planProviders(config, ['api.openai.com', 'generativelanguage.googleapis.com'], PROXY)

  assert.deepEqual(plan.unchanged, [])
  assert.equal(plan.next.compress.maxContextLimit, 0.267)
  assert.equal(plan.next.security.adminRelay, true)
  // An existing entry keeps every field it had; only `proxy` moves.
  assert.deepEqual(plan.next.providers['https://api.openai.com'], { models: { 'gpt-6': { context: 400_000 } }, proxy: PROXY })
  assert.deepEqual(plan.next.providers['https://generativelanguage.googleapis.com'], { proxy: PROXY })
  assert.deepEqual(plan.touched.map((row) => row.created).sort(), [false, true])
  // The input object is not mutated: the caller may still need the original.
  assert.equal(config.providers['https://api.openai.com'].proxy, 'http://old:1')
})

test('a second run plans nothing, so the sync is idempotent', () => {
  const first = planProviders({ providers: {} }, ['api.openai.com'], PROXY)
  const second = planProviders(first.next, ['api.openai.com'], PROXY)
  assert.deepEqual(second.touched, [])
  assert.deepEqual(second.unchanged, ['https://api.openai.com'])
})

test('a MITM twin for the same host is updated together with the https entry', () => {
  const config = { providers: { 'mitm://api.anthropic.com': { direct: true } } }
  const plan = planProviders(config, ['api.anthropic.com'], PROXY)
  assert.deepEqual(plan.next.providers['mitm://api.anthropic.com'], { direct: true, proxy: PROXY })
  assert.deepEqual(plan.next.providers['https://api.anthropic.com'], { proxy: PROXY })
})

test('reverting restores the previous table exactly, including deletions', () => {
  const config = { providers: { 'https://api.openai.com': { proxy: 'http://old:1', models: {} } }, compress: { a: 1 } }
  const plan = planProviders(config, DEFAULT_PROXY_HOSTS, PROXY)
  assert.deepEqual(revertProviders(plan.next, plan.touched), config)
})

/* ------------------------------------------------------- controller wiring */

function fakeLane(options = {}) {
  const lane = {
    config: structuredClone(options.config ?? { providers: {}, compress: { maxContextLimit: 0.267 } }),
    puts: /** @type {any[]} */ ([]),
    backups: 0,
    locate: options.locate ?? (() => ({ origin: 'http://127.0.0.1:18787', pid: 7, lane: 'dsh', configPath: '/tmp/x.json', statePath: '/tmp/x' })),
    async readConfigFile() { return structuredClone(lane.config) },
    // The write path goes through the strict reader; a fake that only spells the
    // lenient one would silently fall back to the real module and read the real
    // file.
    async readConfigStrict() { return structuredClone(lane.config) },
    // Mirrors the lane's real handler: read its own file, replace `providers`
    // wholesale, keep every other key. A fake that swallowed the payload whole
    // would hide the difference between a narrow and a full write.
    async putConfig(_origin, next) {
      lane.puts.push(structuredClone(next))
      if (lane.failWith !== undefined) return lane.failWith
      const merged = { ...structuredClone(lane.config), ...structuredClone(next) }
      merged.providers = structuredClone(next.providers ?? lane.config.providers ?? {})
      lane.config = merged
      return { status: 200, body: '{}' }
    },
    // The real module exposes both spellings; a fake that only had `putConfig`
    // would silently exercise the wrong seam.
    async putProviders(origin, providers) { return lane.putConfig(origin, { providers }) },
    async getConfig() { return { status: 200, text: JSON.stringify(lane.config) } },
    async backup() { lane.backups += 1; return '/tmp/backup.json' },
  }
  return lane
}

/** Minimal service harness — the same seams the real host exposes. */
function harness(profileDir) {
  const document = { [PIAI]: { providers: { google: { apiKeyEnv: 'GOOGLE_API_KEY', baseURL: GOOGLE_BASE } } }, [DEEPSEEK]: {} }
  const settings = {
    describe() { return Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: 1 })) },
    async mutate() {},
  }
  const llm = {
    listConfigurableProviders: () => [
      { provider: 'google', settingsNs: PIAI, settingsPath: ['providers', 'google'], displayName: 'Google', defaultBaseURL: GOOGLE_BASE },
      { provider: 'deepseek-official', settingsNs: DEEPSEEK, settingsPath: [], displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com' },
    ],
    // A route with no models is skipped by `configuredTargets`, so the harness
    // has to serve something or no host would ever be planned.
    async listModels(provider) { return [{ id: provider === 'google' ? 'gemini-4-argon' : 'deepseek-chat' }] },
  }
  return {
    get(name) {
      if (name === 'settings') return settings
      if (name === 'llm') return llm
      if (name === 'credentials') return { async resolve() { return { value: 'KEY' } } }
      if (name === 'profileContext') return { dir: profileDir }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
  }
}

const withProxy = () => new ProxyWatcher({ platform: 'linux', env: { HTTPS_PROXY: PROXY } })
const withoutProxy = () => new ProxyWatcher({ platform: 'linux', env: {} })

async function controllerFor(lane, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bili-sync-'))
  const controller = new Controller(harness(dir), {
    dir,
    logger: { warn() {}, info() {}, error() {} },
    bili: lane,
    egress: { dir, probe: async () => ({ ok: true, reachable: true, reason: 'ok' }) },
    proxyWatcher: (options.proxyWatcher ?? withProxy)(),
  })
  await controller.store.load()
  return { controller, dir }
}

test('a sync sends only the providers table, never the rest of the config', async () => {
  const lane = fakeLane()
  const { controller, dir } = await controllerFor(lane)
  try {
    await controller.syncBili({ reason: 'test' })
    assert.equal(lane.puts.length, 1)
    assert.deepEqual(Object.keys(lane.puts[0]), ['providers'])
    // The lane keeps what it owned before.
    assert.equal(lane.config.compress.maxContextLimit, 0.267)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('turning the switch off takes the entries back out', async () => {
  const lane = fakeLane()
  const { controller, dir } = await controllerFor(lane)
  try {
    await controller.syncBili({ reason: 'test' })
    assert.equal(controller.store.data.bili.written.length, 1)
    const off = await controller.settings({ bili: { enabled: false } })
    assert.equal(off.bili.status, 'disabled')
    assert.deepEqual(lane.config.providers, {})
    assert.equal(controller.store.data.bili.written.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a vanished proxy clears the entries instead of leaving them dead', async () => {
  const lane = fakeLane()
  const env = { HTTPS_PROXY: PROXY }
  const watcher = new ProxyWatcher({ platform: 'linux', env })
  const { controller, dir } = await controllerFor(lane, { proxyWatcher: () => watcher })
  try {
    await controller.syncBili({ reason: 'test' })
    assert.equal(controller.store.data.bili.written.length, 1)
    delete env.HTTPS_PROXY
    watcher.invalidate()
    const gone = await controller.syncBili({ reason: 'test' })
    assert.equal(gone.status, 'revoked')
    assert.deepEqual(lane.config.providers, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a sync adds only the host that the configured route actually uses', async () => {
  const lane = fakeLane()
  const { controller, dir } = await controllerFor(lane)
  try {
    const result = await controller.syncBili({ reason: 'test' })
    assert.equal(result.status, 'applied')
    assert.equal(lane.puts.length, 1)
    const sent = lane.puts[0]
    // Google is configured here; OpenAI and Anthropic are not, so they stay out.
    assert.deepEqual(Object.keys(sent.providers), ['https://generativelanguage.googleapis.com'])
    assert.equal(sent.providers['https://generativelanguage.googleapis.com'].proxy, PROXY)
    // Only the providers table is sent; `compress` stays the lane's business.
    assert.deepEqual(Object.keys(sent), ['providers'])
    assert.equal(lane.config.compress.maxContextLimit, 0.267, 'unrelated keys survive in the lane file')
    assert.equal(lane.backups, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no system proxy means no write at all', async () => {
  const lane = fakeLane()
  const { controller, dir } = await controllerFor(lane, { proxyWatcher: withoutProxy })
  try {
    const result = await controller.syncBili({})
    assert.equal(result.status, 'no-proxy')
    assert.equal(lane.puts.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a disabled feature means no write even with a proxy and a live lane', async () => {
  const lane = fakeLane()
  const { controller, dir } = await controllerFor(lane)
  try {
    await controller.settings({ bili: { enabled: false } })
    assert.equal(lane.puts.length, 0)
    assert.equal(controller.store.data.bili.status, 'disabled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a lane nothing is written and nothing throws', async () => {
  const lane = fakeLane({ locate: () => undefined })
  const { controller, dir } = await controllerFor(lane)
  try {
    assert.equal((await controller.syncBili({})).status, 'no-bili')
    assert.equal(lane.puts.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rejected payload is reported and is not recorded as written', async () => {
  const lane = fakeLane()
  lane.failWith = { status: 400, body: '{"error":"invalid per-URL upstream proxy"}' }
  const { controller, dir } = await controllerFor(lane)
  try {
    const result = await controller.syncBili({})
    assert.equal(result.status, 'rejected')
    assert.match(result.error, /bili refused the config \(400\)/)
    // `emptyState` now declares an empty `written` list up front, so "nothing
    // recorded" means an empty list rather than an absent field.
    assert.deepEqual(controller.store.data.bili?.written ?? [], [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('revoking removes only the keys this plugin created', async () => {
  const lane = fakeLane({ config: { providers: { 'https://api.openai.com': { proxy: 'http://user:9', models: { a: 1 } } }, compress: { keep: true } } })
  const { controller, dir } = await controllerFor(lane)
  try {
    await controller.syncBili({})
    assert.ok(lane.config.providers['https://generativelanguage.googleapis.com'], 'google entry was added')
    // Pretend the user set OpenAI up themselves before the sync.
    const result = await controller.revokeBili()
    assert.equal(result.status, 'revoked')
    assert.equal(result.phase, 'revoked')
    assert.equal(controller.store.data.bili.phase, 'revoked')
    const final = lane.config.providers
    assert.equal(final['https://generativelanguage.googleapis.com'], undefined, 'created key removed')
    assert.deepEqual(final['https://api.openai.com'], { proxy: 'http://user:9', models: { a: 1 } }, 'user entry intact')
    assert.equal(lane.config.compress.keep, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('state survives a reload and never contains the proxy credential', async () => {
  const lane = fakeLane()
  const { controller, dir } = await controllerFor(lane)
  try {
    await controller.syncBili({})
    const raw = await readFile(join(controller.store.dir, 'state.json'), 'utf8')
    assert.ok(raw.includes('generativelanguage'), 'the written key is remembered')
    assert.ok(!raw.includes('SECRET'), 'no credential is persisted')
    const again = new Controller(harness(dir), { dir: controller.store.dir, logger: controller.logger, bili: lane, egress: { dir }, proxyWatcher: withProxy() })
    await again.store.load()
    assert.equal(again.store.data.bili.written.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------- live-shaped */

test('putConfig sends a PUT to the lane over a raw socket', async () => {
  // No server is listening: the assertion is that it fails like a socket, not
  // like a patched `fetch` that silently rewrote the URL.
  await assert.rejects(() => putConfig('http://127.0.0.1:1', { providers: {} }, { timeoutMs: 1_000 }))
  await assert.rejects(() => getConfig('http://127.0.0.1:1', { timeoutMs: 1_000 }))
})

test('a concurrent edit aborts the transaction and the next sync reads the fresh table', async () => {
  // bili rewrites this file from its own settings UI, and the PUT replaces the
  // whole `providers` table. If the plugin planned from an older read it would
  // write that older table back — silently undoing an edit made in between.
  const lane = fakeLane()
  let reads = 0
  const original = lane.getConfig
  lane.getConfig = async () => {
    reads += 1
    // Only the *second* read sees the entry bili added in the meantime.
    if (reads === 2) lane.config.providers['https://api.anthropic.com'] = { proxy: 'http://127.0.0.1:7899' }
    return original()
  }
  const env = { HTTPS_PROXY: PROXY }
  const watcher = new ProxyWatcher({ platform: 'linux', env })
  const { controller, dir } = await controllerFor(lane, { proxyWatcher: () => watcher })
  try {
    const conflict = await controller.syncBili({ reason: 'manual' })
    assert.equal(conflict.phase, 'conflict')
    assert.equal(lane.puts.length, 0)
    const result = await controller.syncBili({ reason: 'manual' })
    assert.equal(result.status, 'applied')
    const sent = lane.puts.at(-1).providers
    assert.deepEqual(sent['https://api.anthropic.com'], { proxy: 'http://127.0.0.1:7899' }, "bili's own entry has to survive our write")
    assert.equal(sent['https://generativelanguage.googleapis.com'].proxy, PROXY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second sync keeps the first record, so turning the switch off still deletes the entry', async () => {
  const lane = fakeLane()
  const env = { HTTPS_PROXY: PROXY }
  const watcher = new ProxyWatcher({ platform: 'linux', env })
  const { controller, dir } = await controllerFor(lane, { proxyWatcher: () => watcher })
  try {
    await controller.syncBili({ reason: 'first' })
    const key = 'https://generativelanguage.googleapis.com'
    assert.equal(controller.store.data.bili.written[0].created, true)
    assert.ok(lane.config.providers[key] !== undefined)

    // The proxy moved: the second sync sees `previous` = the value this plugin
    // wrote itself. Keeping the newer record would forget that it made the entry.
    env.HTTPS_PROXY = 'http://127.0.0.1:7899'
    watcher.invalidate()
    await controller.syncBili({ reason: 'moved' })
    assert.equal(controller.store.data.bili.written[0].created, true, 'the original record wins')

    const off = await controller.settings({ bili: { enabled: false } })
    assert.equal(off.bili.status, 'disabled')
    assert.deepEqual(lane.config.providers, {}, 'the entry this plugin created has to be gone')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a lane config that cannot be read is never written over', async () => {
  const lane = fakeLane()
  lane.getConfig = async () => ({ status: 200, text: JSON.stringify({ providers: {}, parseError: 'bad' }) })
  const { controller, dir } = await controllerFor(lane)
  try {
    const done = await controller.syncBili({ reason: 'test' })
    assert.equal(done.status, 'rejected')
    assert.match(String(done.error), /没有写入/)
    assert.equal(lane.puts.length, 0, 'writing an empty table would delete the user entries')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the strict reader refuses a corrupt file but treats a missing one as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bili-read-'))
  try {
    const missing = join(dir, 'nope.json')
    assert.deepEqual(await readConfigStrict(missing), {})
    assert.deepEqual(await readConfigFile(missing), {})

    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{ "providers": { "https://a": { "proxy": ', 'utf8')
    await assert.rejects(() => readConfigStrict(corrupt), (error) => error instanceof BiliConfigError && /解析失败/.test(error.message))
    assert.deepEqual(await readConfigFile(corrupt), {}, 'the display path stays lenient')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------- not ours to delete or rewrite */

test('an entry the user edited after we wrote it is left alone on revoke', () => {
  const config = { providers: {} }
  const plan = planProviders(config, ['api.anthropic.com'], PROXY)
  assert.equal(plan.touched[0].created, true)
  // The user adds their own note to the entry we created.
  const edited = structuredClone(plan.next)
  edited.providers['https://api.anthropic.com'].note = 'my own'
  const reverted = revertProviders(edited, plan.touched)
  assert.deepEqual(reverted.providers['https://api.anthropic.com'], { proxy: PROXY, note: 'my own' }, 'their edit survives')

  // ...and one we modified is not rolled back to our old value either.
  const existing = { providers: { 'https://api.openai.com': { models: { m: { context: 1 } }, proxy: 'http://old:1' } } }
  const touched = planProviders(existing, ['api.openai.com'], PROXY)
  const theirs = structuredClone(touched.next)
  theirs.providers['https://api.openai.com'].proxy = 'http://their-own:2222'
  const keeps = revertProviders(theirs, touched.touched)
  assert.equal(keeps.providers['https://api.openai.com'].proxy, 'http://their-own:2222')
})

test('an unchanged entry is still fully reversed', () => {
  const config = { providers: { 'https://api.openai.com': { proxy: 'http://old:1', models: {} } }, compress: { a: 1 } }
  const plan = planProviders(config, DEFAULT_PROXY_HOSTS, PROXY)
  assert.deepEqual(revertProviders(plan.next, plan.touched), config)
})

test('a lane record without a pid cannot outrank the port zone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-locate-'))
  try {
    writeFileSync(join(dir, 'proxy-origin'), JSON.stringify({ origin: 'http://127.0.0.1:1', lane: 'dsh' }))
    writeFileSync(join(dir, 'port-zone.json'), JSON.stringify({ lanes: { dsh: 2 } }))
    const where = locate({ env: {}, dir, isAlive: () => false })
    assert.equal(where?.origin, 'http://127.0.0.1:2', 'a record with no pid is stale by default')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dead lane pid falls back to the port zone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-locate-'))
  try {
    writeFileSync(join(dir, 'proxy-origin'), JSON.stringify({ origin: 'http://127.0.0.1:1', pid: 999999 }))
    writeFileSync(join(dir, 'port-zone.json'), JSON.stringify({ lanes: { dsh: 2 } }))
    assert.equal(locate({ env: {}, dir, isAlive: () => false })?.origin, 'http://127.0.0.1:2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a JSONC string containing a closing brace is not rewritten', () => {
  assert.equal(parseJsonc('{"h":"x,}"}'), '{"h":"x,}"}')
  assert.equal(parseJsonc('{"h":["a,]","b"]}'), '{"h":["a,]","b"]}')
  // Real trailing commas still go.
  assert.equal(parseJsonc('{"a":1,}'), '{"a":1}')
  assert.equal(parseJsonc('{"a":[1,2,],}'), '{"a":[1,2]}')
})

test('a byte-order mark does not make the config unreadable', () => {
  assert.equal(parseJsonc('\uFEFF{"a":1}'), '{"a":1}')
})

test('an existing entry spelled with a port is reused, not duplicated', () => {
  const config = { providers: { 'https://API.openai.com:443': { proxy: PROXY } } }
  const plan = planProviders(config, ['api.openai.com'], PROXY)
  assert.deepEqual(Object.keys(plan.next.providers), ['https://API.openai.com:443'])
  assert.deepEqual(plan.unchanged, ['https://API.openai.com:443'])
})


test('DSH_MODEL_SYNC_EGRESS_DIR isolates journal writes from the real egress directory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-egress-env-'))
  const journalDir = join(dir, 'egress')
  const previous = process.env.DSH_MODEL_SYNC_EGRESS_DIR
  process.env.DSH_MODEL_SYNC_EGRESS_DIR = journalDir
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_MODEL_SYNC_EGRESS_DIR
    else process.env.DSH_MODEL_SYNC_EGRESS_DIR = previous
    await rm(dir, { recursive: true, force: true })
  })

  const liveJournal = join(homedir(), '.dsh', 'model-sync', 'egress.json')
  const modificationTime = async () => stat(liveJournal).then(({ mtimeMs }) => mtimeMs, (error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const before = await modificationTime()
  const lane = fakeLane()
  const controller = new Controller(harness(dir), {
    dir,
    proxyWatcher: withProxy(),
    bili: lane,
    egress: { probe: async () => ({ ok: true, reachable: true, reason: 'ok' }) },
  })
  await controller.store.load()
  assert.equal((await controller.syncBili()).status, 'applied')
  const journal = JSON.parse(await readFile(join(journalDir, 'egress.json'), 'utf8'))
  assert.ok(journal.lanes['lane:/tmp/x.json'])
  assert.equal(await modificationTime(), before)
})
