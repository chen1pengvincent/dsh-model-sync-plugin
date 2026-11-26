/**
 * Minimal HTTP/1.1 client over raw sockets, with optional HTTP CONNECT tunnelling.
 *
 * Why not `fetch`, `node:http` or `node:https`:
 *
 *  - This profile runs `NODE_USE_ENV_PROXY=1`. Node's built-in environment-proxy
 *    support intercepts `http.request` even for a CONNECT dial to
 *    `127.0.0.1:7897`, so the tunnel handshake hangs (measured: no reply within
 *    60s, while the same CONNECT completes in 1ms over `net.connect`).
 *  - `fetch` is additionally replaced at runtime by a compression plugin's
 *    loopback rewrite, whose lane process has every `HTTP(S)_PROXY` stripped and
 *    which never consults the harness dispatcher, so a `fetch` here could not be
 *    steered by this plugin at all.
 *
 * Driving the socket directly removes both classes of interference: what this
 * module writes is exactly what reaches the wire. It is deliberately not a
 * general-purpose HTTP stack — no redirects, no retries, no pooling, one
 * request per connection (`Connection: close`). Every caller above it
 * re-requests on purpose, so retry policy would be invisible here.
 */

import { addAbortListener } from 'node:events'
import net from 'node:net'
import { addAbortSignal } from 'node:stream'
import tls from 'node:tls'

/** Default wall-clock budget for one exchange, including resolution and the tunnel handshake. */
export const MAX_HEAD_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

/** Replies larger than this are refused rather than truncated: a cut model listing does not parse. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Thrown when the caller aborts. */
export class AbortedError extends Error {
  constructor(message = 'request aborted') {
    super(message)
    this.name = 'AbortedError'
    this.code = 'ABORTED'
  }
}

/** Keep caller cancellation identifiable across TCP, CONNECT, TLS and body reads. */
function socketError(error, context) {
  if (error instanceof AbortedError) return error
  if (error.code === 'ABORT_ERR') return new AbortedError()
  return context === undefined ? error : new Error(`${context}: ${error.message}`)
}

/**
 * Parse a proxy setting into `{protocol, host, port, auth}`.
 *
 * Accepts `http://host:port`, `host:port`, and the authenticated form. Rejects
 * anything this client cannot tunnel through — SOCKS is not implemented, and
 * silently falling back to a direct connection when the user asked for a proxy
 * would make "proxied" a lie.
 *
 * @param {unknown} value raw setting
 * @returns {{protocol: string, host: string, port: number, auth?: string} | undefined}
 */
export function parseProxy(value) {
  if (value === undefined || value === null) return undefined
  const raw = String(value).trim()
  if (raw.length === 0) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  if (url.hostname.length === 0) return undefined
  const port = url.port === '' ? 80 : Number(url.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  let auth
  try {
    auth = url.username === '' ? undefined : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  } catch {
    // `http://user:P%ssw0rd@host:8080` is a real thing people type. A malformed
    // escape must make the proxy unusable, not throw `URIError` out of a
    // function documented as returning `undefined`.
    return undefined
  }
  return { protocol: url.protocol, host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port, auth }
}

/**
 * Whether this request will actually go through a proxy.
 *
 * `parseProxy` deliberately returns `undefined` for anything that is not an
 * `http://` endpoint, but every caller turned that `undefined` into "no proxy"
 * and then reported `via: 'proxy'`. A SOCKS URL therefore left the machine in
 * clear text while the caller believed it was tunnelled — the one failure mode
 * this module exists to prevent.
 */
function proxyRoute(proxy) {
  if (proxy === undefined || proxy === null) return 'direct'
  const text = typeof proxy === 'string' ? proxy.trim() : undefined
  if (text === '') return 'direct'
  if (text !== undefined && typeof proxy === 'string' && parseProxy(text) === undefined) {
    throw new Error('the proxy setting is not usable: only http:// proxies with CONNECT are supported')
  }
  return 'proxy'
}

/** Refuse header values that would split the request or the reply. */
function assertHeaderValue(name, value) {
  const text = String(value)
  if (/[\r\n]/.test(text)) throw new Error(`header "${name}" contains a line break`)
  return text
}

/** Drop credential-shaped tokens from text that is about to be quoted. */
export function redactSecrets(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1***')
    .replace(/(authorization:\s*\S+\s+)\S+/gi, '$1***')
}

/** Human-readable one-liner for an unknown thrown value. */
export function describeError(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? ` [${error.code}]` : ''
    return `${error.message}${code}`
  }
  return String(error)
}

