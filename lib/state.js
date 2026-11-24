/**
 * Durable state for this plugin, and the snapshots that make every write
 * reversible.
 *
 * All of it lives in one JSON file inside the profile directory, next to the
 * harness's own settings, so a profile backup captures the plugin's memory too.
 * Writes are atomic (temp file + rename) because the daemon can be killed
 * between a check and an apply, and a half-written state file would be worse
 * than a stale one.
 *
 * The snapshot directory holds *redacted* copies of the effective settings
 * (`describe({redactSecrets: true})`). That is deliberate: a backup is for
 * comparing and hand-restoring a `models` array, not for storing credentials a
 * second time.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** How many snapshots to keep; each is small (no secrets, no catalog dump). */
const KEEP_SNAPSHOTS = 20

/** Shape of a fresh state file. */
export function emptyState() {
  return {
    version: 1,
    /** `{ enabled, hour }` — a local, once-a-day check that only reports. */
    schedule: { enabled: true, hour: 9 },
    /** Provider → the protocol that last answered its listing. */
    ladder: {},
    /** Provider → model ids the user does not want proposed again. */
    ignored: {},
    /** [provider, model] pairs excluded from the conversation choice lists. */
    hiddenModels: [],
    /** Last check per provider, for the panel. */
    checks: {},
    /** `{ at, providers, additions }` summary of the last completed run. */
    summary: undefined,
    /**
     * Metadata that came from the public models.dev catalog, plus the change
     * log shown in the "待确认模型信息" tab. Per-field provenance is stored so a
     * later official answer can replace a provisional value and the panel can
     * explain where a number came from.
     */
    metadata: { records: {}, logs: [], fetchedAt: undefined, stale: false, error: undefined },
    /**
     * bili egress table: `{ enabled, hosts, written }`. `written` is the only
     * record of which keys this plugin put there, so revoking can never remove
     * an entry the user made by hand.
     */
    bili: { enabled: true, supervisor: true, hosts: undefined, written: [] },
    /**
     * Local protocol gateway: `{ enabled, entries }`, where each entry is
     * `{ provider, routeId, previousBaseURL, models, at }`. Only the *shape* of
     * what was routed is stored here — credentials stay in the settings layer
     * and are resolved fresh on every activation, never copied into this file.
     */
    gateway: { enabled: false, entries: {} },
  }
}

/** Read a JSON file, falling back to `undefined` when absent or unreadable. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write a file atomically, owner-readable only. */
export async function writeJsonAtomic(path, value) {
  const temp = `${path}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await writeFile(temp, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

/**
 * Snapshot-safe copy of a settings document.
 *
 * `describe({redactSecrets:true})` only hides fields its schema marks `secret`,
 * and a provider's `headers` table is an ordinary string dictionary — so an
 * `Authorization` header would otherwise be copied in cleartext into a
 * snapshot file. Header values are replaced here, not the header names: the
 * point of the snapshot is to show *which* headers a route sends.
 */
function redactForSnapshot(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((row) => redactForSnapshot(row, depth + 1))
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, child] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (key === 'headers' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      /** @type {Record<string, string>} */
      const masked = {}
      for (const name of Object.keys(/** @type {Record<string, unknown>} */ (child))) masked[name] = '***'
      out[key] = masked
      continue
    }
    out[key] = redactForSnapshot(child, depth + 1)
  }
  return out
}

export class Store {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.snapshotDir = join(dir, 'snapshots')
    /** @type {any} */
    this.data = emptyState()
    /** Serializes overlapping saves so they cannot interleave on one temp file. */
    this.saving = Promise.resolve()
    /**
     * Set when a state file written by another version was found and moved
     * aside. Kept on the instance so the panel can say where it went instead of
     * the plugin silently starting from an empty ledger.
     * @type {string | undefined}
     */
    this.rejected = undefined
  }

  async load() {
    await mkdir(this.dir, { recursive: true })
    // A missing file is a first run, not a rejected one: distinguishing them
    // matters because every fresh install would otherwise open the panel on a
    // red "a state file from another version could not be moved aside" row.
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return this.data
      throw error
    }
    let stored
    try {
      stored = JSON.parse(raw)
    } catch {
      stored = undefined
    }
    if (typeof stored === 'object' && stored !== null && stored.version === 1) {
      const defaults = emptyState()
      this.data = { ...defaults, ...stored, bili: { ...defaults.bili, ...stored.bili } }
      return this.data
    }

    // Another version's file: a 0.12.x state carries a different schema, and
    // half-reading it would invent a ledger this plugin never wrote. Archive it
    // so the next save starts clean but the old bytes stay recoverable.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = `${this.file}.rejected-${stamp}.json`
    try {
      await rename(this.file, path)
      this.rejected = path
    } catch {
      this.rejected = undefined
    }
    this.data = { ...emptyState(), notices: [{
      at: new Date().toISOString(),
      kind: 'state-version',
      detail: this.rejected === undefined
        ? 'a state file from another version could not be moved aside; this session starts empty'
        : `a state file from another version was archived as ${path}`,
    }] }
    return this.data
  }

  async save() {
    await mkdir(this.dir, { recursive: true })
    // Overlapping saves would race on the temp file; the chain keeps the last
    // writer's snapshot of `this.data` and runs them one at a time.
    const write = this.saving.then(() => writeJsonAtomic(this.file, this.data))
    this.saving = write.catch(() => undefined)
    await write
  }

  /**
   * Keep one redacted copy of the settings document before a write, and drop
   * the oldest beyond the retention limit.
   * @param {string} label short suffix in the file name
   * @param {unknown} sections `settings.describe({redactSecrets:true})` output
   * @returns {Promise<string>} snapshot path
   */
  async snapshot(label, sections) {
    await mkdir(this.snapshotDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(this.snapshotDir, `settings-${stamp}-${label}.json`)
    await writeJsonAtomic(path, { takenAt: new Date().toISOString(), label, sections: redactForSnapshot(sections) })
    const names = (await readdir(this.snapshotDir)).filter((name) => name.endsWith('.json')).sort()
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_SNAPSHOTS))) {
      await rm(join(this.snapshotDir, name), { force: true })
    }
    return path
  }

  /** Newest snapshots first, for the panel's "restore" list. */
  async snapshots() {
    try {
      const names = (await readdir(this.snapshotDir)).filter((name) => name.endsWith('.json')).sort().reverse()
      return names.map((name) => ({ name, path: join(this.snapshotDir, name) }))
    } catch {
      return []
    }
  }

  /** Read one snapshot back, for an exact before/after comparison. */
  async readSnapshot(name) {
    if (/[/\\]/.test(name) || !name.endsWith('.json')) return undefined
    return await readJson(join(this.snapshotDir, name))
  }
}
