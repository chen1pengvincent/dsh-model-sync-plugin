/**
 * Independent adversarial cases for the 3.1.3 egress supervisor.
 *
 * These are written from the incident (a dead 127.0.0.1:7897 lane sat in bili
 * for a week) rather than from the implementation, so they answer one question:
 * would this have caught the original failure, and what still gets through?
 *
 * Each test is named A<n> so it can be run alone:
 *   node --test --test-name-pattern='^A5' test/egress-adversarial.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createProxyServer } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backupConfig, getConfig, putProviders } from '../lib/bili.js'
import { Store } from '../lib/state.js'
import { withLock } from '../lib/egress/lock.js'
import { probeProxy } from '../lib/egress/probe.js'
import { readLane } from '../lib/egress/execute.js'
import { EgressSupervisor } from '../lib/egress/supervise.js'

const GOOGLE = 'generativelanguage.googleapis.com'
const HTTPS = `https://${GOOGLE}`
const MITM = `mitm://${GOOGLE}`
const OLD = 'http://127.0.0.1:7897'
const ALT = 'http://127.0.0.1:7890'
const LIVE_ORIGIN = 'http://127.0.0.1:18787'

const ALIVE = { ok: true, reachable: true, reason: 'ok' }
const DEAD = { ok: false, reachable: false, reason: 'refused' }
const HUNG = { ok: false, reachable: false, reason: 'timeout' }

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'egress-adv-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function fakeLane(providers = {}, options = {}) {
  const lane = {
    origin: 'http://127.0.0.1:18787',
    pid: 4242,
    config: { providers: structuredClone(providers), compress: { keep: true } },
    puts: [],
    backups: [],
    locate() { return { origin: lane.origin, pid: lane.pid, configPath: '/fake/bili.json' } },
    async getConfig() {
      if (options.getConfig) return options.getConfig(lane)
      const raw = options.raw ?? JSON.stringify({ providers: lane.config.providers, compress: lane.config.compress })
      return { status: 200, text: JSON.stringify({ path: '/fake/bili.json', providers: lane.config.providers, raw }) }
    },
    async backup(dir, config) {
      lane.backups.push(structuredClone(config))
      return backupConfig(dir, config)
    },
    async putProviders(_origin, table) {
      lane.puts.push(structuredClone(table))
      lane.config.providers = structuredClone(table)
      return { status: options.putStatus ?? 200 }
    },
  }
  return lane
}

async function makeSupervisor(t, dir, lane, options = {}) {
  const profile = options.profile ?? 'desktop'
  const store = new Store(join(dir, profile))
  await store.load()
  if (options.rollback === true) {
    store.data.bili = { ...store.data.bili, supervisor: false }
    await store.save()
  }
  const responses = new Map([[OLD, ALIVE], [ALT, ALIVE], ...(options.probeMap ?? [])])
  const observations = []
  const service = new EgressSupervisor({
    dir: join(dir, 'shared'),
    profile,
    store,
    bili: lane,
    hosts: async () => options.hosts ?? [GOOGLE],
    proxy: async () => ({ available: options.proxyUrl !== undefined, url: options.proxyUrl }),
    probe: async (url) => {
      observations.push(url)
      const found = responses.get(url)
      if (found !== undefined) return found
      if (options.probe) return options.probe(url)
      return DEAD
    },
    now: () => options.clock.now,
  })
  t.after(() => service.stop())
  const journal = async () => JSON.parse(await readFile(join(dir, 'shared', 'egress.json'), 'utf8'))
  return { service, store, responses, observations, journal }
}

/** A real bili lane, or undefined when the daemon is not running. */
async function liveLane() {
  try {
    const reply = await getConfig(LIVE_ORIGIN)
    if (reply.status !== 200) return undefined
    return { origin: LIVE_ORIGIN, reply }
  } catch {
    return undefined
  }
}

test('A1: the real bili GET satisfies the raw-vs-providers guard readLane relies on', async (t) => {
  const live = await liveLane()
  if (live === undefined) return t.skip('bili is not running on 18787')
  const parsed = JSON.parse(live.reply.text)
  assert.equal(typeof parsed.raw, 'string', 'bili must keep returning raw, or readLane reads nothing')
  const lane = await readLane({ getConfig }, { origin: LIVE_ORIGIN })
  assert.equal(lane.identity, parsed.path)
  assert.deepEqual(lane.providers, parsed.providers)
  assert.deepEqual(lane.snapshot.providers, parsed.providers)
})

test('A2: the real bili accepts the narrow providers write the executor sends', async (t) => {
  const live = await liveLane()
  if (live === undefined) return t.skip('bili is not running on 18787')
  const before = JSON.parse(live.reply.text).providers
  // Never rewrite a real table that has user content in it.
  if (Object.keys(before).length !== 0) return t.skip('bili has live provider entries; not rewriting them')
  const put = await putProviders(LIVE_ORIGIN, before)
  assert.ok(put.status >= 200 && put.status < 300, `bili refused a no-op write: ${put.status}`)
  const after = JSON.parse((await getConfig(LIVE_ORIGIN)).text)
  assert.deepEqual(after.providers, {})
})

