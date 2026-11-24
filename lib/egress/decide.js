import { isDeepStrictEqual as equal } from 'node:util'

const MIN_FAILURE_GAP_MS = 10_000

export function providerHost(key) {
  return /^(?:https|mitm):\/\/([a-z0-9.-]+)(?::443)?\/?$/i.exec(key)?.[1].toLowerCase()
}

export function entryProxy(entry) {
  return typeof entry?.proxy === 'string' && entry.proxy.trim() !== '' ? entry.proxy.trim() : undefined
}

export function sameProxy(left, right) {
  if (left === right) return true
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.href === b.href
  } catch {
    return false
  }
}

export function legacyLoopback(entry) {
  if (Object.keys(entry ?? {}).length !== 1 || entryProxy(entry) === undefined) return false
  try {
    const url = new URL(entry.proxy)
    return url.protocol === 'http:' && !url.username && !url.password
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function foreignProxy(entry, record) {
  if (record !== undefined && equal(entry, record.written)) return undefined
  if (legacyLoopback(entry)) return undefined
  return entryProxy(entry)
}

function previousValue(record, probes) {
  if (record.created || record.previous === undefined) return undefined
  const proxy = entryProxy(record.previous)
  const result = probes.get(proxy)
  if (proxy === undefined || (result?.reachable === true && result.reason !== 'error')) return record.previous
  const { proxy: _dead, ...remaining } = record.previous
  return Object.keys(remaining).length === 0 ? undefined : remaining
}

/** Reconcile exact keys independently, including HTTPS and MITM twins. */
export function decide({ now, profile, hosts, desired, enabled, manualRevoke, lane,
  providers, probes, diagnostics = new Map(), managedHosts, useLegacy }) {
  const changes = []
  const warnings = []
  const failures = {}
  const entries = { ...lane.entries }
  const allowed = new Set(managedHosts)
  const selected = new Set(hosts)
  const keys = new Set([...Object.keys(providers), ...Object.keys(lane.entries)])
  const desiredHealthy = probes.get(desired)?.ok === true
  const canWrite = enabled && !manualRevoke && desiredHealthy
  let phase = 'unchanged'

  for (const host of hosts) {
    const https = [...keys].some((key) => key.trim().toLowerCase().startsWith('https://')
      && providerHost(key.trim()) === host && Object.hasOwn(providers, key))
    if (!https) keys.add(`https://${host}`)
  }

  for (const key of keys) {
    const host = providerHost(key.trim())
    if (!allowed.has(host)) continue
    const value = providers[key]
    const record = lane.entries[key]
    const current = entryProxy(value)
    const own = record !== undefined && equal(value, record.written)
    const targeted = selected.has(host)
    const peer = Object.entries(lane.claims).find(([id, claim]) => id !== profile
      && claim.hosts.includes(host) && sameProxy(claim.proxy, current))?.[0]

    if (own && record.owner === profile && (manualRevoke || !enabled || desired === undefined || !targeted)) {
      if (!manualRevoke && peer !== undefined) {
        entries[key] = { ...record, owner: peer }
      } else {
        changes.push({ key, before: value, after: previousValue(record, probes) })
      }
      continue
    }

    if (enabled && !manualRevoke && targeted) {
      const proxy = foreignProxy(value, record)
      const probe = diagnostics.get(key)
      if (proxy !== undefined && probe?.reachable === false) warnings.push({ key, host, proxy, reason: probe.reason })
    }
    if (manualRevoke || !enabled || lane.suppressed[host] !== undefined) continue
    if (!targeted && !own) continue

    if (own && targeted && canWrite && !sameProxy(current, desired)) {
      if (peer === undefined) {
        const after = { ...value, proxy: desired }
        changes.push({ key, before: value, after, record: { ...record, written: after } })
      }
      continue
    }

    // Preserve changed or explicit foreign declarations. Legacy recovery is
    // limited to bare loopback entries with no ownership record.
    const orphan = useLegacy && record === undefined && legacyLoopback(value)
    if ((own || orphan) && probes.get(current)?.reachable === false) {
      const previous = lane.failures[key]
      const matching = previous !== undefined && equal(previous.value, value) && now >= previous.lastAt
      if (matching && now - previous.since >= MIN_FAILURE_GAP_MS) {
        const after = own ? previousValue(record, probes) : canWrite && targeted ? { proxy: desired } : undefined
        const replacement = !own && after !== undefined ? { owner: profile, key, created: true, written: after } : undefined
        changes.push({ key, before: value, after, record: replacement })
      } else {
        failures[key] = { value, since: matching ? previous.since : now, lastAt: now }
        phase = 'suspect'
      }
      continue
    }

    if (!targeted) continue
    if (own && canWrite && sameProxy(current, desired) && lane.claims[record.owner] === undefined) {
      entries[key] = { ...record, owner: profile }
    } else if (canWrite && value === undefined) {
      const after = { proxy: desired }
      changes.push({ key, after, record: { owner: profile, key, created: true, written: after } })
    } else if (canWrite && orphan && sameProxy(current, desired)) {
      // Existing matching entries stay put when manually reverted if still
      // usable. The shared record permits health-based recovery later.
      entries[key] = { owner: profile, key, created: false, previous: value, written: value }
    } else if (value !== undefined && !own && !sameProxy(current, desired)) {
      phase = phase === 'suspect' ? phase : 'foreign'
    }
  }

  return { changes, entries, failures, phase, warnings }
}
