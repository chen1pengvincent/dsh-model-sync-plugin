import { isDeepStrictEqual as equal } from 'node:util'
import { parseJsonc } from '../bili.js'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** GET supplies the raw provider table and reports configuration parse errors. */
export async function readLane(bili, where) {
  const origin = new URL(where.origin)
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('bili control origin is not local')
  }
  const reply = await bili.getConfig(where.origin)
  if (reply.status !== 200) throw new Error(`bili config read failed (${reply.status})`)
  const config = JSON.parse(reply.text)
  if (!object(config) || config.parseError || !object(config.providers)) {
    throw new Error('bili 配置读不动，没有写入')
  }
  const snapshot = typeof config.raw === 'string' ? JSON.parse(parseJsonc(config.raw)) : config
  if (!object(snapshot) || !equal(snapshot.providers ?? {}, config.providers)) {
    throw new Error('bili 配置读取结果不一致，没有写入')
  }
  const identity = typeof config.path === 'string' && config.path !== ''
    ? config.path : where.configPath ?? where.origin
  return { config, snapshot, providers: config.providers, identity }
}

/** Recover the ledger after a reply was lost or the daemon exited after PUT. */
export function settlePending(lane, providers) {
  for (const change of lane.pending ?? []) {
    if (!equal(providers[change.key], change.after)) continue
    if (change.record === undefined) delete lane.entries[change.key]
    else lane.entries[change.key] = change.record
  }
  delete lane.pending
}

export async function execute({ bili, where, before, lane, changes, dir, save, stopped }) {
  const providers = { ...before.providers }
  for (const { key, after } of changes) {
    if (after === undefined) delete providers[key]
    else providers[key] = after
  }

  // Persist intent first. A failed backup or a known rejection cannot create
  // ownership; an unknown PUT result is resolved from the next GET.
  const snapshot = await bili.backup(dir, before.snapshot)
  lane.pending = changes
  await save()
  const latest = await readLane(bili, where)
  const located = bili.locate()
  if (stopped() || located?.origin !== where.origin || located?.pid !== where.pid
      || latest.identity !== before.identity || !equal(latest.providers, before.providers)) {
    delete lane.pending
    await save()
    return { status: 'rejected', phase: 'conflict', error: 'bili 配置已变更，未写入' }
  }

  const reply = await bili.putProviders(where.origin, providers)
  if (reply.status >= 500) {
    // Bili persists the file before hot-reloading it. A failure in that second
    // step can return 5xx even though the provider table has already changed.
    return { status: 'applied-unverified', phase: 'applied-unverified', snapshot,
      error: `bili could not confirm the config (${reply.status})` }
  }
  if (reply.status < 200 || reply.status >= 300) {
    delete lane.pending
    await save()
    // Don't include upstream bodies: they can echo proxy credentials.
    return { status: 'rejected', phase: 'degraded', error: `bili refused the config (${reply.status})` }
  }

  let confirmed = false
  let observed
  try {
    const after = await readLane(bili, where)
    if (after.identity === before.identity) {
      observed = after.providers
      settlePending(lane, observed)
      confirmed = equal(observed, providers)
    }
  } catch {
    // Leave the journal intact until a valid read can resolve the outcome.
  }
  await save()
  if (!confirmed) return { status: 'applied-unverified', phase: 'applied-unverified', snapshot, observed }
  const applied = changes.some(({ record }) => record !== undefined)
  return { status: applied ? 'applied' : 'revoked', phase: applied ? 'applied' : 'revoked', snapshot, observed }
}
