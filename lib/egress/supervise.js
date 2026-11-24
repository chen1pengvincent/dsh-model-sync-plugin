import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'

import { DEFAULT_PROXY_HOSTS } from '../bili.js'
import { writeJsonAtomic } from '../state.js'
import { decide, entryProxy, foreignProxy, legacyLoopback, providerHost } from './decide.js'
import { execute, readLane, settlePending } from './execute.js'
import { withLock } from './lock.js'
import { probeForeignProxy, probeProxy, proxyDisplay } from './probe.js'

const FIRST_TICK_MS = 5_000
const TICK_MS = 20_000
const CLAIM_TTL_MS = 60_000

async function readJournal(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (value?.version !== 1 || !value.lanes || typeof value.lanes !== 'object' || Array.isArray(value.lanes)) {
      throw new Error('unrecognized journal')
    }
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, lanes: {} }
    throw new Error('model-sync egress journal could not be read', { cause: error })
  }
}

/** Expose the configured fallback only. Bili's process can also supply env rules. */
function fallback(config, providers, hosts) {
  if (Object.entries(providers).some(([key, entry]) => hosts.includes(providerHost(key.trim())) && entryProxy(entry))) return 'lane'
  if (config.upstreamProxyMode === 'direct') return 'direct'
  if (typeof config.upstreamProxy === 'string' && config.upstreamProxy.trim() !== '') return 'global-proxy'
  return 'unknown'
}

