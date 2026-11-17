/**
 * Managing the per-provider egress proxy that billion-context ("bili") applies
 * to model traffic.
 *
 * Why this exists. On this machine every model request leaves the harness as a
 * patched `fetch` call: bili rewrites it to `http://127.0.0.1:<lane>/bili/<url>`
 * and re-sends it from a child process whose proxy environment has been
 * stripped. That child resolves its egress **per target host** from its own
 * config, and ignores the harness dispatcher entirely — so a plugin that flips
 * a global dispatcher (which is what the previous version did) cannot possibly
 * affect it. The only lever that reaches the wire is bili's `providers` table.
 *
 * Safety rules, all enforced here:
 *  - Only the `providers` table is written, and only that table is sent: the
 *    lane merges a narrow body into its own file, so keys this plugin never
 *    looked at (`compress`, `security`, a hand edit made a second ago) cannot
 *    be rolled back to a stale read.
 *  - The whole config goes through bili's own validated PUT, not a blind file
 *    write, so a bad proxy URL is rejected instead of bricking the lane.
 *  - The previous providers table is backed up before every change, and only
 *    keys this plugin created are ever removed again.
 *  - When bili is absent, disabled, or the system proxy is off, nothing is
 *    written at all.
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { request } from './http.js'

/**
 * Hosts whose model traffic needs the local proxy on a censored network. Kept a
 * short, explicit list rather than "anything not on the LAN": writing a proxy
 * for a host that does not need one only adds a hop, but writing one for a
 * host that cannot tolerate it (an internal gateway) breaks a working route.
 */
export const DEFAULT_PROXY_HOSTS = [
  'generativelanguage.googleapis.com',
  'api.openai.com',
  'api.anthropic.com',
]

/** bili's runtime state directory: where the lane announces its port. */
function stateDir(env = process.env) {
  const base = typeof env['XDG_STATE_HOME'] === 'string' && env['XDG_STATE_HOME'].length > 0
    ? env['XDG_STATE_HOME']
    : join(homedir(), '.local', 'state')
  return join(base, 'billion-context')
}

/** Whether a pid is alive. Signal 0 performs the permission and existence check. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'EPERM'
  }
}

/** The compression lane's default port; it refuses a tunnel aimed at itself. */
export const BILI_ZONE_PORT = 18787

/**
 * Find the running bili lane.
 *
 * `proxy-origin` is written by the lane at startup and carries the pid, so it is
 * preferred: a stale port-zone from a previous boot would otherwise point at a
 * port that now belongs to something else.
 *
 * @param {{env?: NodeJS.ProcessEnv, dir?: string, isAlive?: (pid: number) => boolean}} [options]
 * @returns {{origin: string, pid?: number, lane?: string, configPath: string, statePath: string} | undefined}
 */
export function locate(options = {}) {
  const env = options.env ?? process.env
  const dir = options.dir ?? stateDir(env)
  const live = options.isAlive ?? alive
  const originPath = join(dir, 'proxy-origin')
  const zonePath = join(dir, 'port-zone.json')
  const configPath = typeof env['BILI_CONFIG_FILE'] === 'string' && env['BILI_CONFIG_FILE'].length > 0
    ? env['BILI_CONFIG_FILE']
    : join(typeof env['XDG_CONFIG_HOME'] === 'string' && env['XDG_CONFIG_HOME'].length > 0 ? env['XDG_CONFIG_HOME'] : join(homedir(), '.config'), 'billion-context', 'billion-context.json')

  /** @type {{origin?: unknown, pid?: unknown, lane?: unknown} | undefined} */
  /** @type {any} */
  let origin
  try {
    origin = JSON.parse(readFileSyncSafe(originPath) ?? 'null') ?? undefined
  } catch {
    origin = undefined
  }
  if (origin !== undefined && typeof origin.origin === 'string') {
    const pid = Number(origin.pid)
    // Only a record whose process is provably alive may win over the port
    // zone. Without a pid there is no way to tell a live lane from a stale
    // file, and the port may already belong to something else — PUTting a
    // provider table (possibly with `user:pass@`) at it would be a leak.
    if (Number.isFinite(pid) && live(pid)) {
      return { origin: origin.origin.replace(/\/+$/, ''), pid: Number.isFinite(pid) ? pid : undefined, lane: typeof origin.lane === 'string' ? origin.lane : undefined, configPath, statePath: dir }
    }
  }

  try {
    const zone = JSON.parse(readFileSyncSafe(zonePath) ?? 'null')
    const port = zone?.lanes?.dsh
    if (Number.isInteger(port) && port > 0) {
      return { origin: `http://127.0.0.1:${String(port)}`, lane: 'dsh', configPath, statePath: dir }
    }
  } catch {
    // fall through
  }
  return undefined
}

