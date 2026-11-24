/**
 * Finding the network proxy the machine is actually using.
 *
 * The user's mental model is "I turned on my proxy app, so requests that need
 * it should go through it". On macOS that switch lives in System Settings and
 * is readable through `scutil --proxy`; on Windows it lives in the Internet
 * Settings registry key; on Linux it is conventions in the environment. This
 * module asks each of those in its own language and returns one URL, or
 * `undefined` when no proxy is on.
 *
 * Detection is cached for a short while because a scheduled check walks every
 * configured provider and each of them wants the same answer.
 */

import { execFile } from 'node:child_process'
import { isIP } from 'node:net'

/** Detection result is reused for this long; the proxy may be toggled at any time. */
const CACHE_MS = 30_000

/** Commands are given a budget so a wedged system tool cannot stall a check. */
const EXEC_TIMEOUT_MS = 2_000

/**
 * Run a command and resolve its stdout, or `undefined` on any failure.
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<string | undefined>}
 */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? String(stdout) : undefined)
    })
  })
}

/**
 * Parse `scutil --proxy` output.
 *
 * The dictionary is printed one `Key : Value` pair per line, and only the
 * HTTPS entry is usable here: an HTTP-only proxy cannot tunnel TLS, so it is
 * not a candidate at all.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function parseScutilProxy(text) {
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (match !== null) fields[match[1]] = match[2]
  }
  if (fields['HTTPSEnable'] !== '1') return undefined
  const host = fields['HTTPSProxy']
  const port = fields['HTTPSPort']
  if (host === undefined || port === undefined) return undefined
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`
}

/**
 * Parse the Windows `Internet Settings` registry values into a URL.
 * @param {string} text `reg query` output
 * @returns {string | undefined}
 */
export function parseWindowsProxy(text) {
  /** @type {Record<string, string>} */
  const values = {}
  for (const line of text.split('\n')) {
    const match = /^\s{4}(\w+)\s+REG_\w+\s+(.+?)\s*$/.exec(line)
    if (match !== null) values[match[1]] = match[2]
  }
  if (values['ProxyEnable'] !== '0x1' && values['ProxyEnable'] !== '1') return undefined
  const server = values['ProxyServer'] ?? values['Proxy']
  if (server === undefined) return undefined
  // Both `host:port` and `http=host:port;https=host:port` are legal values.
  const entry = /(?:^|;)https?=([^;]+)/i.exec(server)
  const candidate = entry === null ? server.split(';')[0] : entry[1]
  if (candidate === undefined || candidate.length === 0) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`
  return withScheme
}

/**
 * Environment-proxy convention, used as the last resort on every platform.
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function envProxy(env) {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Detect the machine's proxy.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(file: string, args: string[]) => Promise<string | undefined>} [options.exec]
 * @returns {Promise<{url?: string, source: 'system' | 'env' | 'none', detail: string}>}
 */
export async function detectSystemProxy(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exec = options.exec ?? run

  if (platform === 'darwin') {
    const text = await exec('scutil', ['--proxy'])
    if (text !== undefined) {
      const url = parseScutilProxy(text)
      if (url !== undefined) return { url, source: 'system', detail: `scutil --proxy reports ${url}` }
    }
  } else if (platform === 'win32') {
    const text = await exec('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ])
    if (text !== undefined) {
      const url = parseWindowsProxy(text)
      if (url !== undefined) return { url, source: 'system', detail: `Internet Settings reports ${url}` }
    }
  }

  const fromEnv = envProxy(env)
  if (fromEnv !== undefined) return { url: fromEnv, source: 'env', detail: `environment reports ${fromEnv}` }
  return { source: 'none', detail: 'no system proxy and no proxy environment variable' }
}

/**
 * Cached detector. `invalidate()` is called when the panel asks for a fresh
 * reading, so a proxy the user just switched on is picked up without a restart.
 */
export class ProxyWatcher {
  /** @param {object} [options] same shape as `detectSystemProxy` */
  constructor(options = {}) {
    this.options = options
    this.cached = undefined
    this.expires = 0
  }

  async current({ fresh = false } = {}) {
    if (!fresh && this.cached !== undefined && Date.now() < this.expires) return this.cached
    if (this.pending !== undefined) return this.pending
    const pending = detectSystemProxy(this.options)
    this.pending = pending
    try {
      const result = await pending
      if (this.pending === pending) {
        this.cached = result
        this.expires = Date.now() + CACHE_MS
      }
      return result
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  invalidate() {
    this.pending = undefined
    this.cached = undefined
    this.expires = 0
  }
}
