/**
 * Reading a provider's authoritative model list from its own endpoint.
 *
 * The harness ships a discovery service (`ctx.llm.discoverModels`), but it is
 * the wrong tool for this job in two independent ways:
 *
 *  1. For any provider pi-ai ships a catalog for, it answers from the installed
 *     catalog and never touches the network. Upstream additions — exactly what
 *     this feature exists to surface — are therefore invisible.
 *  2. It issues its request through the global `fetch`, which in this profile is
 *     owned by another plugin's loopback lane with no proxy. A subscription
 *     model behind a blocked network can never be listed.
 *
 * So the endpoint shapes, the auth headers and the three known reply formats
 * are re-implemented here over `./http.js`, which lets every check choose its
 * own exit. The shapes are deliberately copied from
 * `@deepseek-ai/dsh-llm-pi-ai/src/discovery.ts` so a model id read here is the
 * same id the route will serve.
 */

import { maskUrl, requestJson } from './http.js'

/** Protocols this module can list, most likely first for an unknown endpoint. */
export const PROTOCOLS = ['openai-completions', 'anthropic-messages', 'google-generative-ai', 'openai-responses']

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page both public endpoints accept. */
const PAGE_LIMIT = 1000

/** Per-attempt budget while walking the protocol ladder. */
const ATTEMPT_TIMEOUT_MS = 8_000

/**
 * Join the endpoint base with the protocol's listing path.
 *
 * The base is treated as a prefix rather than a URL to resolve against, so a
 * deployment path such as `https://gateway.example/openai/v1` keeps its
 * segments. Anthropic publishes two spellings of the same root (with and
 * without one trailing `/v1`); only the listing URL normalizes it.
 *
 * @param {string} baseURL
 * @param {string} api
 * @returns {string}
 */
export function listingUrl(baseURL, api) {
  // The Messages endpoint is a path on the inference origin, while the
  // DeepSeek directory is at /models on that same origin.
  if (api === 'deepseek-models') return new URL('/models', new URL(baseURL).origin).href
  // A baseURL may carry a query string of its own (`https://gw.example/v1?key=…`).
  // Split it off first: appending the path to the whole string would produce
  // `/v1?key=…/models`, which no endpoint answers.
  const raw = String(baseURL).trim()
  const cut = raw.indexOf('?')
  const trimmed = (cut === -1 ? raw : raw.slice(0, cut)).replace(/\/+$/, '')
  const query = cut === -1 ? '' : raw.slice(cut + 1)

  const withQuery = (url) => {
    if (query.length === 0) return url
    return `${url}${url.includes('?') ? '&' : '?'}${query}`
  }

  if (api === 'google-generative-ai') {
    // Gemini's own baseURL carries the version segment (`/v1beta`). A bare
    // host is a common paste, so supply the default version instead of
    // failing with a bare 404.
    const base = /\/v\d+(?:beta|alpha)?\d*$/.test(trimmed) ? trimmed : `${trimmed}/v1beta`
    return withQuery(`${base}/models?pageSize=${String(PAGE_LIMIT)}`)
  }
  if (api !== 'anthropic-messages') return withQuery(`${trimmed}/models`)
  const root = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
  return withQuery(`${root}/v1/models?limit=${String(PAGE_LIMIT)}`)
}

/**
 * Auth headers for one protocol. Nothing is guessed: an endpoint that needs a
 * key and does not receive the right header answers 401, which the caller
 * reports as a credential problem rather than as "no models".
 * @param {string} api
 * @param {string | undefined} apiKey
 * @returns {Record<string, string>}
 */
export function authHeaders(api, apiKey) {
  const headers = { accept: 'application/json', 'accept-encoding': 'identity' }
  if (apiKey === undefined || apiKey.length === 0) return headers
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    headers['x-api-key'] = apiKey
    return headers
  }
  if (api === 'google-generative-ai') {
    headers['x-goog-api-key'] = apiKey
    return headers
  }
  headers.authorization = `Bearer ${apiKey}`
  return headers
}