/**
 * Establish a TCP connection, and for https a TLS session, optionally through
 * an HTTP proxy. DNS for a proxied target is resolved by the proxy, which is
 * the only way a blocked name can be reached at all.
 *
 * @param {object} options
 * @param {string} options.host target hostname
 * @param {number} options.port target port
 * @param {boolean} options.secure wrap in TLS
 * @param {string | {host: string, port: number, auth?: string}} [options.proxy]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('node:net').Socket>}
 */
export async function connect(options) {
  const { host, port, secure, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  // A proxy URL and a proxy endpoint mean the same thing; normalising here keeps
  // every caller from having to remember which one this layer takes.
  const proxy = typeof options.proxy === 'string' ? parseProxy(options.proxy) : options.proxy
  const deadline = Date.now() + timeoutMs
  const dialHost = proxy === undefined ? host : proxy.host
  const dialPort = proxy === undefined ? port : proxy.port

  const socket = net.connect({ host: dialHost, port: dialPort })
  const abortDial = options.signal && addAbortListener(options.signal, () => socket.destroy(new AbortedError()))
  const detachDial = () => abortDial?.[Symbol.dispose]()
  if (abortDial) socket.once('close', detachDial)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`could not reach ${dialHost}:${String(dialPort)} within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setNoDelay(true)
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(socketError(error, `could not reach ${dialHost}:${String(dialPort)}`))
    })
  })

  let stream = socket
  if (proxy !== undefined) {
    const lines = [`CONNECT ${host}:${String(port)} HTTP/1.1`, `Host: ${host}:${String(port)}`]
    if (proxy.auth !== undefined) {
      lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth, 'utf8').toString('base64')}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    const header = await new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0)
      const done = () => {
        cleanup()
        resolve(buffered.subarray(0, buffered.indexOf('\r\n\r\n')).toString('latin1'))
      }
      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        const end = buffered.indexOf('\r\n\r\n')
        if ((end === -1 ? buffered.length : end + 4) > MAX_HEAD_BYTES) {
          onError(new Error(`the proxy headers exceeded ${MAX_HEAD_BYTES} bytes`))
        } else if (end !== -1) done()
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      const onClose = () => onError(new Error('proxy closed before completing the CONNECT response'))
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`no reply within ${String(timeoutMs)}ms`))
      }, Math.max(1, deadline - Date.now()))
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      socket.on('data', onData)
      socket.once('error', onError)
      socket.once('close', onClose)
    }).catch((error) => {
      socket.destroy()
      throw socketError(error, `proxy CONNECT to ${host}:${String(port)} failed`)
    })
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(header)
    if (status === null || status[1] !== '200') {
      socket.destroy()
      throw new Error(`proxy refused CONNECT ${host}:${String(port)}: ${header.split('\r\n')[0] ?? 'no reply'}`)
    }
    // A 200 leaves the connection transparent; anything a proxy sends past the
    // header would belong to the tunnel payload, which cannot exist yet.
    socket.removeAllListeners('data')
    socket.pause()
    socket.resume()
    stream = socket
  }

  if (!secure) return stream
  // TLS takes ownership of the underlying socket. Aborting both layers lets
  // a bare TCP close reach the TLS reader before the cancellation error.
  detachDial()
  return await new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket: stream,
      servername: net.isIP(host) === 0 ? host : undefined,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
    })
    if (options.signal) addAbortSignal(options.signal, secureSocket)
    const timer = setTimeout(() => {
      secureSocket.destroy()
      reject(new Error(`TLS handshake with ${host} timed out`))
    }, Math.max(1, deadline - Date.now()))
    secureSocket.once('secureConnect', () => {
      clearTimeout(timer)
      secureSocket.setNoDelay(true)
      resolve(secureSocket)
    })
    secureSocket.once('error', (error) => {
      clearTimeout(timer)
      reject(socketError(error, `TLS handshake with ${host} failed`))
    })
  })
}

/**
 * A socket plus the bytes read past the current parse position. HTTP framing
 * means a single `data` event can carry the status line, the headers and part
 * of the body, so nothing may be discarded between stages.
 */
class Reader {
  /** @param {import('node:net').Socket} socket */
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.ended = false
    this.failure = undefined
    this._notify = undefined
    // Read one socket delivery per pending read. A gateway waiting for its
    // client to drain must also let TCP slow the upstream sender.
    socket.pause()
    socket.on('data', (chunk) => {
      socket.pause()
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this._wake()
    })
    socket.on('end', () => {
      this.ended = true
      this._wake()
    })
    socket.on('close', () => {
      this.ended = true
      this._wake()
    })
    socket.on('error', (error) => {
      this.failure = socketError(error)
      this.ended = true
      this._wake()
    })
  }

  _wake() {
    const notify = this._notify
    this._notify = undefined
    if (notify !== undefined) notify()
  }

  /** Resolve on the next arrival of bytes, end, error or deadline. */
  _tick(deadline, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._notify = undefined
        reject(new Error(`timed out waiting for ${what}`))
      }, Math.max(1, deadline - Date.now()))
      this._notify = () => {
        clearTimeout(timer)
        this._notify = undefined
        resolve(undefined)
      }
      this.socket.resume()
    })
  }

  /** Drop `count` bytes from the head of the buffer. */
  _consume(count) {
    this.buffer = this.buffer.subarray(count)
  }

  /** Read up to and including `marker`, returning everything before it. */
  async until(marker, deadline, what, limit = MAX_HEAD_BYTES) {
    for (;;) {
      // A peer that keeps writing without ever sending the marker would
      // otherwise be read forever: the body has a limit, the head did not.
      const at = this.buffer.indexOf(marker)
      const scanned = at === -1 ? this.buffer.length : at + marker.length
      if (scanned > limit) throw new Error(`${what} exceeded ${String(limit)} bytes`)
      if (at !== -1) {
        const head = this.buffer.subarray(0, at)
        this._consume(at + marker.length)
        return head
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) throw new Error(`connection closed while waiting for ${what}`)
      await this._tick(deadline, what)
    }
  }

  /** Collect a listing without copying the already-read prefix on each packet. */
  async collect(count, deadline, maxBytes = count) {
    const chunks = []
    let total = 0
    while (total < count) {
      const piece = await this.takeUpTo(count - total, deadline)
      if (piece === undefined) {
        if (count !== Infinity) throw new Error(`connection closed after ${total} of ${count} bytes`)
        break
      }
      total += piece.length
      if (total > maxBytes) throw new Error(`reply exceeded the ${maxBytes} byte limit`)
      chunks.push(piece)
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
  }

  /**
   * Take whatever is buffered right now, waiting for the first byte if the
   * buffer is empty. Returns `undefined` at end of stream.
   *
   * This is the primitive a streaming caller needs: it never waits for a
   * length it does not know, so an SSE reply is handed on as it arrives
   * instead of after the provider finishes.
   */
  async take(deadline) {
    return this.takeUpTo(Infinity, deadline)
  }

  /** Take at most `count` bytes, waiting for at least one. `undefined` at end of stream. */
  async takeUpTo(count, deadline) {
    while (this.buffer.length === 0) {
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return undefined
      await this._tick(deadline, 'body bytes')
    }
    if (this.buffer.length <= count) {
      const out = this.buffer
      this.buffer = Buffer.alloc(0)
      return out
    }
    const out = this.buffer.subarray(0, count)
    this._consume(count)
    return out
  }
}

/**
 * Read a status line and headers, stopping at the blank line.
 *
 * @param {Reader} reader
 * @param {number} deadline absolute epoch ms
 * @returns {Promise<{status: number, headers: Record<string, string>}>}
 */
async function readHead(reader, deadline) {
  const head = await reader.until('\r\n\r\n', deadline, 'the response headers', MAX_HEAD_BYTES)
  const lines = head.toString('latin1').split('\r\n')
  const statusLine = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(lines[0] ?? '')
  if (statusLine === null) throw new Error(`malformed status line: ${(lines[0] ?? '').slice(0, 120)}`)
  const status = Number(statusLine[1])

  /** @type {Record<string, string>} */
  const headers = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
  }
  return { status, headers }
}

/**
 * Read one HTTP response: status line, headers, then a body framed by
 * `transfer-encoding: chunked`, `content-length`, or end-of-connection.
 *
 * @param {Reader} reader
 * @param {number} deadline absolute epoch ms
 * @param {number} maxBytes
 * @returns {Promise<{status: number, headers: Record<string, string>, body: Buffer}>}
 */
async function readResponse(reader, deadline, maxBytes) {
  const { status, headers } = await readHead(reader, deadline)

  // 204 and 304 carry no body, and a HEAD reply never does; neither is used
  // here, but reading one would otherwise block until the connection closed.
  if (status === 204 || status === 304) return { status, headers, body: Buffer.alloc(0) }

  if (/\bchunked\b/i.test(headers['transfer-encoding'] ?? '')) {
    const chunks = []
    let total = 0
    for (;;) {
      /** @type {Buffer} */
      let sizeLine
      try {
        sizeLine = await reader.until('\r\n', deadline, 'a chunk size')
      } catch (error) {
        // A peer that sends its last chunk and then closes without the zero
        // terminator has still delivered everything it meant to. Throwing away
        // a complete body over a missing `0\r\n\r\n` turns a good listing
        // into "transport failure".
        if (chunks.length > 0 && /connection closed/i.test(String(error))) return { status, headers, body: Buffer.concat(chunks) }
        throw error
      }
      const size = Number.parseInt(sizeLine.toString('latin1').split(';')[0].trim(), 16)
      if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunk size')
      if (size === 0) {
        // Consume trailers (if any) up to the final blank line.
        await reader.until('\r\n', deadline, 'the end of the chunked body')
        break
      }
      total += size
      if (total > maxBytes) throw new Error(`reply exceeded the ${String(maxBytes)} byte limit`)
      chunks.push(await reader.collect(size, deadline))
      await reader.until('\r\n', deadline, 'a chunk terminator')
    }
    return { status, headers, body: Buffer.concat(chunks) }
  }

  const declared = headers['content-length']
  if (declared !== undefined) {
    const length = Number(declared)
    if (!Number.isInteger(length) || length < 0) throw new Error('malformed content-length')
    if (length > maxBytes) throw new Error(`reply declared ${String(length)} bytes, over the ${String(maxBytes)} limit`)
    return { status, headers, body: await reader.collect(length, deadline) }
  }

  return { status, headers, body: await reader.collect(Infinity, deadline, maxBytes) }
}

/**
 * Issue one request and collect its reply.
 *
 * @param {object} options
 * @param {string} options.url absolute http(s) URL
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string | Uint8Array} [options.body]
 * @param {string | {host: string, port: number, auth?: string}} [options.proxy] tunnel through this proxy
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: number, headers: Record<string, string>, text: string, url: string, via: 'direct' | 'proxy'}>}
 */
export async function request(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    proxy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
  } = options
  if (signal?.aborted === true) throw new AbortedError()

  const target = new URL(url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`unsupported protocol "${target.protocol}"`)
  }
  const secure = target.protocol === 'https:'
  const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
  const deadline = Date.now() + timeoutMs
  const via = proxyRoute(proxy)
  // Validate before dialling: a bad header must fail loudly, not after a
  // connection has already been made.
  for (const [name, value] of Object.entries(headers ?? {})) assertHeaderValue(name, value)

  const socket = await connect({ host: target.hostname, port, secure, proxy, timeoutMs, signal })

  try {
    const reader = new Reader(socket)
    const payload = body === undefined
      ? Buffer.alloc(0)
      : typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
    /** @type {Record<string, string>} */
    const outgoing = {
      host: target.host,
      accept: 'application/json',
      'accept-encoding': 'identity',
      connection: 'close',
      ...headers,
    }
    if (payload.length > 0) outgoing['content-length'] = String(payload.length)
    const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`]
    for (const [name, value] of Object.entries(outgoing)) lines.push(`${name}: ${assertHeaderValue(name, value)}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (payload.length > 0) socket.write(payload)

    const response = await readResponse(reader, deadline, maxBytes)
    return {
      status: response.status,
      headers: response.headers,
      text: response.body.toString('utf8'),
      url,
      via,
    }
  } finally {
    socket.destroy()
  }
}

/**
 * Issue one request and hand the reply back as a stream of body chunks.
 *
 * `request` waits for the whole body because a model listing either parses or
 * it does not. A chat completion is different: the first token has to leave
 * the gateway before the last one exists, so the caller needs the bytes while
 * they arrive. Everything else — the tunnel, the framing, the head parsing —
 * is the same code, which keeps one set of bugs rather than two.
 *
 * `timeoutMs` here is an *idle* budget, re-armed before every read, so a long
 * generation is not killed by its own duration.
 *
 * @param {object} options
 * @param {string} options.url absolute http(s) URL
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string | Uint8Array} [options.body]
 * @param {string | {host: string, port: number, auth?: string}} [options.proxy]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: number, headers: Record<string, string>, chunks: AsyncGenerator<Buffer>, close: () => void, url: string, via: 'direct' | 'proxy'}>}
 */
export async function openStream(options) {
  const {
    url,
    method = 'POST',
    headers = {},
    body,
    proxy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options
  if (signal?.aborted === true) throw new AbortedError()

  const target = new URL(url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`unsupported protocol "${target.protocol}"`)
  }
  const secure = target.protocol === 'https:'
  const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
  const via = proxyRoute(proxy)
  for (const [name, value] of Object.entries(headers ?? {})) assertHeaderValue(name, value)

  const socket = await connect({ host: target.hostname, port, secure, proxy, timeoutMs, signal })

  const reader = new Reader(socket)
  const payload = body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  /** @type {Record<string, string>} */
  const outgoing = {
    host: target.host,
    accept: 'text/event-stream',
    'accept-encoding': 'identity',
    connection: 'close',
    ...headers,
  }
  if (payload.length > 0) outgoing['content-length'] = String(payload.length)
  const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`]
  for (const [name, value] of Object.entries(outgoing)) lines.push(`${name}: ${assertHeaderValue(name, value)}`)
  /** @type {{ status: number, headers: Record<string, string> }} */
  let head
  try {
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (payload.length > 0) socket.write(payload)
    head = await readHead(reader, Date.now() + timeoutMs)
  } catch (error) {
    // Without this, a peer that accepts and then goes quiet leaks the socket
    // for the life of the process: `request` has a `finally`, this had none.
    socket.destroy()
    throw error
  }
  const { status, headers: replyHeaders } = head

  const idle = () => Date.now() + timeoutMs

  async function* frame() {
    if (status === 204 || status === 304) return
    const chunked = /\bchunked\b/i.test(replyHeaders['transfer-encoding'] ?? '')
    if (chunked) {
      for (;;) {
        const sizeLine = await reader.until('\r\n', idle(), 'a chunk size')
        const size = Number.parseInt(sizeLine.toString('latin1').split(';')[0].trim(), 16)
        if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunk size')
        if (size === 0) {
          await reader.until('\r\n', idle(), 'the end of the chunked body')
          return
        }
        let left = size
        while (left > 0) {
          const piece = await reader.takeUpTo(left, idle())
          if (piece === undefined) throw new Error('connection closed inside a chunk')
          left -= piece.length
          if (piece.length > 0) yield piece
        }
        await reader.until('\r\n', idle(), 'a chunk terminator')
      }
    }

    const declared = replyHeaders['content-length']
    if (declared !== undefined) {
      const length = Number(declared)
      if (!Number.isInteger(length) || length < 0) throw new Error('malformed content-length')
      let left = length
      while (left > 0) {
        const piece = await reader.takeUpTo(left, idle())
        if (piece === undefined) throw new Error('connection closed before the declared body length')
        left -= piece.length
        if (piece.length > 0) yield piece
      }
      return
    }

    for (;;) {
      const piece = await reader.take(idle())
      if (piece === undefined) return
      if (piece.length > 0) yield piece
    }
  }

  return {
    status,
    headers: replyHeaders,
    chunks: frame(),
    close: () => {
      socket.destroy()
    },
    url,
    via,
  }
}

