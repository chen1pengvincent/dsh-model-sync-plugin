import { connect, isIP } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { parseProxy } from '../http.js'

const PROBE_TIMEOUT_MS = 1_500
const PROBE_TCP_MS = 800
const PROBE_CACHE_MS = 10_000
const MAX_HEADER_BYTES = 16_384

function failureReason(error) {
  switch (error?.code) {
    case 'ECONNREFUSED': return 'refused'
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return 'dns'
    case 'ETIMEDOUT': return 'timeout'
    default: return 'error'
  }
}

function handshake(proxy, authority, timeoutMs) {
  return new Promise((resolve) => {
    const { host, port } = proxy
    const socket = proxy.tls
      ? connectTls({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: true })
      : connect({ host, port })
    let header = Buffer.alloc(0)
    let settled = false
    const tcpTimer = setTimeout(() => finish('timeout'), Math.min(PROBE_TCP_MS, timeoutMs))
    const totalTimer = setTimeout(() => finish('timeout'), timeoutMs)

    function finish(reason, status, reachable = false) {
      if (settled) return
      settled = true
      clearTimeout(tcpTimer)
      clearTimeout(totalTimer)
      socket.destroy()
      resolve({ reason, status, reachable, ok: reason === 'ok' })
    }

    socket.once('error', (error) => finish(failureReason(error)))
    socket.once('close', () => finish('timeout'))
    socket.once('connect', () => clearTimeout(tcpTimer))
    socket.once(proxy.tls ? 'secureConnect' : 'connect', () => {
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
      if (proxy.auth !== undefined) {
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      const remaining = MAX_HEADER_BYTES - header.length
      header = Buffer.concat([header, chunk.subarray(0, remaining)])
      if (header.indexOf('\r\n\r\n') === -1) {
        if (header.length === MAX_HEADER_BYTES) finish('error', undefined, true)
        return
      }
      const match = /^HTTP\/1\.[01] (\d{3})(?=[ \r])/.exec(header.toString('latin1'))
      if (match === null) return finish('error', undefined, true)
      const status = Number(match[1])
      finish(status === 200 ? 'ok' : status === 407 ? 'auth' : 'blocked', status, true)
    })
  })
}

const cache = new Map()

/** Establish a CONNECT tunnel through the proxy. No TLS or model request is sent. */
export async function probeProxy(url, options = {}) {
  const { targetHost = 'generativelanguage.googleapis.com', targetPort = 443,
    timeoutMs = PROBE_TIMEOUT_MS, cacheBust = false } = options
  const started = Date.now()
  const key = JSON.stringify([url, targetHost, targetPort, timeoutMs])
  const cached = cache.get(key)
  if (!cacheBust && cached !== undefined && started - cached.at < PROBE_CACHE_MS) return cached

  const proxy = typeof url === 'string' && /^http:\/\//i.test(url) ? parseProxy(url) : undefined
  const validTarget = typeof targetHost === 'string'
    && (/^[a-z0-9.-]+$/i.test(targetHost) || isIP(targetHost) === 6)
    && Number.isInteger(targetPort) && targetPort > 0 && targetPort <= 65535
  const authority = isIP(targetHost) === 6 ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`
  let result = { reason: 'invalid', reachable: false, ok: false }
  if (proxy !== undefined && validTarget) {
    try {
      result = await handshake(proxy, authority, timeoutMs)
    } catch {
      result = { reason: 'error', reachable: false, ok: false }
    }
  }

  const at = Date.now()
  const observed = { ...result, at, ms: at - started }
  for (const [cachedKey, row] of cache) {
    if (at - row.at >= PROBE_CACHE_MS) cache.delete(cachedKey)
  }
  // A slower earlier observation must not overwrite a newer result.
  if ((cache.get(key)?.at ?? 0) <= started) cache.set(key, observed)
  return observed
}


function foreignEndpoint(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const raw = value.trim()
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.port === '0') return undefined
    return url
  } catch {
    return undefined
  }
}

/** Labels contain only scheme and authority, even for credentialed proxies. */
export function proxyDisplay(value) {
  return foreignEndpoint(value)?.origin
}

/** Diagnose a bili declaration without credentials or changing the write gate. */
export async function probeForeignProxy(value, { targetHost } = {}) {
  const url = foreignEndpoint(value)
  if (url === undefined || typeof targetHost !== 'string' || !/^[a-z0-9.-]+$/i.test(targetHost)) {
    return { reason: 'invalid', reachable: false, ok: false }
  }
  const tls = url.protocol === 'https:'
  try {
    const result = await handshake({
      host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: Number(url.port || (tls ? 443 : 80)),
      tls,
    }, `${targetHost}:443`, PROBE_TIMEOUT_MS)
    return result.reason === 'error' ? { ...result, reachable: false } : result
  } catch {
    return { reason: 'error', reachable: false, ok: false }
  }
}