function claimActive(claim, now) {
  if (now - claim.at >= CLAIM_TTL_MS || now < claim.at || !Number.isInteger(claim.pid) || claim.pid <= 0) return false
  try {
    process.kill(claim.pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

const DIAGNOSTIC_REASON = {
  refused: '连接被拒绝',
  timeout: '连接超时',
  dns: '代理域名解析失败',
  invalid: '代理地址无效',
  error: '代理连接异常',
}

function warningText(warnings) {
  const first = warnings[0]
  if (first === undefined) return undefined
  const endpoint = proxyDisplay(first.proxy)
  const reason = DIAGNOSTIC_REASON[first.reason] ?? '代理探测失败'
  return `bili 有 ${warnings.length} 条现有代理声明未通过探测，这些声明未改动。${first.host}${endpoint ? ` → ${endpoint}` : ''}（${reason}）`
}

export class EgressSupervisor {
  constructor({ dir, profile, store, bili, hosts, proxy, logger, probe = probeProxy,
    foreignProbe = probe === probeProxy ? probeForeignProxy : probe, now = Date.now }) {
    Object.assign(this, { dir, profile, store, bili, hosts, proxy, logger, probe, foreignProbe, now })
    this.file = join(dir, 'egress.json')
    this.lock = join(dir, 'egress.lock')
  }

  start() {
    if (this.bootTimer !== undefined || this.stopped) return
    this.bootTimer = setTimeout(() => { void this.run('boot') }, FIRST_TICK_MS)
    this.timer = setInterval(() => { void this.run('timer') }, TICK_MS)
    this.bootTimer.unref()
    this.timer.unref()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.bootTimer)
    clearInterval(this.timer)
    return this.running
  }

  run(trigger, reason = trigger) {
    if (this.stopped) return Promise.resolve({ status: 'disposed' })
    if (trigger === 'timer' && this.running !== undefined) return Promise.resolve({ status: 'busy' })
    const next = (this.running ?? Promise.resolve()).then(() => this.reconcile(trigger, reason)).catch((error) => {
      if (error.code === 'LOCK_TIMEOUT') return { status: 'busy' }
      return this.record({ status: 'rejected', phase: 'error', warning: undefined }, reason, error.message)
        .catch(() => ({ status: 'error' }))
    }).finally(() => {
      if (this.running === next) this.running = undefined
    })
    this.running = next
    return next
  }

  async record(result, reason, error = result.error) {
    const saved = this.store.data.bili
    const { status, phase = status, ...details } = result
    const at = this.now()
    const changed = saved.status !== status || saved.phase !== phase || saved.error !== error
      || Object.entries(details).some(([key, value]) => !equal(saved[key], value))
    // Keep the same panel statuses. Internal health is available on disk.
    Object.assign(saved, details, { status, phase, error, reason })
    if (changed || result.snapshot !== undefined) {
      saved.at = at
      await this.store.save()
    }
    if (changed) this.logger?.info?.(`[egress] ${reason}: ${phase}`)
    return { ...details, status, phase, error, reason, at }
  }

  async reconcile(trigger, reason) {
    if (this.stopped) return { status: 'disposed' }
    const background = trigger === 'timer' || trigger === 'boot'
    const manualRevoke = trigger === 'revoke'
    const setting = this.store.data.bili
    if (setting.supervisor === false && background) return { status: setting.status }

    const where = this.bili.locate()
    if (where === undefined) {
      if (manualRevoke) return { status: 'nothing-to-revoke' }
      if (setting.enabled === false) return this.record({ status: 'disabled', warning: undefined }, reason)
      const proxy = await this.proxy({ fresh: true })
      return this.record({ status: proxy.available ? 'no-bili' : 'no-proxy', warning: undefined }, reason)
    }

    return withLock(this.lock, () => this.reconcileLane(where, { trigger, reason, background, manualRevoke }))
  }

  async reconcileLane(where, { trigger, reason, background, manualRevoke }) {
    if (this.stopped) return { status: 'disposed' }
    const saved = this.store.data.bili
    const enabled = saved.enabled !== false
    if (saved.supervisor === false && background) return { status: saved.status }
    const before = await readLane(this.bili, where)
    const { config, providers } = before
    const { lane, save } = await this.openJournal(before, where, saved)
    const useLegacy = saved.supervisor !== false

    const hosts = await this.hosts()
    const proxy = enabled && !manualRevoke ? await this.proxy({ fresh: true }) : undefined
    const desired = proxy?.available ? proxy.url : undefined
    const now = this.now()
    for (const [id, claim] of Object.entries(lane.claims)) {
      if (!claimActive(claim, now)) delete lane.claims[id]
    }
    // Preserve the duration of the existing manual action: the next user
    // sync, settings activation or restart can resume it.
    if (enabled && !manualRevoke && trigger !== 'timer') {
      for (const host of hosts) {
        if (trigger === 'manual' || lane.suppressed[host] === this.profile) delete lane.suppressed[host]
      }
    }
    if (manualRevoke) {
      for (const [key, entry] of Object.entries(lane.entries)) {
        if (entry.owner !== this.profile || !equal(providers[key], entry.written)) continue
        lane.suppressed[providerHost(key.trim())] = this.profile
      }
    }

    const { probes, diagnostics } = await this.observe({ desired, hosts, providers, lane, enabled, manualRevoke, useLegacy })
    if (this.stopped) return { status: 'disposed' }
    if (saved !== this.store.data.bili) return { status: 'busy' }

    if (desired !== undefined && probes.get(desired)?.ok === true) {
      lane.claims[this.profile] = { pid: process.pid, at: now, proxy: desired, hosts: hosts.filter((host) => lane.suppressed[host] === undefined) }
    } else delete lane.claims[this.profile]

    // Drop evidence for removed/replaced keys before making a new decision.
    for (const [key, observation] of Object.entries(lane.failures)) {
      if (!equal(providers[key], observation.value)) delete lane.failures[key]
    }
    const plan = decide({ now, profile: this.profile, hosts, desired, enabled, manualRevoke,
      lane, providers, probes, diagnostics, managedHosts: DEFAULT_PROXY_HOSTS, useLegacy })
    lane.entries = plan.entries
    // A disabled/manual pass doesn't supply negative or positive health
    // evidence for another profile's entries.
    if (enabled && !manualRevoke) {
      for (const [key, value] of Object.entries(providers)) {
        if (probes.has(entryProxy(value))) delete lane.failures[key]
      }
      Object.assign(lane.failures, plan.failures)
    }

    const status = manualRevoke ? 'nothing-to-revoke'
      : !enabled ? 'disabled'
        : desired === undefined ? 'no-proxy'
          : hosts.length === 0 ? 'no-hosts'
            : hosts.every((host) => lane.suppressed[host] !== undefined) ? 'revoked'
              : 'unchanged'
    const health = probes.get(desired)
    const phase = plan.phase === 'suspect' ? 'suspect'
      : health?.ok === false ? 'degraded' : plan.phase === 'foreign' ? 'foreign' : status
    let result = { status, phase }
    const changes = plan.changes.filter(({ key, before, after }) => {
      if (!equal(before, after)) return true
      delete lane.entries[key]
      return false
    })
    if (changes.length !== 0) {
      result = await execute({ bili: this.bili, where, before, lane, changes,
        dir: this.store.dir, save, stopped: () => this.stopped || saved !== this.store.data.bili })
    } else {
      await save()
      if (plan.changes.length > 0) result = { status: 'revoked', phase: 'revoked' }
    }
    const { observed = providers, ...summary } = result
    const written = Object.values(lane.entries)
      .filter(({ key, owner, written }) => owner === this.profile && equal(observed[key], written))
      .map(({ owner: _owner, ...row }) => row)
    let shown = result.status
    if (!enabled && !manualRevoke && shown === 'revoked') shown = 'disabled'
    else if (shown === 'unchanged' && health?.ok === false) shown = 'error'
    else if (trigger === 'timer' && shown === 'unchanged' && phase === 'unchanged'
      && ['applied', 'applied-unverified'].includes(saved.status)) shown = saved.status
    return this.record({ ...summary, status: shown, written, origin: where.origin,
      fallback: fallback(config, observed, hosts), probeReason: health?.reason,
      warning: warningText(plan.warnings),
      error: result.error ?? (shown === 'error' && health?.ok === false ? `system proxy: ${health.reason}` : undefined) }, reason)
  }

  async openJournal({ identity, providers }, where, saved) {
    const journal = await readJournal(this.file)
    let persisted = structuredClone(journal)
    const lane = journal.lanes[`lane:${identity}`] ??= { entries: {}, claims: {}, failures: {}, suppressed: {}, migrated: [] }
    const save = async () => {
      if (equal(persisted, journal)) return
      await writeJsonAtomic(this.file, journal)
      persisted = structuredClone(journal)
    }
    settlePending(lane, providers)
    if (!lane.migrated.includes(this.profile)) {
      if (saved.origin === undefined || saved.origin === where.origin) {
        for (const row of Array.isArray(saved.written) ? saved.written : []) {
          if (row?.written === undefined || typeof row.key !== 'string' || !DEFAULT_PROXY_HOSTS.includes(providerHost(row.key.trim()))) continue
          lane.entries[row.key] ??= { ...row, owner: this.profile }
        }
      }
      lane.migrated.push(this.profile)
    }
    return { lane, save }
  }

  async observe({ desired, hosts, providers, lane, enabled, manualRevoke, useLegacy }) {
    // Observe the requested proxy and each live declaration separately. A
    // healthy new port isn't evidence that an old foreign lane is healthy.
    const probes = new Map()
    const diagnostics = new Map()
    const foreign = new Map()
    const urls = new Set()
    if (desired !== undefined && hosts.some((host) => lane.suppressed[host] === undefined)) urls.add(desired)
    for (const [key, value] of Object.entries(providers)) {
      const host = providerHost(key.trim())
      if (!DEFAULT_PROXY_HOSTS.includes(host)) continue
      const record = lane.entries[key]
      const current = entryProxy(value)
      const owned = record !== undefined && equal(value, record.written)
      const orphan = record === undefined && hosts.includes(host) && useLegacy && legacyLoopback(value)
      if (current !== undefined && enabled && !manualRevoke && (owned || orphan)) urls.add(current)
      if (enabled && !manualRevoke && hosts.includes(host)) {
        const proxy = foreignProxy(value, record)
        if (proxy !== undefined) {
          const id = JSON.stringify([proxy, host])
          if (!foreign.has(id)) foreign.set(id, { proxy, host, keys: [] })
          foreign.get(id).keys.push(key)
        }
      }
      if (owned) {
        const previous = entryProxy(record.previous)
        if (previous !== undefined) urls.add(previous)
      }
    }
    await Promise.all([
      ...[...urls].map(async (url) => {
        probes.set(url, await this.probe(url, { cacheBust: true }))
      }),
      ...[...foreign.values()].map(async ({ proxy, host, keys }) => {
        const result = await this.foreignProbe(proxy, { cacheBust: true, targetHost: host })
        for (const key of keys) diagnostics.set(key, result)
      }),
    ])
    return { probes, diagnostics }
  }
}
