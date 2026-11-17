/**
 * A loopback protocol gateway: one provider card, many wire protocols.
 *
 * The harness resolves one `api` per provider route, and a model entry carries
 * no protocol of its own (`catalog.ts` `resolveEntry`: `api = request.api ??
 * base?.api ?? routeApi`). So a provider whose catalogue spans Chat
 * Completions, Anthropic Messages and Responses can only offer one of them —
 * which is why the previous version of this plugin answered that with extra
 * provider keys, and why those keys showed up as extra cards in the official
 * picker. This server is the alternative: the route keeps a single `api` and
 * its baseURL points here, and the gateway speaks that one protocol towards the
 * harness while forwarding each model to the protocol it actually serves.
 *
 * Two forwarding paths:
 *
 *  - same protocol — bytes are proxied verbatim. Translation would only add
 *    ways to be wrong.
 *  - different protocol — the request is decoded to a canonical form, encoded
 *    for the upstream, and the upstream stream is decoded back into the
 *    caller's protocol (`./protocol.js`).
 *
 * Egress deliberately avoids `fetch`. In this profile `fetch` is rewritten by
 * the compression plugin and re-issued from a lane subprocess whose proxy
 * environment has been stripped, and whose body is rewritten on the way out
 * (an inbound chat request has already been through that rewrite once). A
 * second pass would double the injected system prompt, so the upstream call
 * goes out over `../http.js`'s raw socket with an explicit proxy instead.
 */

import http from 'node:http'

import { describeError, maskUrl, openStream, parseProxy } from '../http.js'

/** Bodies above this are refused: a chat request that big is a bug, not a conversation. */
export /** How much of an upstream error body is forwarded verbatim. */
const MAX_ERROR_BYTES = 64 * 1024

const MAX_REQUEST_BYTES = 32 * 1024 * 1024

/** How long an idle upstream connection is kept before the gateway gives up on it. */
const UPSTREAM_IDLE_MS = 180_000

/**
 * Protocols `./protocol.js` can translate between. Gemini is deliberately not
 * one of them: its payload carries the model id in the path and its stream is a
 * different envelope, so it is only ever passed through.
 */
export const TRANSLATABLE_PROTOCOLS = [
  'openai-completions',
  'anthropic-messages',
  'openai-responses',
  'google-generative-ai',
]

/** The model id inside a Gemini path tail. */
/** Append a path to a base without doubling a `/v1` both sides already carry. */
export function joinUpstreamPath(baseURL, tail) {
  const base = baseURL.replace(/\/+$/, '')
  const path = tail.startsWith('/') ? tail : `/${tail}`
  if (path.startsWith('/v1') && /\/v1$/i.test(base)) return `${base.slice(0, -3)}${path}`
  return `${base}${path}`
}

const GEMINI_MODEL = /(?:^|\/)models\/([^/:]+):(?:streamGenerateContent|generateContent|countTokens)$/i

/** `models/<id>:streamGenerateContent`, the shape pi-ai uses for Gemini. */
const GEMINI_TAIL = /(?:^|\/)models\/[^/:]+:(?:streamGenerateContent|generateContent|countTokens)$/i

/**
 * The path shape pi-ai produces for a baseURL of `http://127.0.0.1:<port>/g/<id>`.
 *
 * pi-ai concatenates, it does not resolve (`openai/client.js:471-478`), so the
 * tail carries whatever the adapter appends: `/chat/completions`,
 * `/v1/messages`, `/responses`. Every shape is accepted here and forwarded
 * unchanged on the passthrough path.
 *
 * @param {string} path
 * @returns {{routeId: string, tail: string} | undefined}
 */
export function splitGatewayPath(path) {
  const match = /^\/g\/([^/]+)\/(.+)$/.exec(path)
  if (match === null) return undefined
  try {
    return { routeId: decodeURIComponent(match[1]), tail: match[2] }
  } catch {
    // `GET /g/%/x` throws URIError. This runs inside the `http.createServer`
    // listener, where a synchronous throw is an uncaught exception: any local
    // process (or a no-cors fetch from a web page) could kill the host process
    // with one request. An unreadable route id is simply not a route.
    return undefined
  }
}

/**
 * Which protocol a path tail belongs to, for the sanity check that a request
 * arrived on the endpoint its route advertises.
 *
 * @param {string} tail
 * @returns {string | undefined}
 */
