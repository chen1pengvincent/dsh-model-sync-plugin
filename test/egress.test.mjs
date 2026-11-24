import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createProxy } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { backupConfig, getConfig, putProviders } from '../lib/bili.js'
import { parseScutilProxy } from '../lib/proxy.js'
import { parseProxy } from '../lib/http.js'
import { Store } from '../lib/state.js'
import { gatewayExit } from '../lib/egress/gateway.js'
import { withLock } from '../lib/egress/lock.js'
import { probeForeignProxy, probeProxy, proxyDisplay } from '../lib/egress/probe.js'
import { decide } from '../lib/egress/decide.js'
import { EgressSupervisor } from '../lib/egress/supervise.js'

const GOOGLE = 'generativelanguage.googleapis.com'
const HTTPS = `https://${GOOGLE}`
const MITM = `mitm://${GOOGLE}`
const OTHER = 'https://unrelated.example'
const OLD = 'http://127.0.0.1:7897'
const NEW = 'http://127.0.0.1:7890'
const AUTH = { ok: false, reachable: true, reason: 'auth' }
const BLOCKED = { ok: false, reachable: true, reason: 'blocked' }
const ALIVE = { ok: true, reachable: true, reason: 'ok' }
const DEAD = { ok: false, reachable: false, reason: 'refused' }

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-egress-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function laneFixture(providers = {}) {
  const lane = {
    origin: 'http://127.0.0.1:18787',
    config: { providers: structuredClone(providers), compress: { keep: true } },
    puts: [],
    backups: [],
    locate() { return { origin: lane.origin, pid: 1, configPath: '/fake/bili.json' } },
    async getConfig() { return { status: 200, text: JSON.stringify(lane.config) } },
    async backup(dir, config) {
      lane.backups.push(structuredClone(config))
      return backupConfig(dir, config)
    },
    async putProviders(_origin, table) {
      lane.puts.push(table)
      lane.config.providers = structuredClone(table)
      return { status: 200 }
    },
  }
  return lane
}

async function supervisorFixture(t, lane = laneFixture()) {
  const root = await temporary(t)
  const shared = join(root, 'shared')
  const time = { now: 1_000_000 }
  const profile = async (id, options = {}) => {
    const store = new Store(join(root, id))
    await store.load()
    const proxy = { url: Object.hasOwn(options, 'url') ? options.url : OLD }
    const observations = []
    const responses = new Map([[OLD, ALIVE], [NEW, ALIVE]])
    const service = new EgressSupervisor({
      dir: shared, profile: id, bili: lane, store,
      proxy: async () => ({ available: proxy.url !== undefined, url: proxy.url }),
      hosts: async () => options.hosts ?? [GOOGLE],
      now: () => time.now,
      foreignProbe: options.foreignProbe,
      probe: options.probe ?? (async (url, { cacheBust }) => {
        assert.equal(cacheBust, true)
        observations.push(url)
        return responses.get(url) ?? DEAD
      }),
    })
    t.after(() => service.stop())
    return { service, store, proxy, responses, observations }
  }
  const journal = async () => JSON.parse(await readFile(join(shared, 'egress.json'), 'utf8')).lanes['lane:/fake/bili.json']
  return { lane, time, profile, journal }
}