test('A3: a bili table read back inconsistently is refused instead of written', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane({}, {
    raw: JSON.stringify({ providers: { [MITM]: { proxy: 'http://127.0.0.1:1234' } } }),
  })
  const { service } = await makeSupervisor(t, dir, lane, { clock, proxyUrl: OLD })
  const result = await service.run('boot')
  assert.equal(result.status, 'rejected')
  assert.equal(lane.puts.length, 0)
})

test('A4: a 3.1.2-era state.json loads, keeps enabling, and never resurrects its old written rows', async (t) => {
  const dir = await temporary(t)
  const profileDir = join(dir, 'desktop')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'state.json'), JSON.stringify({
    version: 1,
    bili: { enabled: true, hosts: [GOOGLE], written: [{ key: HTTPS, host: GOOGLE, proxy: OLD }] },
  }))
  const store = new Store(profileDir)
  await store.load()
  assert.equal(store.data.bili.supervisor, true, 'the rollback switch must default to on')
  assert.equal(store.data.bili.enabled, true)

  const clock = { now: 1_000_000 }
  const lane = fakeLane({ [HTTPS]: { proxy: OLD } })
  const service = new EgressSupervisor({
    dir: join(dir, 'shared'), profile: 'desktop', store, bili: lane,
    hosts: async () => [GOOGLE],
    proxy: async () => ({ available: true, url: OLD }),
    probe: async () => DEAD,
    now: () => clock.now,
  })
  t.after(() => service.stop())
  // The pre-3.1.3 row has no `written` snapshot, so it is not ownership. The
  // legacy loopback path must still treat the dead entry as an orphan.
  assert.equal((await service.run('boot')).phase, 'suspect')
  clock.now += 20_000
  assert.equal((await service.run('timer')).status, 'revoked')
  assert.deepEqual(lane.config.providers, {})
})

test('A5: a dead non-loopback lane is left alone (documented limit of the orphan rule)', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lan = 'http://192.168.1.50:7897'
  const lane = fakeLane({ [HTTPS]: { proxy: lan } })
  const { service } = await makeSupervisor(t, dir, lane, {
    clock, proxyUrl: ALT, probeMap: [[lan, DEAD]],
  })
  const first = await service.run('boot')
  clock.now += 20_000
  const second = await service.run('timer')
  assert.equal(lane.puts.length, 0, 'a foreign LAN proxy is not ours to delete')
  assert.deepEqual(lane.config.providers[HTTPS], { proxy: lan })
  assert.equal(first.phase, 'foreign')
  assert.equal(second.phase, 'foreign')
})

test('A6: a proxy that accepts TCP but never answers is eventually treated as dead', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  const { service, responses } = await makeSupervisor(t, dir, lane, { clock, proxyUrl: OLD })
  await service.run('boot')
  responses.set(OLD, HUNG)
  clock.now += 20_000
  assert.equal((await service.run('timer')).phase, 'suspect')
  clock.now += 20_000
  assert.equal((await service.run('timer')).status, 'revoked')
  assert.deepEqual(lane.config.providers, {})
})

test('A7: a profile with no system proxy never removes a peer-owned healthy entry', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  const desktop = await makeSupervisor(t, dir, lane, { clock, profile: 'desktop', proxyUrl: OLD })
  await desktop.service.run('boot')
  assert.equal(lane.puts.length, 1)

  const tunneled = await makeSupervisor(t, dir, lane, { clock, profile: 'web', proxyUrl: undefined })
  const webRun = await tunneled.service.run('boot')
  assert.equal(lane.puts.length, 1, 'the TUN profile rewrote the lane')
  assert.deepEqual(lane.config.providers, { [HTTPS]: { proxy: OLD } })
  assert.notEqual(webRun.status, 'applied')
})

test('A8: a dead peer lane is not stolen by a second profile with a different live proxy', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  const desktop = await makeSupervisor(t, dir, lane, { clock, profile: 'desktop', proxyUrl: OLD })
  await desktop.service.run('boot')

  const web = await makeSupervisor(t, dir, lane, { clock, profile: 'web', proxyUrl: ALT })
  await web.service.run('boot')
  assert.equal(lane.puts.length, 1, 'the second profile rewrote a lane it does not own')
  assert.deepEqual(lane.config.providers, { [HTTPS]: { proxy: OLD } })
})