/** First positive integer among the candidates. */
function capacity(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** First non-empty string among the candidates. */
function label(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Levels DSH can express as `reasoningEfforts` keys. */
const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * An upstream's own effort declaration, when it publishes one.
 *
 * OpenRouter is the only listing used here that exposes per-model supported
 * efforts today. The value is an *official* fact for this route, so the caller
 * may treat it as higher-confidence than the public models.dev fallback. A
 * provider that publishes only "reasoning: true" has not said which levels it
 * accepts; that must stay unknown rather than becoming a guessed default.
 *
 * @param {Record<string, unknown> | null} entry
 * @returns {Record<string, string> | undefined}
 */
function specifiedReasoning(entry) {
  const reasoning = entry?.reasoning
  if (reasoning === null || typeof reasoning !== 'object' || Array.isArray(reasoning)) return undefined
  const values = /** @type {any} */ (reasoning).supported_efforts
  if (!Array.isArray(values)) return undefined
  /** @type {Record<string, string>} */
  const efforts = {}
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const level = raw.trim().toLowerCase()
    if (REASONING_LEVELS.includes(level) && efforts[level] === undefined) efforts[level] = level
  }
  return Object.keys(efforts).length === 0 ? undefined : efforts
}

/** Normalize a model's creation stamp to epoch milliseconds when possible. */
function createdAt(entry) {
  const raw = entry?.created ?? entry?.created_at ?? entry?.createdAt
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // OpenAI and OpenRouter publish seconds; a millisecond stamp from a gateway
    // is large enough to tell apart without guessing at the value's semantics.
    return raw > 10_000_000_000 ? Math.trunc(raw) : Math.trunc(raw * 1000)
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Read a standard `GET /models` reply: either a `data` array (OpenAI and most
 * compatible gateways) or an enriched `models` object keyed by the id the
 * endpoint accepts. Entries without a usable id are skipped rather than
 * failing the whole listing.
 * @param {unknown} body
 * @returns {{id: string, name: string, contextWindow?: number, maxTokens?: number}[]}
 */
export function readListing(body) {
  const listing = /** @type {{data?: unknown, models?: unknown} | null} */ (body)
  const data = listing?.data
  /** @type {{key?: string, raw: unknown}[]} */
  let listed
  if (Array.isArray(data)) {
    listed = data.map((raw) => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new Error('the reply has neither a "data" array nor a "models" object')
    }
    // An id is enough to configure; a null payload only means this deployment
    // publishes no metadata for it, so the key is kept rather than dropped.
    listed = Object.entries(models)
      .filter(([, raw]) => !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  /** @type {{id: string, name: string, contextWindow?: number, maxTokens?: number}[]} */
  const models = []
  for (const { key, raw } of listed) {
    const entry = /** @type {Record<string, unknown> | null} */ (raw)
    const id = label(key, entry?.id)
    if (id === undefined) continue
    const limit = /** @type {Record<string, unknown> | null | undefined} */ (entry?.limit)
    const topProvider = /** @type {Record<string, unknown> | null | undefined} */ (entry?.top_provider)
    const contextWindow = capacity(
      entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, limit?.context,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens,
      limit?.output, topProvider?.max_completion_tokens,
    )
    const efforts = specifiedReasoning(entry)
    const created = createdAt(entry)
    models.push({
      id,
      name: label(entry?.name, entry?.display_name, entry?.displayName) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...efforts === undefined ? {} : { reasoningEfforts: efforts },
      ...created === undefined ? {} : { createdAt: created },
    })
  }
  return models
}

/**
 * Read a Gemini `GET /models` reply. Each entry's `name` is a resource name
 * (`models/gemini-2.5-pro`); the id the route serves is that name without the
 * prefix. Entries declaring generation methods without `generateContent`
 * (embeddings) cannot serve a conversation and are skipped.
 * @param {unknown} body
 * @returns {{id: string, name: string, contextWindow?: number, maxTokens?: number}[]}
 */
export function readGeminiListing(body) {
  const listed = /** @type {{models?: unknown} | null} */ (body)?.models
  if (!Array.isArray(listed)) throw new Error('the reply has no "models" array')
  /** @type {{id: string, name: string, contextWindow?: number, maxTokens?: number}[]} */
  const models = []
  for (const raw of listed) {
    const entry = /** @type {Record<string, unknown> | null} */ (raw)
    const methods = entry?.supportedGenerationMethods
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue
    const id = label(entry?.name)?.replace(/^models\//, '')
    if (id === undefined || id.length === 0) continue
    const contextWindow = capacity(entry?.inputTokenLimit)
    const maxTokens = capacity(entry?.outputTokenLimit)
    models.push({
      id,
      name: label(entry?.displayName) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/** Parse a reply for `api`, returning models in endpoint order. */
function parse(api, body) {
  if (api === 'deepseek-models') {
    if (!Array.isArray(body?.data)) throw new Error('the DeepSeek directory has no "data" array')
    const byId = new Map()
    for (const entry of body.data) {
      const id = label(entry?.id)
      if (id !== undefined && !byId.has(id)) byId.set(id, entry)
    }
    return readListing({ data: [...byId.values()] }).map((model) => {
      const entry = byId.get(model.id)
      const messages = entry.api_capabilities?.anthropic_messages
      const inputModalities = entry.input_modalities === undefined ? ['text']
        : [...new Set(Array.isArray(entry.input_modalities) ? entry.input_modalities.filter((value) => value === 'text' || value === 'image') : [])]
      const textOutput = entry.output_modalities === undefined
        || (Array.isArray(entry.output_modalities) && entry.output_modalities.includes('text'))
      return {
        ...model,
        ...(messages && typeof messages === 'object' && !Array.isArray(messages) && textOutput && inputModalities.length > 0
          ? { inputModalities } : { blocked: '上游未声明适用于此路由的 Messages 能力' }),
        ...(messages?.system_prompt_update === 'in-history' ? { systemPromptUpdate: 'in-history' } : {}),
        ...(['in-history', 'addition-only'].includes(messages?.tool_update) ? { toolUpdate: messages.tool_update } : {}),
        ...(typeof entry.description === 'string' && entry.description.trim() ? { description: entry.description.trim() } : {}),
      }
    })
  }
  return api === 'google-generative-ai' ? readGeminiListing(body) : readListing(body)
}

/**
 * List one endpoint with one protocol. No fallback happens here; the caller
 * decides which protocol is worth trying next.
 *
 * @param {object} options
 * @param {string} options.baseURL
 * @param {string} options.api
 * @param {string} [options.apiKey]
 * @param {Record<string, string>} [options.headers] extra deployment headers
 * @param {{host: string, port: number, auth?: string}} [options.proxy]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.cursor]
 */
export async function listOnce(options) {
  const { baseURL, api, apiKey, headers, proxy, timeoutMs = ATTEMPT_TIMEOUT_MS, signal } = options
  const initial = listingUrl(baseURL, api)
  const param = api === 'google-generative-ai' ? 'pageToken' : 'after_id'
  const url = options.cursor === undefined ? initial : `${initial}${initial.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(options.cursor)}`
  const reply = await requestJson({
    url,
    headers: { ...authHeaders(api, apiKey), ...headers },
    proxy,
    timeoutMs,
    signal,
  })
  if (reply.status < 200 || reply.status >= 300) {
    const hint = reply.status === 401 || reply.status === 403 ? '; check the API key' : ''
    // `maskUrl` keeps `?key=`-style secrets out of the state file and the panel.
    throw new Error(`${maskUrl(url)} answered ${String(reply.status)}${hint}`)
  }
  return {
    models: parse(api, reply.json),
    complete: reply.json?.has_more !== true && !reply.json?.nextPageToken,
    next: api === 'google-generative-ai' ? label(reply.json?.nextPageToken)
      : api === 'anthropic-messages' && reply.json?.has_more === true ? label(reply.json?.last_id) : undefined,
    url,
    via: reply.via,
  }
}

/**
 * Walk a protocol ladder until one answers with a usable listing.
 *
 * A provider's protocol is not always knowable from configuration: pi-ai's own
 * route table knows it, but its `LlmConfigurableProvider` entries do not
 * expose it, and a hand-written route may leave `api` unset. Rather than
 * guessing once and failing every day, the caller passes a preference order
 * and this function stops at the first protocol that produces models. A 401
 * and a shape error are both simply "not this protocol, try the next one";
 * only when every candidate fails is the aggregated reason reported.
 *
 * @param {object} options
 * @param {string} options.baseURL
 * @param {string[]} options.candidates preference order, most likely first
 * @param {string} [options.apiKey]
 * @param {Record<string, string>} [options.headers]
 * @param {{host: string, port: number, auth?: string}} [options.proxy]
 * @param {number} [options.timeoutMs] per attempt
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{models: {id: string, name: string, contextWindow?: number, maxTokens?: number}[], api: string, url: string, via: 'direct' | 'proxy', attempts: {api: string, ok: boolean, reason?: string}[]}>}
 */
/**
 * Whether a failure is the network wobbling rather than the endpoint answering.
 *
 * Something like one request in four through a local HTTP proxy dies during the
 * TLS handshake (`Client network socket disconnected before secure TLS
 * connection was established`) and the very next one succeeds. Treating that as
 * "this protocol is wrong" turns a working route into a red card, so the ladder
 * retries those once before moving on. A 4xx is an answer, not a wobble.
 *
 * URLs are stripped before matching: a host named `…timeout…` must not make
 * every request look transient.
 * @param {string} reason
 * @returns {boolean}
 */
export function isTransientFailure(reason) {
  const text = String(reason ?? '').replace(/https?:\/\/\S+/g, ' ')
  return /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|EADDRNOTAVAIL|TLS handshake|Client network socket disconnected|socket hang up|socket closed|connection closed|could not reach|no reply within|answered 5\d\d|timed out|timeout|aborted/i.test(text)
}

/**
 * One listing attempt with a single retry for transient failures.
 * @param {Parameters<typeof listOnce>[0]} options
 * @param {number} [retries]
 * @returns {ReturnType<typeof listOnce>}
 */
async function attemptListing(options, retries = 1) {
  let last
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await listOnce(options)
    } catch (error) {
      last = error
      const transient = isTransientFailure(error instanceof Error ? error.message : String(error))
      if (transient !== true || attempt === retries || options.signal?.aborted === true) throw error
    }
  }
  throw last
}

async function listPages(options) {
  const result = await attemptListing(options)
  if (result.complete || !result.next) return result
  const { timeoutMs, signal } = options
  const models = new Map(result.models.map((model) => [model.id, model]))
  const cursors = new Set()
  const deadline = Date.now() + (timeoutMs ?? ATTEMPT_TIMEOUT_MS)
  let page = result
  while (!page.complete && page.next && !cursors.has(page.next) && !signal?.aborted) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    cursors.add(page.next)
    const next = await attemptListing({ ...options, cursor: page.next, timeoutMs: remaining }, 0)
      .catch(() => undefined)
    if (!next) break
    for (const model of next.models) if (!models.has(model.id)) models.set(model.id, model)
    page = next
  }
  return { ...result, models: [...models.values()], complete: page.complete }
}

export async function listModels(options) {
  const { baseURL, candidates, apiKey, headers, proxy, timeoutMs, signal } = options
  /** @type {{api: string, ok: boolean, reason?: string}[]} */
  const attempts = []
  for (const api of candidates) {
    if (signal?.aborted === true) break
    try {
      const result = await listPages({ baseURL, api, apiKey, headers, proxy, timeoutMs, signal })
      if (result.models.length === 0) {
        // `{"data":[]}` is not "this protocol works": endpoints that do not
        // implement listing answer exactly that. Accepting it would set the
        // protocol, report zero upstream models, and mark every configured id
        // as gone — a full deletion shown as "up to date".
        attempts.push({ api, ok: false, reason: 'answered an empty listing (the endpoint may not implement listing)' })
        continue
      }
      attempts.push({ api, ok: true })
      return { ...result, api, attempts }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      attempts.push({ api, ok: false, reason })
    }
  }
  const summary = attempts.map((attempt) => `${attempt.api}: ${attempt.reason ?? 'failed'}`).join(' | ')
  throw new Error(`no protocol answered a model listing at ${maskUrl(baseURL)} (${summary})`)
}

/**
 * Order the ladder for one route: an explicitly configured protocol wins, then
 * a remembered winner, then the caller's hints, then the generic defaults.
 * @param {{configured?: string, remembered?: string, hints?: readonly string[]}} input
 * @returns {string[]}
 */
export function protocolLadder(input) {
  const ordered = []
  const push = (api) => {
    if (typeof api !== 'string' || api.length === 0) return
    if (api === 'generative') api = 'google-generative-ai'
    if (PROTOCOLS.includes(api) && !ordered.includes(api)) ordered.push(api)
  }
  push(input.configured)
  push(input.remembered)
  for (const hint of input.hints ?? []) push(hint)
  for (const api of PROTOCOLS) push(api)
  return ordered
}

/**
 * Ask every candidate protocol for its listing, then decide which protocol
 * each model actually belongs to.
 *
 * The single-listing path above is enough to populate a panel, but it cannot
 * answer "what does `foo-9` speak?" — and that question decides whether a model
 * can be added to a mixed route at all. Guessing from the model's name is not a
 * decision anyone should ship, so the answer comes from the providers
 * themselves: a model that only the Anthropic endpoint publishes is an
 * Anthropic model.
 *
 * Two subtleties:
 *
 *  - Several endpoints may publish the same id (an OpenAI-compatible gateway
 *    often mirrors everything). The result then carries every claimant, and
 *    `attribution` falls back to `prefer` — the route's own protocol — because
 *    that is the choice that costs nothing if the model is really the other
 *    one: it already works that way today.
 *  - The attempts run concurrently. Sequential probing would multiply the
 *    check's latency by the number of protocols for no benefit.
 *
 * @param {object} options
 * @param {string} options.baseURL
 * @param {string[]} options.candidates
 * @param {string} [options.apiKey]
 * @param {Record<string, string>} [options.headers]
 * @param {{host: string, port: number, auth?: string}} [options.proxy]
 * @param {number} [options.timeoutMs] per attempt
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.prefer] order used to break ties
 * @returns {Promise<{
 *   listings: {api: string, models: {id: string, name: string}[], url: string, via: string}[],
 *   attribution: Map<string, string>,
 *   claimants: Map<string, string[]>,
 *   attempts: {api: string, ok: boolean, count?: number, reason?: string}[],
 * }>}
 */
export async function listAll(options) {
  const { baseURL, candidates, apiKey, headers, proxy, timeoutMs, signal, prefer = [] } = options
  // `openai-responses` and `openai-completions` list from the same URL, so
  // probing both is two requests for one answer — visible as double rate-limit
  // use, and as a phantom "two protocols speak here" signal.
  /** @type {Map<string, string[]>} */
  const byURL = new Map()
  for (const api of candidates) {
    const url = listingUrl(baseURL, api)
    const group = byURL.get(url)
    if (group === undefined) byURL.set(url, [api])
    else group.push(api)
  }
  const probed = [...byURL.values()].map((group) => group[0])
  /** @type {Map<string, string[]>} */
  const sameEndpoint = new Map()
  for (const group of byURL.values()) {
    for (const api of group.slice(1)) sameEndpoint.set(api, [group[0]])
  }
  const settled = await Promise.all(probed.map(async (api) => {
    if (signal?.aborted === true) return { api, ok: false, reason: 'aborted' }
    try {
      const result = await listPages({ baseURL, api, apiKey, headers, proxy, timeoutMs, signal })
      return { api, ok: true, result }
    } catch (error) {
      return { api, ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }))

  const listings = []
  const attempts = []
  const claimants = new Map()
  for (const entry of settled) {
    if (entry.ok === true && entry.result !== undefined && entry.result.models.length === 0) {
      // Same rule as `listModels`: an empty listing is an endpoint that does
      // not implement listing, not a protocol that serves nothing.
      attempts.push({ api: entry.api, ok: false, reason: 'answered an empty listing (the endpoint may not implement listing)' })
      continue
    }
    if (entry.ok === true && entry.result !== undefined) {
      listings.push({ api: entry.api, models: entry.result.models, url: entry.result.url, via: entry.result.via })
      attempts.push({ api: entry.api, ok: true, count: entry.result.models.length })
      for (const model of entry.result.models) {
        const list = claimants.get(model.id) ?? []
        if (!list.includes(entry.api)) list.push(entry.api)
        claimants.set(model.id, list)
      }
    } else {
      attempts.push({ api: entry.api, ok: false, reason: entry.reason })
    }
  }
  for (const [api, [first]] of sameEndpoint) {
    attempts.push({ api, ok: false, reason: `shares its listing endpoint with ${first}, so it was not asked twice` })
  }

  const order = [...prefer, ...candidates]
  const attribution = new Map()
  for (const [id, claimantsForId] of claimants) {
    const preferred = order.find((api) => claimantsForId.includes(api))
    attribution.set(id, preferred ?? claimantsForId[0])
  }

  if (listings.length === 0) {
    const summary = attempts.map((attempt) => `${attempt.api}: ${attempt.reason ?? 'failed'}`).join(' | ')
    throw new Error(`no protocol answered a model listing at ${maskUrl(baseURL)} (${summary})`)
  }
  return { listings, attribution, claimants, attempts }
}