test('CONNECT classifies actual replies and never dials the target for an unsupported proxy', async (t) => {
  let status = 200
  const seen = []
  const server = createProxy((socket) => socket.once('data', (chunk) => {
    seen.push(chunk.toString())
    if (status !== undefined) socket.write(`HTTP/1.1 ${status} test\r\n`)
    if (status !== undefined) socket.write('X-Test: yes\r\n\r\n')
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}`
  assert.equal((await probeProxy(url)).reason, 'ok')
  assert.match(seen[0], /^CONNECT generativelanguage\.googleapis\.com:443 HTTP\/1\.1/)
  status = 407
  assert.equal((await probeProxy(url)).reason, 'ok')
  assert.equal((await probeProxy(url, { cacheBust: true })).reason, 'auth')
  status = 502
  assert.equal((await probeProxy(url, { cacheBust: true })).reason, 'blocked')
  status = undefined
  assert.equal((await probeProxy(url, { cacheBust: true, timeoutMs: 30 })).reason, 'timeout')

  let targetConnections = 0
  server.on('connection', () => { targetConnections += 1 })
  for (const invalid of [`socks5://127.0.0.1:${port}`, 'http://[bad']) {
    const invalidProbe = await probeProxy(invalid, { targetHost: '127.0.0.1', targetPort: port, cacheBust: true })
    assert.equal(invalidProbe.reason, 'invalid')
  }
  assert.equal(targetConnections, 0)
})

test('system IPv6 literals produce a usable proxy authority', () => {
  const url = parseScutilProxy('HTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 7897')
  assert.equal(url, 'http://[::1]:7897')
  assert.equal(parseProxy(url).host, '::1')
})

test('unowned stale HTTPS and MITM declarations heal even without a current system proxy', async (t) => {
  const lane = laneFixture({ [HTTPS]: { proxy: `${OLD}/` }, [MITM]: { proxy: OLD },
    [OTHER]: { models: { custom: true }, proxy: OLD } })
  const { profile, journal, time } = await supervisorFixture(t, lane)
  const { service, responses, observations } = await profile('desktop', { url: undefined })
  responses.set(OLD, DEAD)
  responses.set(`${OLD}/`, DEAD)
  assert.equal((await service.run('boot')).phase, 'suspect')
  assert.equal((await journal()).failures[HTTPS].since, time.now)
  time.now += 5_000
  assert.equal((await service.run('timer')).phase, 'suspect')
  assert.equal(lane.puts.length, 0)
  time.now += 6_000
  assert.equal((await service.run('timer')).status, 'revoked')
  assert.deepEqual(lane.config.providers, { [OTHER]: { models: { custom: true }, proxy: OLD } })
  assert.deepEqual(lane.backups[0].providers[MITM], { proxy: OLD })
  assert.equal(lane.config.compress.keep, true)
  assert.equal(observations.length, 6)
})

test('managed lane degrades after spaced failures and recovers on the next healthy tick', async (t) => {
  const { lane, profile, time } = await supervisorFixture(t)
  lane.config.upstreamProxy = 'http://fallback.example:8080'
  lane.config.upstreamProxyMode = 'manual'
  const { service, responses } = await profile('desktop')
  const initial = await service.run('boot')
  assert.equal(initial.status, 'applied')
  assert.equal(initial.fallback, 'lane')
  assert.ok(await readFile(initial.snapshot, 'utf8'))
  responses.set(OLD, DEAD)
  time.now += 20_000
  assert.equal((await service.run('timer')).phase, 'suspect')
  time.now += 20_000
  const down = await service.run('timer')
  assert.equal(down.status, 'revoked')
  assert.equal(down.fallback, 'global-proxy')
  assert.equal(lane.config.providers[HTTPS], undefined)
  responses.set(OLD, ALIVE)
  time.now += 20_000
  assert.equal((await service.run('timer')).status, 'applied')
  assert.deepEqual(lane.config.providers[HTTPS], { proxy: OLD })
})

test('a different healthy system port never condemns a foreign current entry', async (t) => {
  const lane = laneFixture({ [HTTPS]: { proxy: OLD }, [MITM]: { proxy: OLD, models: { pinned: true } } })
  const { profile, time } = await supervisorFixture(t, lane)
  const { service, responses } = await profile('desktop', { url: NEW })
  assert.equal((await service.run('boot')).phase, 'foreign')
  assert.equal(lane.puts.length, 0)
  responses.set(OLD, DEAD)
  await service.run('timer')
  time.now += 20_000
  await service.run('timer')
  assert.deepEqual(lane.config.providers[HTTPS], { proxy: NEW })
  assert.deepEqual(lane.config.providers[MITM], { proxy: OLD, models: { pinned: true } })
})

test('foreign diagnostic warnings are read-only and scoped to configured hosts', () => {
  const proxy = 'https://proxy.example:8443'
  const providers = {
    [HTTPS]: { proxy, models: { keep: true } },
    [MITM]: { proxy: OLD },
    'https://api.openai.com': { proxy },
  }
  const input = {
    now: 1_000_000, profile: 'desktop', hosts: [GOOGLE], enabled: true,
    lane: { entries: {}, claims: {}, failures: {}, suppressed: {} },
    providers, managedHosts: [GOOGLE, 'api.openai.com'], useLegacy: true, probes: new Map(),
    diagnostics: new Map(Object.keys(providers).map((key) => [key, DEAD])),
  }
  const plan = decide(input)
  assert.deepEqual(plan.warnings, [{ key: HTTPS, host: GOOGLE, proxy, reason: 'refused' }])
  assert.deepEqual(plan.changes, [])
  assert.deepEqual(plan.entries, input.lane.entries)
  assert.deepEqual(decide({ ...input, diagnostics: new Map([[HTTPS, ALIVE]]) }).warnings, [])
  assert.deepEqual(decide({ ...input, enabled: false }).warnings, [])
  assert.deepEqual(decide({ ...input, manualRevoke: true }).warnings, [])
})

test('foreign warning persists without credentials, clears on recovery or removal, and makes no PUT', async (t) => {
  const proxy = 'http://fixture-user:fixture-password@proxy.example:7897'
  const outside = 'http://proxy-outside.example:7897'
  const lane = laneFixture({ [HTTPS]: { proxy, models: { keep: true } }, 'https://api.openai.com': { proxy: outside } })
  const original = structuredClone(lane.config.providers)
  const { profile } = await supervisorFixture(t, lane)
  const calls = []
  let result = { ok: false, reachable: false, reason: 'error' }
  const { service, store } = await profile('desktop', {
    url: undefined,
    foreignProbe: async (url, options) => { calls.push({ url, options }); return result },
  })
  const observed = await service.run('boot')
  assert.equal(observed.status, 'no-proxy')
  assert.match(observed.warning, /未改动.*proxy\.example:7897.*代理连接异常/)
  assert.doesNotMatch(observed.warning, /fixture-user|fixture-password/)
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).bili.warning, observed.warning)
  assert.deepEqual(calls, [{ url: proxy, options: { cacheBust: true, targetHost: GOOGLE } }])
  assert.deepEqual(lane.config.providers, original)
  assert.equal(lane.puts.length, 0)

  result = AUTH
  assert.equal((await service.run('timer')).warning, undefined)
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).bili.warning, undefined)
  result = DEAD
  assert.ok((await service.run('timer')).warning)
  delete lane.config.providers[HTTPS]
  assert.equal((await service.run('timer')).warning, undefined)
  assert.equal(lane.puts.length, 0)
})