export function protocolOfTail(tail) {
  const text = tail.toLowerCase()
  // Checked first: a Gemini path also ends in neither `/messages` nor a bare
  // `/responses`, but this keeps the intent explicit rather than accidental.
  if (GEMINI_TAIL.test(tail)) return 'google-generative-ai'
  if (text.endsWith('/chat/completions') || text.endsWith('chat/completions')) return 'openai-completions'
  if (text === 'messages' || text.endsWith('/messages')) return 'anthropic-messages'
  if (text === 'responses' || text.endsWith('/responses')) return 'openai-responses'
  return undefined
}

/** Read a request body, refusing anything over `MAX_REQUEST_BYTES`. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_REQUEST_BYTES) {
        // Pause instead of destroying: a destroyed socket never delivers the
        // 413, so the caller saw `ECONNRESET` and retried a request that can
        // never succeed. The handler answers and closes afterwards.
        request.pause()
        reject(Object.assign(new Error('the gateway request body is too large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/**
 * Create the gateway. Nothing listens until `start()`.
 *
 * @param {object} options
 * @param {() => Map<string, {tap: string, upstreamBaseURL: string, apiKey?: string, headers?: Record<string, string>, models: Map<string, string>}>} options.routes
 *   Called per request so a route change never needs a restart.
 * @param {(host: string) => {host: string, port: number, auth?: string} | undefined} [options.proxyFor]
 * @param {(host: string) => boolean} [options.hostNeedsProxy] consulted only for logging/verification
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 */
export function createGateway(options) {
  const { routes, proxyFor, hostNeedsProxy, logger } = options
  /** @type {http.Server | undefined} */
  let server
  let listening = 0
  const stats = { requests: 0, passedThrough: 0, translated: 0, failures: 0, lastError: undefined, lastAt: undefined }

  function proxyForTarget(target) {
    const host = target.hostname
    if (typeof hostNeedsProxy === 'function' && hostNeedsProxy(host) !== true) return undefined
    const raw = typeof proxyFor === 'function' ? proxyFor(host) : undefined
    return raw === undefined ? undefined : parseProxy(raw)
  }

  async function forward(request, response, entry, routeId, tail, body) {
    // The tail may carry a query string (Gemini appends `?alt=sse`); the
    // endpoint shape is decided by the path alone.
    const inbound = protocolOfTail(tail.split('?')[0])
    if (inbound === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `unknown model endpoint "${tail}"` } }))
      return
    }

    let payload
    let json
    try {
      json = body.length === 0 ? undefined : JSON.parse(body.toString('utf8'))
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'the gateway received a non-JSON body' } }))
      return
    }

    // Gemini carries the model in the path (`models/<id>:streamGenerateContent`)
    // rather than in the body, so the routing key is read from wherever the
    // protocol actually puts it.
    const model = typeof json?.model === 'string'
      ? json.model
      : inbound === 'google-generative-ai' ? GEMINI_MODEL.exec(tail.split('?')[0])?.[1] : undefined
    if (model === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'the gateway needs a "model" field' } }))
      return
    }

    // A model the probe did not catalogue is assumed to speak what the caller
    // asked for: passthrough is the only choice that cannot corrupt a payload,
    // and inventing a protocol would turn a working request into a 501.
    const target = entry.models.get(model) ?? entry.tap ?? inbound
    const upstreamURL = joinUpstreamPath(entry.upstreamBaseURL, tail)
    const headers = { ...(entry.headers ?? {}) }
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase()
      if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'accept-encoding') continue
      headers[lower] = value
    }

    /** @type {string | undefined} */
    let sawError
    /** @type {import('../http.js').openStream extends Function ? any : any} */
    let upstream

    if (target !== inbound && (TRANSLATABLE_PROTOCOLS.includes(target) === false || TRANSLATABLE_PROTOCOLS.includes(inbound) === false)) {
      // Refusing beats guessing: a Gemini-shaped payload translated by hand would
      // fail deeper and less legibly than a 501 the panel can explain.
      stats.failures += 1
      response.writeHead(501, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: {
          message: `the gateway cannot translate ${inbound} to ${target}; only ${TRANSLATABLE_PROTOCOLS.join(', ')} can be rewritten`,
        },
      }))
      return
    }

    /**
     * The route's own auth beats the encoder's. Some providers speak a protocol
     * without authenticating the way that protocol's SDK does — opencode serves
     * `anthropic-messages` with a bearer token, so the encoder's `x-api-key`
     * would be answered with `401 OpenCode Go requires an API key`.
     */
    const routeAuth = entry.authHeaders ?? {}

    if (target === inbound) {
      payload = body
      stats.passedThrough += 1
      // The harness normally sends the provider's own header; when it does not
      // (a direct call, or a provider whose adapter reads its key elsewhere),
      // the route supplies it rather than letting the request die at 401.
      const hasAuth = headers['authorization'] !== undefined || headers['x-api-key'] !== undefined || headers['x-goog-api-key'] !== undefined
      if (hasAuth === false) Object.assign(headers, routeAuth)
    } else {
      const { decodeRequest, encodeRequest } = await import('./protocol.js')
      const canonical = decodeRequest(inbound, json)
      // Gemini's model lives in the URL, not the body, so the decoder cannot
      // know it. Leaving it empty makes every translated request fail upstream
      // with a 400 that does not mention the gateway.
      if (typeof canonical.model !== 'string' || canonical.model.length === 0) canonical.model = model
      const encoded = encodeRequest(target, canonical, {
        baseURL: entry.upstreamBaseURL,
        apiKey: entry.apiKey,
        headers,
      })
      payload = Buffer.from(encoded.body, 'utf8')
      // Encoder output first, route auth last: the route knows how this
      // particular upstream wants to be authenticated.
      for (const key of Object.keys(headers)) delete headers[key]
      Object.assign(headers, encoded.headers, routeAuth)
      headers['content-type'] = 'application/json'
      delete headers['content-length']
      stats.translated += 1
      upstream = encoded.url
    }

    const url = upstream ?? upstreamURL
    const reply = await openStream({
      url,
      method: 'POST',
      headers: { ...headers, 'accept-encoding': 'identity' },
      body: payload,
      proxy: proxyForTarget(new URL(url)),
      timeoutMs: UPSTREAM_IDLE_MS,
    })

    const status = reply.status
    // A provider answers errors as JSON on either path; the harness renders
    // that body, so it is forwarded rather than replaced with a summary.
    if (status < 200 || status >= 300) {
      const chunks = []
      let total = 0
      for await (const chunk of reply.chunks) {
        chunks.push(chunk)
        total += chunk.length
        // An error page can be megabytes of HTML, and this process is the same
        // one running the harness. Keep the part that carries the message.
        if (total >= MAX_ERROR_BYTES) break
      }
      reply.close()
      response.writeHead(status, { 'content-type': reply.headers['content-type'] ?? 'application/json' })
      response.end(Buffer.concat(chunks))
      return
    }

    /**
     * A caller that goes away must not keep an upstream stream alive: `write()`
     * on a dead response returns false, but no `drain` and no `end` ever
     * follows, so a loop that only waits for `drain` hangs forever and holds the
     * provider's socket open. Track `close` and stop.
     */
    let gone = false
    response.on('close', () => {
      gone = true
      // Closing the upstream is what actually ends the `for await`: checking
      // `gone` between chunks is not enough while the loop is parked waiting
      // for a chunk the provider may never send.
      reply.close()
    })
    const waitDrain = () =>
      new Promise((resolve) => {
        if (gone === true || response.writableEnded === true) {
          resolve()
          return
        }
        const settle = () => {
          response.off('drain', settle)
          response.off('close', settle)
          resolve()
        }
        response.on('drain', settle)
        response.on('close', settle)
      })

    const contentType = reply.headers['content-type'] ?? 'text/event-stream'
    /**
     * The encoder is built before the head is written: `writeHead` seals the
     * header set, so `setHeader` afterwards throws ERR_HTTP_HEADERS_SENT — and
     * the client would see an empty 200 instead of the stream.
     */
    /** @type {{decoder: any, encoder: any} | undefined} */
    let translator
    if (target !== inbound) {
      const { createStreamDecoder, createStreamEncoder } = await import('./protocol.js')
      translator = { decoder: createStreamDecoder(target), encoder: createStreamEncoder(inbound, { model }) }
    }
    response.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // The encoder's headers go last so a translated stream keeps its own
      // content type instead of inheriting the upstream's.
      ...(translator?.encoder.headers ?? {}),
    })

    try {
      if (target === inbound) {
        for await (const chunk of reply.chunks) {
          if (gone === true || response.writableEnded === true) break
          if (response.write(chunk) === false) await waitDrain()
        }
        if (gone !== true) response.end()
        return
      }

      if (translator === undefined) throw new Error('the translation state was not prepared')
      const { decoder, encoder } = translator
      const writer = async (frames) => {
        for (const frame of frames) {
          if (gone === true || response.writableEnded === true) return
          if (response.write(frame) === false) await waitDrain()
        }
      }
      /**
       * `push` takes one event at a time. Spreading a whole chunk's events into
       * it silently keeps only the first, which is how a stream arrives with a
       * `message_start` and no content.
       */
      const write = async (events) => {
        for (const event of events) await writer(encoder.push(event))
      }
      for await (const chunk of reply.chunks) {
        if (gone === true) break
        // Bytes, not text: `chunk.toString('utf8')` splits multi-byte characters
        // at TCP boundaries and the decoder's own streaming TextDecoder is the
        // only thing that can join them back together.
        await write(decoder.push(chunk))
      }
      if (gone !== true) {
        await writer(decoder.end())
        await writer([encoder.end()].flat())
        response.end()
      }
    } catch (error) {
      sawError = describeError(error)
      stats.failures += 1
      stats.lastError = sawError
      logger?.warn?.(`gateway: translating ${maskUrl(url)} failed: ${sawError}`)
      if (gone === true) return
      if (response.headersSent !== true) {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: `gateway translation failed: ${sawError}` } }))
      } else {
        response.end()
      }
    } finally {
      reply.close()
    }
  }

  const handler = (request, response) => {
    // Split on the pathname only: pi-ai appends `?alt=sse` to Gemini calls, and
    // a query string is part of what the upstream must receive, not of the
    // endpoint shape the gateway dispatches on.
    const requested = request.url ?? '/'
    const cut = requested.indexOf('?')
    const path = cut === -1 ? requested : requested.slice(0, cut)
    const query = cut === -1 ? '' : requested.slice(cut)
    stats.requests += 1
    stats.lastAt = Date.now()

    if (path === '/health' || path === '/g/health') {
      const table = routes()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        listening,
        routes: [...table.keys()],
        stats,
      }))
      return
    }

    const split = splitGatewayPath(path)
    if (split === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'the gateway only serves /g/<route>/<endpoint>' } }))
      return
    }

    const entry = routes().get(split.routeId)
    if (entry === undefined) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `no gateway route "${split.routeId}" is active` } }))
      return
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      response.end(JSON.stringify({ error: { message: 'the gateway only accepts POST' } }))
      return
    }

    readBody(request).then(
      (body) => forward(request, response, entry, split.routeId, split.tail + query, body).catch((error) => {
        stats.failures += 1
        stats.lastError = describeError(error)
        logger?.error?.(`gateway: ${stats.lastError}`)
        if (response.headersSent !== true) {
          response.writeHead(502, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: `gateway failure: ${stats.lastError}` } }))
        } else {
          response.end()
        }
      }),
      (error) => {
        const status = typeof error?.status === 'number' ? error.status : 400
        const tooLarge = status === 413
        response.writeHead(status, { 'content-type': 'application/json', ...(tooLarge ? { connection: 'close' } : {}) })
        response.end(JSON.stringify({ error: { message: describeError(error) } }), () => {
          // Now that the answer is on the wire, drop the rest of the body.
          if (tooLarge) request.destroy()
        })
      },
    )
  }

  /**
   * Listen on loopback. Port 0 asks the OS for a free one; the bili lane's own
   * port is refused because its tunnel rejects a destination that points back
   * at itself (`tunnel_destination_denied`), which would break every request.
   */
  async function start(preferredPort = 0, forbidden = []) {
    if (server !== undefined) return listening
    const s = http.createServer(handler)
    server = s
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      s.once('error', onError)
      s.listen(preferredPort, '127.0.0.1', () => {
        s.off('error', onError)
        resolve(undefined)
      })
    })
    const address = s.address()
    listening = typeof address === 'object' && address !== null ? address.port : preferredPort
    if (forbidden.includes(listening)) {
      await stop()
      throw new Error(`port ${String(listening)} is reserved by the compression lane; pick another`)
    }
    logger?.info?.(`gateway: listening on http://127.0.0.1:${String(listening)}`)
    return listening
  }

  async function stop() {
    const s = server
    server = undefined
    listening = 0
    if (s === undefined) return
    await new Promise((resolve) => {
      s.close(() => resolve(undefined))
      // A keep-alive client would otherwise hold the close for as long as it
      // likes; the gateway has no in-flight state worth draining.
      s.closeAllConnections?.()
    })
  }

  return {
    start,
    stop,
    get port() {
      return listening
    },
    get url() {
      return listening === 0 ? undefined : `http://127.0.0.1:${String(listening)}`
    },
    stats: () => ({ ...stats }),
  }
}