/** Synchronous read that returns undefined instead of throwing. */
function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Strip comments and trailing commas so a hand-edited JSONC config can be read.
 *
 * A tiny scanner rather than a regex: a `//` inside a URL string must not be
 * treated as a comment, and bili's config is full of URLs.
 * @param {string} text
 */
export function parseJsonc(raw) {
  const text = raw.replace(/^\uFEFF/, '')
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === '\n') { inLine = false; out += char }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') { inBlock = false; index += 1 }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') { out += next ?? ''; index += 1; continue }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && next === '/') { inLine = true; index += 1; continue }
    if (char === '/' && next === '*') { inBlock = true; index += 1; continue }
    if (char === '}' || char === ']') {
      // A trailing comma is legal JSONC and illegal JSON. Doing this here
      // instead of with a regex afterwards keeps `{"h":"x,}"}` intact: a
      // rewrite would silently change a user's header value.
      out = out.replace(/,\s*$/, '')
    }
    out += char
  }
  return out
}

/** Read the on-disk config, or `{}` when it does not exist yet. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export class BiliConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BiliConfigError'
  }
}

/**
 * Read the lane config for a *write*. `readConfigFile` swallows every failure
 * into `{}`, which is fine for a display but not for a write: the lane replaces
 * the whole `providers` table, so writing "what we read" of an unreadable file
 * deletes every entry the user had. Only a missing file may become an empty
 * table; anything else has to stop the write.
 *
 * @param {string} path
 * @returns {Promise<Record<string, any>>}
 */
export async function readConfigStrict(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return {}
    throw new BiliConfigError(`bili 配置读不动（${String(/** @type {any} */ (error)?.code ?? messageOf(error))}）：${path}`)
  }
  try {
    const parsed = JSON.parse(parseJsonc(text))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    throw new BiliConfigError(`bili 配置解析失败，没有写入：${String(/** @type {any} */ (error)?.message ?? error)}`)
  }
}

/** Lenient read for displays: an unreadable file shows as an empty table. */
export async function readConfigFile(path) {
  try {
    return await readConfigStrict(path)
  } catch {
    return {}
  }
}

/**
 * The provider keys that carry a proxy for a host. bili keeps a second entry for
 * MITM-lane traffic under the `mitm://` scheme, so a host that already has one
 * gets both updated: leaving the twin alone would make half the traffic direct.
 * @param {Record<string, unknown> | undefined} providers
 * @param {string} host
 */
/** `https://Host:443/` and `https://host` address the same provider. */
function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/^([a-z]+):\/\//, '$1://').replace(/:443(?=\/|$)/, '').replace(/\/+$/, '')
}

function entryKeys(providers, host) {
  const wanted = `https://${host}`
  /** @type {string[]} */
  const keys = [wanted]
  for (const key of Object.keys(providers ?? {})) {
    const normalized = normalizeKey(key)
    // Reuse the spelling that is already there (`https://Host:443`) instead of
    // adding a second entry for the same host.
    if (normalized === wanted) keys[0] = key
    else if (normalized === `mitm://${host}`) keys.push(key)
  }
  return keys
}