test('foreign CONNECT uses the actual upstream target and never transmits the configured password', async (t) => {
  let received = ''
  const server = createProxy((socket) => socket.once('data', (chunk) => {
    received = chunk.toString()
    socket.end('HTTP/1.1 407 Authentication required\r\n\r\n')
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const proxy = `http://fixture:fixture-password@127.0.0.1:${port}`
  try {
    const actual = await probeForeignProxy(proxy, { targetHost: 'api.openai.com' })
    assert.equal(actual.reason, 'auth')
    assert.equal(actual.reachable, true)
    assert.match(received, /^CONNECT api\.openai\.com:443 HTTP\/1\.1/)
    assert.doesNotMatch(received, /Proxy-Authorization|fixture/)
    assert.equal(proxyDisplay(proxy), `http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  const https = `https://127.0.0.1:${port}`
  assert.equal((await probeForeignProxy(https, { targetHost: 'api.openai.com' })).reason, 'refused')
  assert.equal((await probeProxy(https)).reason, 'invalid', 'the existing write gate is still HTTP-only')
})

test('407, 502 and externally changed entries remain in place', async (t) => {
  const { lane, profile, time } = await supervisorFixture(t)
  const { service, responses } = await profile('desktop')
  await service.run('boot')
  for (const result of [DEAD, AUTH, DEAD, BLOCKED, DEAD]) {
    responses.set(OLD, result)
    time.now += 20_000
    await service.run('timer')
  }
  assert.equal(lane.puts.length, 1)
  lane.config.providers[HTTPS] = { proxy: OLD, models: { pinned: true } }
  time.now += 20_000
  await service.run('timer')
  assert.equal((await service.run('revoke')).status, 'nothing-to-revoke')
  assert.equal(lane.puts.length, 1)
  assert.deepEqual(lane.config.providers[HTTPS].models, { pinned: true })
})

test('migration restores a reachable previous entry and removes only a dead proxy field', async (t) => {
  const openai = 'https://api.openai.com'
  const lane = laneFixture({ [HTTPS]: { proxy: NEW }, [MITM]: { proxy: NEW }, [openai]: { proxy: NEW } })
  const { profile } = await supervisorFixture(t, lane)
  const { service, store, responses } = await profile('desktop')
  store.data.bili.written = [
    { key: HTTPS, created: false, written: { proxy: NEW }, previous: { proxy: OLD } },
    { key: MITM, created: false, written: { proxy: NEW }, previous: { proxy: 'http://127.0.0.1:7', models: { keep: true } } },
    { key: openai, created: false, written: { proxy: NEW }, previous: { proxy: 'http://127.0.0.1:8' } },
  ]
  responses.set(OLD, AUTH)
  responses.set('http://127.0.0.1:8', { ok: false, reachable: true, reason: 'error' })
  assert.equal((await service.run('revoke')).status, 'revoked')
  assert.deepEqual(lane.config.providers, { [HTTPS]: { proxy: OLD }, [MITM]: { models: { keep: true } } })
})

test('desktop and web serialize writes, transfer claims on disable and respect manual revoke', async (t) => {
  const { lane, profile, time } = await supervisorFixture(t)
  const desktop = await profile('desktop')
  const web = await profile('web')
  await Promise.all([desktop.service.run('boot'), web.service.run('boot')])
  assert.equal(lane.puts.length, 1)
  const [owner, peer] = desktop.store.data.bili.written.length ? [desktop, web] : [web, desktop]
  owner.store.data.bili.enabled = false
  await owner.service.run('settings')
  assert.equal(lane.puts.length, 1)
  time.now += 20_000
  await peer.service.run('timer')
  assert.equal(peer.store.data.bili.written.length, 1)
  assert.equal((await peer.service.run('revoke')).status, 'revoked')
  owner.store.data.bili.enabled = true
  await owner.service.run('timer')
  await peer.service.run('timer')
  assert.deepEqual(lane.config.providers, {})
  assert.equal((await owner.service.run('manual')).status, 'applied')
})

test('an explicit revoke still reports revoked when the switch is already off', async (t) => {
  const { lane, profile } = await supervisorFixture(t)
  const { service, store } = await profile('desktop')
  await service.run('boot')
  store.data.bili.enabled = false
  const revoked = await service.run('revoke')
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.phase, 'revoked')
  assert.deepEqual(lane.config.providers, {})
})

test('paused background performs no lane operations while manual sync stays gated', async (t) => {
  const { lane, profile } = await supervisorFixture(t)
  const { service, store, responses, observations } = await profile('desktop')
  store.data.bili.supervisor = false
  lane.config.providers[HTTPS] = { proxy: OLD }
  responses.set(OLD, DEAD)
  await service.run('boot')
  await service.run('timer')
  assert.equal(observations.length, 0)
  assert.equal(lane.puts.length, 0)
  assert.equal((await service.run('manual')).phase, 'degraded')
  assert.equal(lane.puts.length, 0)
})

test('backup failure, a 409, and a same-key external edit never overwrite providers', async (t) => {
  const lane = laneFixture({ [OTHER]: { models: { v1: true } } })
  const { profile, journal } = await supervisorFixture(t, lane)
  const { service } = await profile('desktop')
  const backup = lane.backup
  lane.backup = async () => { throw new Error('backup unavailable') }
  assert.equal((await service.run('manual')).status, 'rejected')
  assert.equal(lane.puts.length, 0)

  lane.backup = async (...args) => {
    lane.config.providers[OTHER].models = { v2: true }
    return backup(...args)
  }
  assert.equal((await service.run('manual')).phase, 'conflict')
  assert.equal(lane.puts.length, 0)
  assert.equal((await journal()).pending, undefined)

  lane.backup = backup
  lane.putProviders = async () => { lane.puts.push('rejected'); return { status: 409 } }
  assert.equal((await service.run('manual')).status, 'rejected')
  assert.equal(lane.puts.length, 1)
  const state = await journal()
  assert.equal(state.pending, undefined)
  assert.deepEqual(state.entries, {})
})

test('a dropped PUT response is reconciled from the real table before the next action', async (t) => {
  const { lane, profile, journal } = await supervisorFixture(t)
  const { service, store } = await profile('desktop')
  const put = lane.putProviders
  lane.putProviders = async (...args) => {
    await put(...args)
    throw new Error('reply lost')
  }
  assert.equal((await service.run('manual')).status, 'rejected')
  assert.equal((await journal()).pending.length, 1)
  lane.putProviders = put
  await service.run('timer')
  assert.equal(lane.puts.length, 1)
  assert.equal(store.data.bili.written.length, 1)
  assert.equal((await journal()).pending, undefined)
})

test('a 500 after a successful file write does not lose ownership or present it as verified', async (t) => {
  const { lane, profile, journal } = await supervisorFixture(t)
  const { service, store } = await profile('desktop')
  const put = lane.putProviders
  lane.putProviders = async (...args) => {
    await put(...args)
    return { status: 500 }
  }
  assert.equal((await service.run('manual')).status, 'applied-unverified')
  assert.equal((await journal()).pending.length, 1)
  lane.putProviders = put
  assert.equal((await service.run('timer')).status, 'applied-unverified')
  assert.equal(store.data.bili.written.length, 1)
  assert.equal((await journal()).pending, undefined)
  assert.equal(lane.puts.length, 1)
})

test('whole-table readback detects a change to an unrelated value after PUT', async (t) => {
  const lane = laneFixture({ [OTHER]: { note: 'original' } })
  const { profile } = await supervisorFixture(t, lane)
  const { service, store } = await profile('desktop')
  const write = lane.putProviders
  lane.putProviders = async (...args) => {
    const reply = await write(...args)
    lane.config.providers[OTHER] = { note: 'changed' }
    return reply
  }
  assert.equal((await service.run('manual')).status, 'applied-unverified')
  assert.equal(store.data.bili.written.length, 1)
  assert.deepEqual(lane.config.providers[OTHER], { note: 'changed' })
  assert.equal(lane.puts.length, 1)
})

test('gateway drops refused exits and retains authentication, target blocking, and explicit unsupported proxies', async () => {
  const proxy = { available: true, url: OLD }
  assert.equal((await gatewayExit(proxy, async () => DEAD, true)).available, false)
  for (const outcome of [ALIVE, AUTH, BLOCKED, { reason: 'invalid', reachable: false }]) {
    assert.equal((await gatewayExit(proxy, async () => outcome, true)).url, OLD)
  }
  assert.equal(await gatewayExit(proxy, async () => assert.fail('paused'), false), proxy)
})

test('real child-process lock ownership survives contention and a dead process can be reaped', async (t) => {
  const dir = await temporary(t)
  const lock = join(dir, 'egress.lock')
  const module = new URL('../lib/egress/lock.js', import.meta.url).href
  const script = `import { withLock } from ${JSON.stringify(module)}
    await withLock(process.argv[1], async () => {
      console.log('entered')
      await new Promise((resolve) => process.stdin.once('end', resolve).resume())
    }, 500)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  const [line] = await once(child.stdout, 'data')
  assert.match(line.toString(), /entered/)
  const contender = `import { withLock } from ${JSON.stringify(module)}
    try { await withLock(process.argv[1], () => console.log('entered'), 200) }
    catch (error) { console.log(error.code) }`
  const out = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', contender, lock])
  assert.equal(out.stdout.trim(), 'LOCK_TIMEOUT')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  await assert.rejects(withLock(lock, async () => { throw new Error('failed action') }), /failed action/)
  assert.equal(await withLock(lock, async () => 'released'), 'released')
})

test('real loopback HTTP contract, boot lifecycle, and restored port without touching host settings', async (t) => {
  let actualProviders = {}
  const sent = []
  const server = createHttpServer(async (request, response) => {
    if (request.url !== '/__bili/config') return response.writeHead(404).end()
    if (request.method === 'PUT') {
      let body = ''
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body)
      sent.push(payload)
      actualProviders = payload.providers
      return response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    }
    const raw = JSON.stringify({ providers: actualProviders, keep: true })
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ path: '/fake/bili.json', providers: actualProviders, raw, upstreamProxyMode: 'direct' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const proxyServer = createProxy((socket) => socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\n\r\n')))
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
  const port = proxyServer.address().port
  const proxyUrl = `http://127.0.0.1:${port}`
  t.after(() => { if (proxyServer.listening) proxyServer.close() })

  const origin = `http://127.0.0.1:${server.address().port}`
  const lane = { locate: () => ({ origin }), getConfig, putProviders, backup: backupConfig }
  const { profile, time } = await supervisorFixture(t, lane)
  const desktop = await profile('desktop', { url: proxyUrl, probe: probeProxy })
  await desktop.service.run('boot')
  assert.deepEqual(sent[0], { providers: { [HTTPS]: { proxy: proxyUrl } } })
  await new Promise((resolve) => proxyServer.close(resolve))
  time.now += 20_000
  await desktop.service.run('timer')
  time.now += 20_000
  assert.equal((await desktop.service.run('timer')).fallback, 'direct')
  assert.deepEqual(actualProviders, {})

  await new Promise((resolve) => proxyServer.listen(port, '127.0.0.1', resolve))
  time.now += 20_000
  await desktop.service.run('timer')
  assert.deepEqual(actualProviders, { [HTTPS]: { proxy: proxyUrl } })
  await desktop.service.stop()
  assert.equal((await desktop.service.run('timer')).status, 'disposed')
})

test('foreground waits behind reconciliation and periodic ticks skip overlapping work', async (t) => {
  const { profile, lane } = await supervisorFixture(t)
  let release
  let reached
  const observing = new Promise((resolve) => { reached = resolve })
  const pending = new Promise((resolve) => { release = resolve })
  const { service } = await profile('desktop', { probe: async () => { reached(); await pending; return ALIVE } })
  const boot = service.run('boot')
  await observing
  assert.equal((await service.run('timer')).status, 'busy')
  const manual = service.run('revoke')
  release()
  await boot
  assert.equal((await manual).status, 'revoked')
  assert.deepEqual(lane.config.providers, {})
})

test('start arms both timers once and stop disarms them before they can run', async (t) => {
  const { profile, lane } = await supervisorFixture(t)
  const { service } = await profile('desktop')
  const calls = []
  const timeouts = []
  const intervals = []
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    const timer = { fn, delay, unref() { this.referenced = false } }
    timeouts.push(timer)
    return timer
  })
  t.mock.method(globalThis, 'setInterval', (fn, delay) => {
    const timer = { fn, delay, unref() { this.referenced = false } }
    intervals.push(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => calls.push(timer))
  t.mock.method(globalThis, 'clearInterval', (timer) => calls.push(timer))
  service.start()
  service.start()
  assert.deepEqual(timeouts.map(({ delay, referenced }) => [delay, referenced]), [[5_000, false]])
  assert.deepEqual(intervals.map(({ delay, referenced }) => [delay, referenced]), [[20_000, false]])
  await service.stop()
  assert.deepEqual(calls, [timeouts[0], intervals[0]])
  assert.equal(lane.puts.length, 0)
})