/**
 * A URL with every query value replaced, for messages that may be stored or
 * shown. Some OpenAI-compatible gateways carry the credential in the query
 * string (`?key=…`), and a check's error text is kept in the plugin's state
 * file and rendered in the panel, so the raw URL must not travel.
 * @param {string} url
 * @returns {string}
 */
export function maskUrl(url) {
  const text = String(url)
  const cut = text.indexOf('?')
  if (cut === -1) return text
  const query = text.slice(cut + 1).split('&').map((pair) => {
    const eq = pair.indexOf('=')
    return eq === -1 ? pair : `${pair.slice(0, eq)}=***`
  })
  return `${text.slice(0, cut)}?${query.join('&')}`
}

/**
 * `request` plus JSON decoding. The decoded body is returned even for non-2xx
 * replies: providers put the reason in the body ("API key not valid"), and
 * that sentence is what the panel shows.
 *
 * @param {Parameters<typeof request>[0]} options
 * @returns {Promise<{status: number, headers: Record<string, string>, json: unknown, text: string, url: string, via: 'direct' | 'proxy'}>}
 */
export async function requestJson(options) {
  const reply = await request(options)
  let json
  try {
    json = JSON.parse(reply.text)
  } catch {
    throw new Error(`${maskUrl(reply.url)} answered ${String(reply.status)} with a non-JSON body: ${redactSecrets(reply.text).slice(0, 120)}`)
  }
  return { ...reply, json }
}