test('A9: a credentialed proxy URL is probed with Proxy-Authorization, not silently bypassed', async (t) => {
  const seen = []
  const server = createProxyServer((socket) => socket.once('data', (chunk) => {
    seen.push(chunk.toString())
    socket.end('HTTP/1.1 200 OK\r\n\r\n')
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://user:p%40ss@127.0.0.1:${server.address().port}`
  const result = await probeProxy(url, { cacheBust: true })
  assert.equal(result.reason, 'ok')
  assert.match(seen[0], /proxy-authorization: basic/i, 'no credentials were offered')
  const offered = /proxy-authorization: basic (\S+)/i.exec(seen[0])
  assert.equal(offered[1], Buffer.from('user:p@ss').toString('base64'))
})

test('A10: the panel-facing written rows keep the key the panel matches on', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  const { service, store } = await makeSupervisor(t, dir, lane, { clock, proxyUrl: OLD })
  await service.run('boot')
  const written = store.data.bili.written
  assert.ok(Array.isArray(written) && written.length === 1)
  assert.equal(written[0].key, HTTPS)
  assert.deepEqual(written[0].written, { proxy: OLD })
})

test('A11: the supervisor rollback switch stops background writes but keeps manual ones gated', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane({ [HTTPS]: { proxy: OLD } })
  const { service } = await makeSupervisor(t, dir, lane, {
    clock, proxyUrl: ALT, rollback: true,
  })
  const booted = await service.run('boot')
  clock.now += 20_000
  const ticked = await service.run('timer')
  assert.equal(lane.puts.length, 0, 'the rollback switch still wrote to bili')
  assert.ok(booted.status !== 'applied' && ticked.status !== 'applied')
})

test('A12: a bili control origin that is not loopback is refused rather than dialled', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  lane.locate = () => ({ origin: 'http://0.0.0.0:18787', pid: lane.pid, configPath: '/fake/bili.json' })
  const { service } = await makeSupervisor(t, dir, lane, { clock, proxyUrl: OLD })
  const result = await service.run('boot')
  assert.equal(lane.puts.length, 0)
  assert.equal(result.status, 'rejected')
  assert.match(String(result.error), /not local/)
})

test('A13: the shared lock leaves nothing behind, on success and on a thrown action', async (t) => {
  const dir = await temporary(t)
  const lock = join(dir, 'egress.lock')
  assert.equal(await withLock(lock, async () => 'ok'), 'ok')
  await assert.rejects(withLock(lock, async () => { throw new Error('boom') }), /boom/)
  const names = await readdir(dir)
  assert.deepEqual(names.filter((name) => name.includes('lock')), [])
  assert.equal(await withLock(lock, async () => 'again'), 'again')
})

test('A14: a dead lane for a host DSH does not manage is left alone (scope of cleanup)', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const openai = 'https://api.openai.com'
  const lane = fakeLane({ [openai]: { proxy: OLD } })
  const { service } = await makeSupervisor(t, dir, lane, { clock, proxyUrl: ALT })
  await service.run('boot')
  clock.now += 20_000
  await service.run('timer')
  assert.deepEqual(lane.config.providers[openai], { proxy: OLD }, 'cleaned a host this profile does not declare')
  for (const table of lane.puts) {
    assert.deepEqual(table[openai], { proxy: OLD }, 'dropped an entry it does not manage')
  }
})

test('A15: switching the lane off removes the entry this profile wrote', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  const { service, store } = await makeSupervisor(t, dir, lane, { clock, proxyUrl: OLD })
  await service.run('boot')
  assert.deepEqual(lane.config.providers, { [HTTPS]: { proxy: OLD } })

  store.data.bili.enabled = false
  const off = await service.run('settings')
  assert.deepEqual(lane.config.providers, {}, 'the lane survived being switched off')
  // The removal itself is reported as 'revoked'; the next pass reports 'disabled'.
  assert.ok(off.status === 'revoked' || off.status === 'disabled')
  assert.deepEqual(store.data.bili.written, [])
})

test('A16: a manual revoke sticks through the next timer tick instead of immediately reapplying', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  const { service } = await makeSupervisor(t, dir, lane, { clock, proxyUrl: OLD })
  await service.run('boot')
  assert.equal(lane.puts.length, 1)

  const revoked = await service.run('revoke')
  assert.deepEqual(lane.config.providers, {}, 'revoke did not remove the lane')
  assert.equal(revoked.status, 'revoked')
  const afterRevoke = lane.puts.length

  clock.now += 20_000
  const ticked = await service.run('timer')
  assert.equal(lane.puts.length, afterRevoke, 'the timer put the revoked lane straight back')
  assert.deepEqual(lane.config.providers, {})
  assert.equal(ticked.status, 'revoked')
})

test('A17: the lane is never created for a proxy that scutil advertises but that cannot be reached', async (t) => {
  const dir = await temporary(t)
  const clock = { now: 1_000_000 }
  const lane = fakeLane()
  const { service, store } = await makeSupervisor(t, dir, lane, {
    clock, proxyUrl: OLD, probeMap: [[OLD, DEAD]],
  })
  const booted = await service.run('boot')
  clock.now += 20_000
  const ticked = await service.run('timer')
  assert.equal(lane.puts.length, 0, 'a dead system proxy was written into the lane')
  assert.deepEqual(lane.config.providers, {})
  assert.equal(booted.status, 'error')
  assert.equal(booted.phase, 'degraded')
  assert.equal(ticked.status, 'error')
  assert.deepEqual(store.data.bili.written, [])
})