/**
 * Compute the smallest edit that makes every listed host use `proxy`.
 *
 * @param {{providers?: Record<string, any>} & Record<string, unknown>} config parsed config
 * @param {readonly string[]} hosts
 * @param {string} proxy absolute `http://host:port`
 * @returns {{next: Record<string, unknown>, touched: {key: string, previous?: unknown, created: boolean}[], unchanged: string[]}}
 */
export function planProviders(config, hosts, proxy) {
  const providers = config.providers !== null && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? { .../** @type {Record<string, any>} */ (config.providers) }
    : {}
  /** @type {{key: string, previous?: unknown, created: boolean}[]} */
  const touched = []
  /** @type {string[]} */
  const unchanged = []

  for (const host of hosts) {
    for (const key of entryKeys(providers, host)) {
      const current = providers[key]
      if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
        if (/** @type {any} */ (current).proxy === proxy) {
          unchanged.push(key)
          continue
        }
        const replacement = { .../** @type {Record<string, unknown>} */ (current), proxy }
        touched.push({ key, previous: structuredClone(current), created: false, written: structuredClone(replacement) })
        providers[key] = replacement
        continue
      }
      const created = { proxy }
      touched.push({ key, previous: current, created: current === undefined, written: structuredClone(created) })
      providers[key] = created
    }
  }

  return { next: { ...config, providers }, touched, unchanged }
}

/** Build the reverse edit: drop the proxy this plugin wrote and restore what was there. */
export function revertProviders(config, touched) {
  const providers = config.providers !== null && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? { .../** @type {Record<string, any>} */ (config.providers) }
    : {}
  for (const entry of touched) {
    // The user may have edited this entry after we wrote it (their own note, a
    // different proxy, a different shape). Undoing our write must not delete or
    // overwrite their edit — the revoke is ours to withdraw, not theirs.
    const current = providers[entry.key]
    const expected = entry.written
    if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) continue
    if (entry.created) {
      delete providers[entry.key]
      continue
    }
    if (entry.previous === undefined) continue
    providers[entry.key] = entry.previous
  }
  return { ...config, providers }
}

/**
 * Push a config through bili's own validated channel.
 *
 * The HTTP API is the only path that validates the payload **and** applies it
 * without a restart (the lane watches no files). It is reached over a raw socket
 * on purpose: `fetch` is the very thing bili rewrites, and the process
 * environment may ask node to route loopback through the system proxy.
 *
 * @param {string} origin
 * @param {unknown} config
 * @returns {Promise<{status: number, body: string}>}
 */
/**
 * Write just the providers table.
 *
 * The lane's PUT handler reads its own file, replaces `providers` wholesale and
 * keeps every other key. Sending the full config instead would make this
 * plugin an author of `compress`/`security` too, and a stale read would then
 * silently revert someone else's edit — the exact cross-plugin coupling worth
 * avoiding.
 *
 * @param {string} origin
 * @param {Record<string, unknown>} providers
 * @param {{timeoutMs?: number}} [options]
 */
export async function putProviders(origin, providers, options = {}) {
  return putConfig(origin, { providers }, options)
}

export async function putConfig(origin, config, options = {}) {
  const body = JSON.stringify(config)
  const reply = await request({
    url: `${origin.replace(/\/+$/, '')}/__bili/config`,
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
    proxy: undefined,
    timeoutMs: options.timeoutMs ?? 8_000,
  })
  return { status: reply.status, body: reply.text }
}

/** Read bili's effective config (used to confirm a write landed). */
export async function getConfig(origin, options = {}) {
  const reply = await request({ url: `${origin.replace(/\/+$/, '')}/__bili/config`, method: 'GET', proxy: undefined, timeoutMs: options.timeoutMs ?? 8_000 })
  return { status: reply.status, text: reply.text }
}

/** Keep the previous config on disk, next to this plugin's own state. */
export async function backupConfig(dir, config) {
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `bili-config-${stamp}.json`)
  await writeFile(path, `${JSON.stringify(config, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return path
}
