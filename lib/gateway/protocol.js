/**
 * Translating pi-ai's wire formats into each other.
 *
 * pi-ai never translates: a route declares one `api`, and every request it
 * builds is already shaped for that api. Serving a model that belongs to a
 * *different* api therefore needs a layer that sits in the middle:
 *
 *     inbound body ──decodeRequest──▶ canonical request ──encodeRequest──▶ upstream body
 *     upstream SSE ──createStreamDecoder──▶ canonical events ──createStreamEncoder──▶ inbound SSE
 *
 * Three invariants keep that honest:
 *
 *  1. **Nothing here does I/O.** No fetch or files. Every mapping is deterministic.
 *    Replaying a request produces a byte-identical upstream body and the same synthesized tool-call ids.
 *  2. **The same protocol is a pass-through.** decode→encode on the identity
 *    mapping reproduces the original body, which is why the canonical form
 *    keeps thinking blocks and raw argument *strings* instead of parsing them.
 *  3. **Degrade, never throw.** An unknown protocol name is the only error. A
 *    field the target cannot express — a thinking signature from another
 *    vendor, `cache_control`, `metadata.user_id`, an http-form image — is
 *    dropped or flattened. A request that reaches the model with one hint
 *    missing beats a request the provider rejects with a 400.
 *
 * The canonical shapes are the ones documented in
 * `.analysis-model-sync/05-pi-ai-wire.md`; the field names below are copied
 * from the emitter/consumer in
 * `@earendil-works/pi-ai/dist/api/{openai-completions,anthropic-messages,openai-responses}.js`,
 * not from the public docs, because the two disagree in places that matter
 * (a responses item id must start with `fc_`, an anthropic thinking block with
 * an empty signature is downgraded to text, `prompt_tokens` includes the cache
 * while `input_tokens` does not).
 */

import { PROTOCOLS } from './protocols.js'

export { PROTOCOLS }

/** Anthropic version pinned by pi-ai's client; the API rejects requests without it. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic requires `max_tokens`; this is what pi-ai falls back to for a model with no declared cap. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

/** Tokens kept free for the answer when a thinking budget shares the response ceiling. */
const MIN_ANSWER_TOKENS = 1024

/** pi-ai's own effort→budget table (`PI/dist/api/simple-options.js:45-50`). */
const EFFORT_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }

/** pi-ai clamps `max_output_tokens` to this floor before sending (`openai-responses.js:16`). */
const RESPONSES_MIN_OUTPUT_TOKENS = 16

/** Anthropic's documented limit on a tool id / tool_use_id. */
const MAX_TOOL_ID = 64

/** Anthropic's documented charset for a tool id. */
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

/** Block types whose payload lives in a `text` field. */
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text', 'summary_text'])

/** A data URL, which is the only image carriage way pi-ai emits. */
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s

/** Headers every SSE reply needs so a proxy does not sit on the first bytes. */
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Reject an api name this module cannot speak. Together with a body that is not
 * JSON at all, this is the only thing that throws: a routing mistake must be
 * loud, while a field the target cannot express must not be.
 * @param {string} protocol
 */
function assertProtocol(protocol) {
  if (!PROTOCOLS.includes(protocol)) throw new Error(`unsupported protocol: ${String(protocol)}`)
}

/** A plain object, or `undefined` for anything else (arrays included). */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** An array, or an empty one. */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** A finite number, or the fallback. */
function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A non-empty string, or `undefined`. */
function strOr(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** First non-empty string among `keys` on `source`. */
function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Error kinds that mean "ask again later" rather than "fix the request".
 *
 * A gateway that retries a 400 burns the caller's time; one that gives up on a
 * 529 costs them a request. The list is the union of the three dialects' own
 * vocabulary, so the caller can stay protocol-agnostic.
 */
const RETRYABLE_ERROR_KINDS = new Set([
  'overloaded_error',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'rate_limit',
  'rate_limit_exceeded',
  'server_error',
  'service_unavailable',
  'internal_error',
])

/**
 * Whether a failed upstream call is worth repeating.
 *
 * The status decides when there is one; an in-stream error frame has no status,
 * so its own `type`/`code` is the only evidence available.
 *
 * @param {number|undefined} status
 * @param {...(string|number|undefined)} kinds
 * @returns {boolean}
 */
function retryableFor(status, ...kinds) {
  if (typeof status === 'number' && Number.isFinite(status) && status > 0) {
    return status === 408 || status === 409 || status === 429 || status >= 500
  }
  for (const kind of kinds) {
    if (typeof kind === 'string' && RETRYABLE_ERROR_KINDS.has(kind)) return true
  }
  return false
}

/** `stop` / `stop_sequences` accept one string or a list; the canonical form keeps a list. */
function normalizeStop(value) {  if (typeof value === 'string') return value.length > 0 ? [value] : undefined
  const list = asArray(value).filter((entry) => typeof entry === 'string' && entry.length > 0)
  return list.length > 0 ? list : undefined
}

/**
 * Deterministic short hash, the same construction pi-ai uses for the ids it
 * synthesizes. Two 32-bit lanes make a collision inside one conversation
 * implausible, and base36 keeps the result inside Anthropic's 64-char budget.
 * @param {string} input
 * @returns {string}
 */
function stableHash(input) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}

/**
 * True when an id already satisfies Anthropic's `[a-zA-Z0-9_-]{0,64}` rule.
 * @param {unknown} value
 * @returns {boolean}
 */
function isLegalToolId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOOL_ID && TOOL_ID_PATTERN.test(value)
}

/**
 * Map a tool-call id to something the target accepts.
 *
 * A legal id is passed through untouched: that is what makes a same-protocol
 * request byte-identical, and what keeps a provider's own id (`toolu_…`,
 * `call_…`) recognisable in a transcript. An illegal one — a responses
 * `"{call_id}|{item_id}"` composite, an id with a dot or a colon, an id over 64
 * chars, or no id at all — is replaced by `call_` plus a hash of the original.
 *
 * The replacement is a pure function of the input, so the tool call and the
 * tool result that answers it always land on the same id, and replaying a
 * request replays the same ids.
 *
 * @param {unknown} value
 * @param {...unknown} fallbackSeed used only when the id itself is absent
 * @returns {string}
 */
function mappedToolId(value, ...fallbackSeed) {
  if (isLegalToolId(value)) return String(value)
  const seed = strOr(value) ?? (fallbackSeed.length > 0 ? fallbackSeed.join('\u0000') : 'tool-call')
  return `call_${stableHash(seed)}`
}

/**
 * The `fc_…` item id a responses request wants alongside `call_id`.
 *
 * pi-ai refuses to send an item id that does not carry the `fc_` prefix, and
 * drops it otherwise. Deriving it from the call id keeps a replayed transcript
 * stable without inventing state.
 * @param {string} callId
 * @returns {string}
 */
function itemIdFor(callId) {
  return `fc_${stableHash(`item:${callId}`)}`
}

/** Split a `data:` URL into its media type and payload. */
function splitDataUrl(url) {
  const match = typeof url === 'string' ? DATA_URL_PATTERN.exec(url) : null
  if (match === null) return undefined
  return { mediaType: match[1], dataBase64: match[2] }
}

/** Build the `data:` URL the two OpenAI formats want for an image part. */
function dataUrlOf(part) {
  const mediaType = strOr(part.mediaType) ?? 'image/png'
  return `data:${mediaType};base64,${String(part.dataBase64 ?? '')}`
}

/**
 * Flatten an OpenAI-style `content` (string or block array) to plain text.
 * Used for system prompts and tool results, where the target has room for one
 * string and nothing else.
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === 'string') return content
  const texts = []
  for (const raw of asArray(content)) {
    const block = asObject(raw)
    if (!block) continue
    if (typeof block.text === 'string' && (block.type === undefined || TEXT_BLOCK_TYPES.has(block.type))) {
      texts.push(block.text)
    } else if (typeof block.refusal === 'string' && block.type === 'refusal') {
      texts.push(block.refusal)
    }
  }
  return texts.join('\n')
}

/**
 * Turn any of the three protocols' message content into canonical parts.
 *
 * The shapes are told apart by block `type`, which is disjoint across the
 * three formats (`text`/`image_url` for completions, `text`/`image`/`tool_use`
 * for anthropic, `input_text`/`input_image`/`output_text` for responses), so
 * one reader serves all three decoders.
 *
 * @param {unknown} content
 * @returns {object[]} canonical parts
 */
function contentParts(content) {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  const parts = []
  for (const raw of asArray(content)) {
    const block = asObject(raw)
    if (!block) continue
    const type = block.type
    if (typeof block.text === 'string' && (type === undefined || TEXT_BLOCK_TYPES.has(type))) {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (type === 'refusal' && typeof block.refusal === 'string' && block.refusal.length > 0) {
      parts.push({ type: 'text', text: block.refusal })
      continue
    }
    if (type === 'image_url') {
      // completions: `{ image_url: { url } }` (and the occasional bare string).
      const holder = asObject(block.image_url)
      const url = typeof block.image_url === 'string' ? block.image_url : holder?.url
      const image = splitDataUrl(url)
      // An http(s) image URL has no canonical form: pi-ai only ever emits a
      // data URL, and of the three targets only two accept a remote fetch, so
      // the part is dropped rather than silently upgraded into a fetch.
      if (image) parts.push({ type: 'image', ...image })
      continue
    }
    if (type === 'input_image') {
      const image = splitDataUrl(block.image_url)
      if (image) parts.push({ type: 'image', ...image })
      continue
    }
    if (type === 'image') {
      // anthropic: `{ source: { type: 'base64', media_type, data } }`.
      const source = asObject(block.source)
      if (source?.type === 'base64' && typeof source.data === 'string') {
        parts.push({ type: 'image', mediaType: strOr(source.media_type) ?? 'image/png', dataBase64: source.data })
      }
      continue
    }
  }
  return parts
}

/**
 * Append a message to a transcript, merging into the previous message when the
 * role is unchanged.
 *
 * Merging matters: anthropic forbids a user message that answers tools from
 * being split in two, and pi-ai itself merges consecutive tool results
 * (`anthropic-messages.js:1036-1043`).
 * @param {{role: string, parts: object[]}[]} messages
 * @param {string} role
 * @param {object[]} parts
 */
function appendMessage(messages, role, parts) {
  if (parts.length === 0) return
  const last = messages.at(-1)
  if (last && last.role === role) last.parts.push(...parts)
  else messages.push({ role, parts: [...parts] })
}

/** Drop trailing/leading slashes and split off a query the base may carry. */
function splitBase(baseURL) {
  const raw = String(baseURL ?? '').trim()
  const cut = raw.indexOf('?')
  return {
    path: (cut === -1 ? raw : raw.slice(0, cut)).replace(/\/+$/, ''),
    query: cut === -1 ? '' : raw.slice(cut + 1),
  }
}

/**
 * Join a base URL with a protocol path the way pi-ai does: plain string
 * concatenation, with no `/v1` inserted and no path resolution.
 *
 * A base may carry its own query string (`https://gw.example/v1?key=…`);
 * appending the path to the whole string would produce `/v1?key=…/messages`,
 * which nothing answers, so the query is set aside and restored last.
 *
 * @param {string} baseURL
 * @param {string} path
 * @returns {string}
 */
function joinEndpoint(baseURL, path) {
  const { path: base, query } = splitBase(baseURL)
  return query.length > 0 ? `${base}${path}?${query}` : `${base}${path}`
}

/**
 * The bare origin Anthropic's client expects.
 *
 * `POST {base}/v1/messages` is a string concatenation, so a base that already
 * ends in `/v1` produces `/v1/v1/messages`. pi-ai's own default base is the
 * bare origin precisely for this reason, and the gateway must accept either
 * spelling.
 * @param {string} baseURL
 * @returns {string}
 */
function anthropicEndpoint(baseURL) {
  const { path: base, query } = splitBase(baseURL)
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  const url = `${root}/v1/messages`
  return query.length > 0 ? `${url}?${query}` : url
}

/**
 * Gemini's streaming endpoint puts both the model and the method in the path,
 * and needs `alt=sse` or the provider answers with one buffered JSON body.
 * @param {string} baseURL
 * @param {string} model
 * @returns {string}
 */
function geminiEndpoint(baseURL, model) {
  const { path: base, query } = splitBase(baseURL)
  const id = String(model ?? '').length > 0 ? `/${String(model)}` : ''
  const url = `${base}/models${id}:streamGenerateContent`
  const params = [query, 'alt=sse'].filter((part) => part.length > 0).join('&')
  return params.length > 0 ? `${url}?${params}` : url
}

// ---------------------------------------------------------------------------
// Thinking budgets
// ---------------------------------------------------------------------------

/** `thinking` is present on the canonical request at all. Adaptive counts. */
function hasThinking(request) {
  return asObject(request.thinking) !== undefined
}

/**
 * Budget a canonical `thinking` asks for, with the docs' 1024 floor.
 *
 * `undefined` means the amount is not ours to pick: an `adaptive` request says
 * "think, the model decides how much", and there is no number to hand a format
 * that only speaks budgets.
 */
function thinkingBudget(request) {
  const thinking = asObject(request.thinking)
  if (!thinking || thinking.adaptive === true) return undefined
  const explicit = numOr(thinking.budgetTokens, 0)
  if (explicit > 0) return explicit
  return budgetForEffort(thinking.effort) ?? EFFORT_BUDGETS.minimal
}

/**
 * The canonical request named a budget itself rather than an effort level.
 *
 * The distinction matters when the budget has to fit under `max_tokens`: an
 * effort is only a hint, so the ceiling can grow to hold it, but a budget the
 * caller declared is a number they picked and only `max_tokens` gives way.
 */
function thinkingBudgetIsDeclared(request) {
  return numOr(asObject(request.thinking)?.budgetTokens, 0) > 0
}

/**
 * The effort level a target that only speaks effort should receive.
 *
 * The caller's own string is preferred so a pass-through route hands back
 * exactly the level it was given; a bare budget is graded through pi-ai's table.
 */
function thinkingEffort(request) {
  const thinking = asObject(request.thinking)
  if (!thinking) return undefined
  if (budgetForEffort(thinking.effort) !== undefined) return thinking.effort
  return effortForBudget(thinkingBudget(request))
}

/** Invert pi-ai's effort table for the two formats that only speak effort. */
function effortForBudget(budget) {
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return 'medium'
  if (budget <= EFFORT_BUDGETS.minimal) return 'minimal'
  if (budget <= EFFORT_BUDGETS.low) return 'low'
  if (budget <= EFFORT_BUDGETS.medium) return 'medium'
  return 'high'
}

/** Map an effort string onto the canonical budget, or `undefined` for "off". */
function budgetForEffort(effort) {
  if (typeof effort !== 'string') return undefined
  const key = effort === 'xhigh' || effort === 'max' ? 'high' : effort
  if (key === 'none' || key === 'off' || key.length === 0) return undefined
  return EFFORT_BUDGETS[key]
}

// ---------------------------------------------------------------------------
// Request decoding — inbound body → canonical request
// ---------------------------------------------------------------------------

/**
 * Read an `openai-completions` body.
 *
 * Shape notes that are not obvious from the public docs:
 *  - `messages[0]` may be `system` *or* `developer`, depending on whether the
 *    route advertises a reasoning model.
 *  - A tool result is its own `{role:'tool'}` message, not part of a user turn.
 *  - Assistant reasoning is replayed in a field named after the thinking
 *    block's signature; `reasoning_content` is the default, `reasoning` and
 *    `reasoning_text` are the alternatives pi-ai accepts.
 *
 * @param {Record<string, any>} body
 * @returns {object} canonical request
 */
function decodeCompletionsRequest(body) {
  const messages = []
  const systemParts = []

  for (const raw of asArray(body.messages)) {
    const message = asObject(raw)
    if (!message) continue
    const role = message.role
    if (role === 'system' || role === 'developer') {
      const text = contentText(message.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (role === 'tool') {
      appendMessage(messages, 'user', [{
        type: 'tool-result',
        id: String(message.tool_call_id ?? ''),
        resultJson: contentText(message.content),
        ...(message.is_error === true ? { isError: true } : {}),
      }])
      continue
    }
    if (role === 'assistant') {
      const parts = []
      const reasoning = firstString(message, ['reasoning_content', 'reasoning', 'reasoning_text'])
      if (reasoning) parts.push({ type: 'thinking', text: reasoning })
      const text = contentText(message.content)
      if (text.length > 0) parts.push({ type: 'text', text })
      for (const rawCall of asArray(message.tool_calls)) {
        const call = asObject(rawCall)
        if (!call) continue
        const fn = asObject(call.function) ?? {}
        parts.push({
          type: 'tool-call',
          id: String(call.id ?? ''),
          name: String(fn.name ?? ''),
          // Kept verbatim: the fragments were concatenated by the provider and
          // re-serialising a parsed object would reorder keys and re-escape.
          argsJson: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        })
      }
      appendMessage(messages, 'assistant', parts)
      continue
    }
    appendMessage(messages, 'user', contentParts(message.content))
  }

  const request = {
    model: String(body.model ?? ''),
    messages,
    tools: decodeCompletionsTools(body.tools),
    stream: true,
  }
  if (systemParts.length > 0) request.system = systemParts.join('\n\n')
  const maxTokens = numOr(body.max_tokens, numOr(body.max_completion_tokens, undefined))
  if (maxTokens !== undefined) request.maxTokens = maxTokens
  const temperature = numOr(body.temperature, undefined)
  if (temperature !== undefined) request.temperature = temperature
  const topP = numOr(body.top_p, undefined)
  if (topP !== undefined) request.topP = topP
  const stop = normalizeStop(body.stop)
  if (stop) request.stop = stop
  const thinking = decodeCompletionsThinking(body)
  if (thinking) request.thinking = thinking
  return request
}

/** Tools arrive wrapped in `{type:'function', function:{…}}`. */
function decodeCompletionsTools(tools) {
  const decoded = []
  for (const raw of asArray(tools)) {
    const tool = asObject(raw)
    const fn = asObject(tool?.function)
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) continue
    decoded.push({
      name: fn.name,
      ...(strOr(fn.description) ? { description: fn.description } : {}),
      parameters: asObject(fn.parameters) ?? { type: 'object', properties: {} },
    })
  }
  return decoded
}

/**
 * Reasoning is expressed per provider: an effort string for OpenAI, a
 * `{type:'enabled'}` object for DeepSeek/Z.ai, `enable_thinking` for Qwen. All
 * of them mean "think", and the canonical form keeps an effort string as an
 * effort so a pass-through route hands back the same level instead of a budget
 * that only approximates it.
 */
function decodeCompletionsThinking(body) {
  const direct = asObject(body.thinking)
  if (direct?.type === 'enabled') {
    const budget = numOr(direct.budget_tokens, undefined)
    return budget === undefined ? {} : { budgetTokens: budget }
  }
  if (body.enable_thinking === true) return {}
  const template = asObject(body.chat_template_kwargs)
  if (template?.enable_thinking === true) return {}
  // An unknown level is dropped rather than guessed at.
  if (budgetForEffort(body.reasoning_effort) === undefined) return undefined
  return { effort: body.reasoning_effort }
}

/**
 * Read an `anthropic-messages` body.
 *
 * `system` is a top-level block array rather than a message; a tool result is
 * a `tool_result` block inside a *user* message; `tool_use.input` is an already
 * parsed object, which the canonical form turns back into a string so the
 * target can re-serialise it in its own dialect.
 *
 * @param {Record<string, any>} body
 * @returns {object} canonical request
 */
function decodeAnthropicRequest(body) {
  const messages = []
  for (const raw of asArray(body.messages)) {
    const message = asObject(raw)
    if (!message) continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const parts = []
    if (typeof message.content === 'string') {
      if (message.content.length > 0) parts.push({ type: 'text', text: message.content })
    } else {
      for (const rawBlock of asArray(message.content)) {
        const block = asObject(rawBlock)
        if (!block) continue
        switch (block.type) {
          case 'text':
            if (typeof block.text === 'string' && block.text.length > 0) parts.push({ type: 'text', text: block.text })
            break
          case 'image': {
            const source = asObject(block.source)
            if (source?.type === 'base64' && typeof source.data === 'string') {
              parts.push({ type: 'image', mediaType: strOr(source.media_type) ?? 'image/png', dataBase64: source.data })
            }
            // A `url` source is fetched by Anthropic itself; neither OpenAI
            // format can express that without the gateway fetching it, which
            // this module is not allowed to do.
            break
          }
          case 'tool_use':
            parts.push({
              type: 'tool-call',
              id: String(block.id ?? ''),
              name: String(block.name ?? ''),
              argsJson: JSON.stringify(asObject(block.input) ?? {}),
            })
            break
          case 'tool_result': {
            parts.push({
              type: 'tool-result',
              id: String(block.tool_use_id ?? ''),
              // A block list is flattened to its text; an image inside a tool
              // result has no canonical slot, so it degrades to a note.
              resultJson: toolResultText(block.content),
              ...(block.is_error === true ? { isError: true } : {}),
            })
            break
          }
          case 'thinking':
            parts.push({
              type: 'thinking',
              text: typeof block.thinking === 'string' ? block.thinking : '',
              ...(strOr(block.signature) ? { signature: block.signature } : {}),
            })
            break
          case 'redacted_thinking':
            parts.push({
              type: 'thinking',
              text: '',
              ...(strOr(block.data) ? { signature: block.data } : {}),
              redacted: true,
            })
            break
          default:
            // `document`, `server_tool_use`, `web_search_tool_result`, … have no
            // canonical equivalent and are dropped.
            break
        }
      }
    }
    appendMessage(messages, role, parts)
  }

  const request = {
    model: String(body.model ?? ''),
    messages,
    tools: decodeAnthropicTools(body.tools),
    stream: true,
  }
  const system = typeof body.system === 'string' ? body.system : contentText(body.system)
  if (system.length > 0) request.system = system
  const maxTokens = numOr(body.max_tokens, undefined)
  if (maxTokens !== undefined) request.maxTokens = maxTokens
  const temperature = numOr(body.temperature, undefined)
  if (temperature !== undefined) request.temperature = temperature
  const topP = numOr(body.top_p, undefined)
  if (topP !== undefined) request.topP = topP
  const stop = normalizeStop(body.stop_sequences)
  if (stop) request.stop = stop
  const thinking = asObject(body.thinking)
  if (thinking && thinking.type !== 'disabled') {
    const budget = numOr(thinking.budget_tokens, undefined)
    if (budget !== undefined) {
      request.thinking = { budgetTokens: budget }
    } else {
      // `adaptive` has no budget: the intent "think, you decide how much" has no
      // portable number, so it travels as its own flag and each target picks a
      // default. `display`/`block_binding` only mean something here and are dropped.
      request.thinking = thinking.type === 'adaptive' ? { adaptive: true } : {}
    }
  }
  return request
}

/** Flatten a `tool_result.content` (string or block array) to text. */
function toolResultText(content) {
  if (typeof content === 'string') return content
  const blocks = asArray(content)
  const text = contentText(blocks)
  if (text.length > 0) return text
  const hasImage = blocks.some((raw) => asObject(raw)?.type === 'image')
  return hasImage ? '(see attached image)' : ''
}

/** Anthropic tools carry the schema under `input_schema`. */
function decodeAnthropicTools(tools) {
  const decoded = []
  for (const raw of asArray(tools)) {
    const tool = asObject(raw)
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue
    decoded.push({
      name: tool.name,
      ...(strOr(tool.description) ? { description: tool.description } : {}),
      parameters: asObject(tool.input_schema) ?? { type: 'object', properties: {} },
    })
  }
  return decoded
}

/**
 * Read an `openai-responses` body.
 *
 * `input` is a flat item array with no role alternation: a `function_call` item
 * is the assistant turn, a `function_call_output` is the tool result, and a
 * `reasoning` item is the assistant's thinking replayed verbatim as JSON. The
 * last one is kept as an opaque signature so that a responses→responses
 * round-trip can put the identical item back.
 *
 * @param {Record<string, any>} body
 * @returns {object} canonical request
 */
function decodeResponsesRequest(body) {
  const messages = []
  const systemParts = []
  const instruction = strOr(body.instructions)
  if (instruction) systemParts.push(instruction)

  const input = body.input
  if (typeof input === 'string') {
    appendMessage(messages, 'user', input.length > 0 ? [{ type: 'text', text: input }] : [])
  }
  for (const raw of asArray(input)) {
    const item = asObject(raw)
    if (!item) continue
    const type = item.type
    if (type === 'function_call' || type === 'custom_tool_call') {
      const name = String(item.name ?? '')
      // A custom tool's payload is a free-form string, not a JSON object; keep
      // it as a JSON string literal so the pairing with its output survives.
      const args = type === 'custom_tool_call'
        ? JSON.stringify(String(item.input ?? ''))
        : (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}))
      appendMessage(messages, 'assistant', [{
        type: 'tool-call',
        id: String(item.call_id ?? item.id ?? ''),
        name,
        argsJson: args,
      }])
      continue
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      appendMessage(messages, 'user', [{
        type: 'tool-result',
        id: String(item.call_id ?? item.id ?? ''),
        resultJson: toolResultText(item.output),
      }])
      continue
    }
    if (type === 'reasoning') {
      const text = asArray(item.summary)
        .map((raw) => asObject(raw))
        .filter((entry) => entry && entry.type === 'summary_text' && typeof entry.text === 'string')
        .map((entry) => entry.text)
        .join('\n')
      appendMessage(messages, 'assistant', [{
        type: 'thinking',
        text,
        // Opaque: the whole item, so it can be replayed without re-deriving it.
        signature: JSON.stringify(item),
      }])
      continue
    }
    if (type === 'message' || type === undefined) {
      const role = item.role
      if (role === 'system' || role === 'developer') {
        const text = contentText(item.content)
        if (text.length > 0) systemParts.push(text)
        continue
      }
      appendMessage(messages, role === 'assistant' ? 'assistant' : 'user', contentParts(item.content))
      continue
    }
    // `item_reference`, `mcp_*`, `computer_call`, … : nothing portable.
  }

  const request = {
    model: String(body.model ?? ''),
    messages,
    tools: decodeResponsesTools(body.tools),
    stream: true,
  }
  if (systemParts.length > 0) request.system = systemParts.join('\n\n')
  const maxTokens = numOr(body.max_output_tokens, undefined)
  if (maxTokens !== undefined) request.maxTokens = maxTokens
  const temperature = numOr(body.temperature, undefined)
  if (temperature !== undefined) request.temperature = temperature
  const topP = numOr(body.top_p, undefined)
  if (topP !== undefined) request.topP = topP
  const stop = normalizeStop(body.stop)
  if (stop) request.stop = stop
  const reasoning = asObject(body.reasoning)
  if (reasoning) {
    // `effort:'none'` is the off switch; anything else is a level, and a level we
    // do not recognise still means "think" even without a name we could map.
    if (reasoning.effort === 'none') {
      // off: no canonical thinking at all
    } else if (budgetForEffort(reasoning.effort) !== undefined) {
      request.thinking = { effort: reasoning.effort }
    } else {
      request.thinking = {}
    }
  }
  return request
}

/** Responses tools are flat, with the schema under `parameters`. */
function decodeResponsesTools(tools) {
  const decoded = []
  for (const raw of asArray(tools)) {
    const tool = asObject(raw)
    if (!tool || tool.type !== 'function') continue
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue
    decoded.push({
      name: tool.name,
      ...(strOr(tool.description) ? { description: tool.description } : {}),
      parameters: asObject(tool.parameters) ?? { type: 'object', properties: {} },
    })
  }
  return decoded
}

/**
 * Read a pi-ai request body in the protocol it was written for.
 *
 * @param {'openai-completions'|'anthropic-messages'|'openai-responses'} protocol
 * @param {object|string} body parsed JSON, or the raw body which is parsed here
 * @returns {{model: string, system?: string, messages: {role: 'user'|'assistant', parts: object[]}[], tools: object[], maxTokens?: number, temperature?: number, topP?: number, stop?: string[], thinking?: {budgetTokens?: number, effort?: string, adaptive?: true}, stream: true}}
 */
// ---------------------------------------------------------------------------
// google-generative-ai
//
// Four shape differences drive this dialect:
//
//  * the transcript is `contents` with roles `user` / `model`, and tool answers
//    are *user* parts (`functionResponse`) rather than a `tool` role;
//  * a tool call has no id at all, so the gateway synthesizes one from the name
//    and rebuilds the name→id pairing when replaying a functionResponse;
//  * thinking is a text part flagged `thought: true` (and `includeThoughts`);
//  * the response carries `usageMetadata.promptTokenCount` **including** the
//    cached prefix, so the canonical input is computed by subtraction.
// ---------------------------------------------------------------------------

/** Read one Gemini part into canonical parts (an array: a part may hold both). */
function decodeGeminiPart(part, out, callNames) {
  if (typeof part.text === 'string' && part.text.length > 0) {
    out.push(part.thought === true ? { type: 'thinking', text: part.text } : { type: 'text', text: part.text })
    return
  }
  const inline = asObject(part.inlineData) ?? asObject(part.inline_data)
  if (inline) {
    if (typeof inline.data === 'string' && inline.data.length > 0) {
      out.push({ type: 'image', mediaType: strOr(inline.mimeType) ?? strOr(inline.mime_type) ?? 'image/png', dataBase64: inline.data })
    }
    return
  }
  const call = asObject(part.functionCall) ?? asObject(part.function_call)
  if (call) {
    const name = String(call.name ?? '')
    // Gemini has no tool ids, so they are synthesized. The occurrence index has
    // to be part of the seed: two parallel calls to the same function in one
    // turn are common (read two files), and seeding on the name alone gave both
    // the same id — which downstream merges into one call with broken JSON.
    const queue = callNames.get(name) ?? []
    const id = mappedToolId(undefined, 'tool-call', name, String(queue.length))
    queue.push(id)
    callNames.set(name, queue)
    // `thoughtSignature` has to come back with the call on later turns; it is
    // carried in the existing `signature` slot rather than a new field.
    const signature = strOr(part.thoughtSignature) ?? strOr(part.thought_signature)
    out.push({ type: 'tool-call', id, name, argsJson: JSON.stringify(asObject(call.args) ?? {}), ...(signature !== undefined ? { signature } : {}) })
    return
  }
  const response = asObject(part.functionResponse) ?? asObject(part.function_response)
  if (response) {
    const name = String(response.name ?? '')
    const body = response.response ?? response.result
    const text = typeof body === 'string' ? body : JSON.stringify(asObject(body)?.content ?? body ?? {})
    // Results come back in the same order the calls went out, so the queue is
    // the pairing table: shifting keeps two same-name calls and their two
    // results matched instead of collapsing onto one id.
    const queue = callNames.get(name)
    const id = queue !== undefined && queue.length > 0 ? /** @type {string} */ (queue.shift()) : mappedToolId(undefined, 'tool-result', name)
    out.push({ type: 'tool-result', id, resultJson: text })
  }
}

function decodeGeminiRequest(body) {
  const messages = []
  const callNames = new Map()
  for (const raw of asArray(body.contents)) {
    const content = asObject(raw)
    if (!content) continue
    const parts = []
    for (const rawPart of asArray(content.parts)) {
      const part = asObject(rawPart)
      if (part) decodeGeminiPart(part, parts, callNames)
    }
    appendMessage(messages, content.role === 'model' ? 'assistant' : 'user', parts)
  }

  const request = { model: String(body.model ?? ''), messages, tools: [], stream: true }

  const instruction = asObject(body.systemInstruction) ?? asObject(body.system_instruction)
  const systemParts = asArray(instruction?.parts)
    .map((raw) => asObject(raw))
    .filter((part) => part && typeof part.text === 'string' && part.text.length > 0)
    .map((part) => part.text)
  if (systemParts.length > 0) request.system = systemParts.join('\n\n')

  const declarations = asArray(asObject(asArray(body.tools)[0])?.functionDeclarations)
  for (const raw of declarations) {
    const declaration = asObject(raw)
    if (!declaration) continue
    request.tools.push({
      name: String(declaration.name ?? ''),
      ...(strOr(declaration.description) ? { description: declaration.description } : {}),
      parameters: asObject(declaration.parameters) ?? { type: 'object', properties: {} },
    })
  }

  const config = asObject(body.generationConfig) ?? asObject(body.generation_config) ?? {}
  const maxTokens = numOr(config.maxOutputTokens, numOr(config.max_output_tokens, undefined))
  if (maxTokens !== undefined) request.maxTokens = maxTokens
  const temperature = numOr(config.temperature, undefined)
  if (temperature !== undefined) request.temperature = temperature
  const topP = numOr(config.topP, numOr(config.top_p, undefined))
  if (topP !== undefined) request.topP = topP
  const stop = normalizeStop(config.stopSequences ?? config.stop_sequences)
  if (stop) request.stop = stop
  const thinking = asObject(config.thinkingConfig) ?? asObject(config.thinking_config)
  if (thinking) {
    const budget = numOr(thinking.thinkingBudget, numOr(thinking.thinking_budget, undefined))
    // Gemini's `thinkingBudget` is a token count, the same unit anthropic's
    // `budget_tokens` uses. Storing it as `budget` dropped it on the floor and
    // every downstream encoder fell back to its cheapest effort.
    if (budget !== undefined) request.thinking = { budgetTokens: budget }
  }
  return request
}

/** Compile a canonical request into a Gemini `generateContent` body. */
function encodeGeminiBody(request) {
  const contents = []
  const callNames = new Map()

  for (const message of asArray(request.messages)) {
    const assistant = message.role === 'assistant'
    const parts = []
    for (const rawPart of asArray(message.parts)) {
      const part = asObject(rawPart)
      if (!part) continue
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        parts.push({ text: part.text })
      } else if (part.type === 'thinking' && typeof part.text === 'string' && part.text.length > 0) {
        parts.push({ text: part.text, thought: true })
      } else if (part.type === 'image' && typeof part.dataBase64 === 'string' && part.dataBase64.length > 0) {
        parts.push({ inlineData: { mimeType: strOr(part.mediaType) ?? 'image/png', data: part.dataBase64 } })
      } else if (part.type === 'tool-call') {
        const name = String(part.name ?? '')
        callNames.set(mappedToolId(part.id, 'tool-call', name), name)
        parts.push({
          functionCall: { name, args: parseJsonObject(part.argsJson) },
          ...(typeof part.signature === 'string' && part.signature.length > 0 ? { thoughtSignature: part.signature } : {}),
        })
      } else if (part.type === 'tool-result') {
        const name = callNames.get(mappedToolId(part.id, 'tool-result')) ?? 'tool'
        const text = typeof part.resultJson === 'string' ? part.resultJson : JSON.stringify(part.resultJson ?? '')
        // `response` must be an object; wrapping the text keeps it readable to
        // the model without inventing a schema the caller never promised.
        parts.push({ functionResponse: { name, response: part.isError === true ? { error: text } : { content: text } } })
      }
    }
    if (parts.length === 0) continue
    const role = assistant ? 'model' : 'user'
    const last = contents.at(-1)
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  const body = { contents }
  if (strOr(request.system)) body.systemInstruction = { parts: [{ text: request.system }] }

  const declarations = asArray(request.tools).map((rawTool) => {
    const tool = asObject(rawTool) ?? {}
    return {
      name: String(tool.name ?? ''),
      ...(strOr(tool.description) ? { description: tool.description } : {}),
      // Gemini rejects a declaration without `parameters`, even one that takes
      // no arguments.
      parameters: asObject(tool.parameters) ?? { type: 'object', properties: {} },
    }
  })
  if (declarations.length > 0) body.tools = [{ functionDeclarations: declarations }]

  const config = {}
  if (numOr(request.maxTokens, undefined) !== undefined) config.maxOutputTokens = request.maxTokens
  if (numOr(request.temperature, undefined) !== undefined) config.temperature = request.temperature
  if (numOr(request.topP, undefined) !== undefined) config.topP = request.topP
  if (Array.isArray(request.stop) && request.stop.length > 0) config.stopSequences = request.stop
  if (hasThinking(request)) {
    const budget = thinkingBudget(request)
    config.thinkingConfig = {
      ...(budget !== undefined ? { thinkingBudget: budget } : {}),
      includeThoughts: true,
    }
  }
  if (Object.keys(config).length > 0) body.generationConfig = config
  return body
}

/** `google-generative-ai` stream frame: `candidates[].content.parts[]`. */
function decodeGeminiFrame(frame, payload, out, begin, state) {
  const error = asObject(payload.error)
  if (error) {
    begin(out)
    out.push({
      type: 'error',
      message: String(error.message ?? 'google-generative-ai error'),
      retryable: retryableFor(numOr(error.code, 500), error.status),
      status: numOr(error.code, undefined),
    })
    state.finished = true
    return
  }
  begin(out)
  for (const rawCandidate of asArray(payload.candidates)) {
    const candidate = asObject(rawCandidate)
    if (!candidate) continue
    const parts = asArray(asObject(candidate.content)?.parts)
    for (const rawPart of parts) {
      const part = asObject(rawPart)
      if (!part) continue
      if (typeof part.text === 'string' && part.text.length > 0) {
        out.push(part.thought === true ? { type: 'thinking', text: part.text } : { type: 'text', text: part.text })
        continue
      }
      const call = asObject(part.functionCall)
      if (call) {
        const name = String(call.name ?? '')
        // Same-name parallel calls must not share an id (see decodeGeminiPart).
        const seen = state.toolCounts?.get(name) ?? 0
        if (state.toolCounts === undefined) state.toolCounts = new Map()
        state.toolCounts.set(name, seen + 1)
        const id = mappedToolId(undefined, 'tool-call', name, String(seen))
        const signature = strOr(part.thoughtSignature) ?? strOr(part.thought_signature)
        out.push({ type: 'tool-call-start', id, name, ...(signature !== undefined ? { signature } : {}) })
        out.push({ type: 'tool-call-delta', id, argsJson: JSON.stringify(asObject(call.args) ?? {}) })
      }
    }
    const reason = candidate.finishReason
    if (typeof reason === 'string' && reason.length > 0) {
      out.push({ type: 'finish', reason: canonicalStopReason('google-generative-ai', reason) })
      state.finished = true
    }
  }
  const usage = asObject(payload.usageMetadata) ?? asObject(payload.usage_metadata)
  if (usage) {
    const cached = numOr(usage.cachedContentTokenCount, numOr(usage.cached_content_token_count, 0))
    out.push({
      type: 'usage',
      input: Math.max(0, numOr(usage.promptTokenCount, numOr(usage.prompt_token_count, 0)) - cached),
      output: numOr(usage.candidatesTokenCount, numOr(usage.candidates_token_count, 0)),
    })
  }
}

/** Canonical finish reason back to a Gemini `finishReason`. */
function geminiFinishReason(reason) {
  if (reason === 'length') return 'MAX_TOKENS'
  if (reason === 'content-filter') return 'SAFETY'
  if (reason === 'stop' || reason === 'tool-call') return 'STOP'
  return undefined
}

/** `google-generative-ai` writer: one `candidates` frame per delta, no `[DONE]`. */
function geminiWriter(model, state) {
  const frame = (candidate) => dataFrame({ candidates: [{ ...candidate, index: 0 }], modelVersion: model })
  const calls = []

  const start = () => {
    if (state.started) return []
    state.started = true
    return [frame({ content: { role: 'model', parts: [] } })]
  }

  return {
    push(event) {
      switch (event.type) {
        case 'start':
          return start()
        case 'text':
          if (typeof event.text !== 'string' || event.text.length === 0) return []
          return [...start(), frame({ content: { role: 'model', parts: [{ text: event.text }] } })]
        case 'thinking':
          if (typeof event.text !== 'string' || event.text.length === 0) return []
          return [...start(), frame({ content: { role: 'model', parts: [{ text: event.text, thought: true }] } })]
        case 'tool-call-start':
          calls.push({ name: String(event.name ?? ''), argsJson: '' })
          return start()
        case 'tool-call-delta': {
          const open = calls.at(-1)
          if (open) open.argsJson += String(event.argsJson ?? '')
          return []
        }
        case 'usage':
          state.usage = {
            promptTokenCount: numOr(event.input, 0),
            candidatesTokenCount: numOr(event.output, 0),
          }
          return []
        case 'finish':
          state.finishReason = event.reason
          return []
        case 'error':
          state.errored = true
          return [dataFrame({
            error: { code: numOr(event.status, 500), message: String(event.message ?? 'gateway error') },
            ...(typeof event.retryable === 'boolean' ? { retryable: event.retryable } : {}),
          })]
        default:
          return []
      }
    },
    end() {
      const parts = calls.map((call) => ({ functionCall: { name: call.name, args: parseJsonObject(call.argsJson) } }))
      const out = []
      const candidate = {
        index: 0,
        ...(parts.length > 0 ? { content: { role: 'model', parts } } : {}),
        ...(geminiFinishReason(state.finishReason) === undefined ? {} : { finishReason: geminiFinishReason(state.finishReason) }),
      }
      if (parts.length > 0 || candidate.finishReason !== undefined) out.push(dataFrame({ candidates: [candidate] }))
      if (state.usage) out.push(dataFrame({ usageMetadata: state.usage, candidates: [] }))
      return out
    },
  }
}

export function decodeRequest(protocol, body) {
  assertProtocol(protocol)
  let parsed = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error('request body is not valid JSON')
    }
  }
  const source = asObject(parsed)
  if (!source) throw new Error('request body is not a JSON object')
  if (protocol === 'openai-completions') return decodeCompletionsRequest(source)
  if (protocol === 'anthropic-messages') return decodeAnthropicRequest(source)
  if (protocol === 'google-generative-ai') return decodeGeminiRequest(source)
  return decodeResponsesRequest(source)
}

/**
 * Turn an upstream HTTP failure into the canonical error event.
 *
 * The gateway has already forwarded the provider's JSON, so the only work left
 * is finding the message and guessing whether the failure is worth retrying.
 * The message keeps the provider's own words: a rewritten one costs the operator
 * the exact clue they needed, and every dialect spells it differently
 * (`error.message`, `message`, a bare `error` string).
 *
 * @param {string} protocol
 * @param {number} status
 * @param {string|object} body
 * @returns {{type: 'error', message: string, retryable: boolean, status: number}}
 */
export function decodeError(protocol, status, body) {
  assertProtocol(protocol)
  const raw = typeof body === 'string' ? body : ''
  let payload = asObject(body)
  if (!payload && raw.length > 0) {
    try {
      payload = asObject(JSON.parse(raw))
    } catch {
      // Not JSON: the text is all the provider gave us, so it is the message.
    }
  }
  const error = asObject(payload?.error)
  const message =
    strOr(error?.message) ??
    (typeof payload?.error === 'string' ? payload.error : undefined) ??
    strOr(payload?.message) ??
    strOr(payload?.detail) ??
    (raw.trim().length > 0 ? raw.trim() : `HTTP ${status}`)
  return {
    type: 'error',
    message,
    retryable: retryableFor(status, error?.code, error?.type, payload?.code, payload?.type),
    status,
  }
}

/** `arguments` / `resultJson` are text; parse only where the target wants an object. */
function parseJsonObject(text) {  try {
    const parsed = JSON.parse(text)
    return asObject(parsed) ?? {}
  } catch {
    return {}
  }
}

/** Join the text parts of one assistant turn into the single string all three targets want. */
function joinText(parts) {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
    .map((part) => part.text)
    .join('\n')
}

/** The thinking text worth replaying: a redacted block carries none. */
function joinThinking(parts) {
  return parts
    .filter((part) => part.type === 'thinking' && part.redacted !== true && typeof part.text === 'string' && part.text.length > 0)
    .map((part) => part.text)
    .join('\n')
}

/**
 * Build an `openai-completions` body.
 *
 * `content` is deliberately a plain string (or null) rather than a block array:
 * pi-ai's own writer explains that some models imitate a nested array back at
 * the API (`openai-completions.js:998-1026`), and no compatible gateway
 * rejects the string form.
 *
 * Tool results are emitted *before* any user text that shared their canonical
 * message, so an assistant `tool_calls` turn is always followed immediately by
 * the `role:'tool'` messages that answer it — the one ordering rule strict
 * OpenAI-compatible providers really do enforce.
 *
 * @param {object} request
 * @param {{maxTokensField?: string}} options
 * @returns {object}
 */
function encodeCompletionsBody(request, options) {
  const messages = []
  if (strOr(request.system)) messages.push({ role: 'system', content: request.system })

  for (const message of asArray(request.messages)) {
    const parts = asArray(message.parts)
    if (message.role === 'assistant') {
      const text = joinText(parts)
      const thinking = joinThinking(parts)
      const calls = parts.filter((part) => part.type === 'tool-call')
      // A turn that only reasoned still exists in the transcript: dropping it
      // would make the pass-through route lose a message it was given.
      if (text.length === 0 && calls.length === 0 && thinking.length === 0) continue
      const out = { role: 'assistant', content: text.length > 0 ? text : null }
      // The field name is normally the thinking block's signature; with no
      // provider to ask, `reasoning_content` is the spelling DeepSeek, Moonshot
      // and most OpenAI-compatible reasoning servers read.
      if (thinking.length > 0) out.reasoning_content = thinking
      if (calls.length > 0) {
        out.tool_calls = calls.map((call) => ({
          id: mappedToolId(call.id, 'tool-call', call.name),
          type: 'function',
          function: { name: String(call.name ?? ''), arguments: String(call.argsJson ?? '') },
        }))
      }
      messages.push(out)
      continue
    }

    for (const part of parts) {
      if (part.type !== 'tool-result') continue
      messages.push({
        role: 'tool',
        tool_call_id: mappedToolId(part.id, 'tool-result'),
        content: typeof part.resultJson === 'string' ? part.resultJson : String(part.resultJson ?? ''),
      })
    }

    const content = []
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        content.push({ type: 'text', text: part.text })
      } else if (part.type === 'image') {
        content.push({ type: 'image_url', image_url: { url: dataUrlOf(part) } })
      }
    }
    if (content.length === 0) continue
    // Text-only content stays a string, exactly as pi-ai writes it.
    if (content.every((block) => block.type === 'text')) {
      messages.push({ role: 'user', content: content.map((block) => block.text).join('\n') })
    } else {
      messages.push({ role: 'user', content })
    }
  }

  const body = { model: request.model, messages, stream: true, stream_options: { include_usage: true } }
  if (numOr(request.maxTokens, undefined) !== undefined) {
    const field = options.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'
    body[field] = request.maxTokens
  }
  if (numOr(request.temperature, undefined) !== undefined) body.temperature = request.temperature
  if (numOr(request.topP, undefined) !== undefined) body.top_p = request.topP
  if (Array.isArray(request.stop) && request.stop.length > 0) body.stop = request.stop
  if (hasThinking(request)) body.reasoning_effort = thinkingEffort(request)
  const tools = encodeCompletionsTools(request.tools)
  if (tools.length > 0) body.tools = tools
  return body
}

/** Re-wrap each tool in the `{type:'function', function:{…}}` envelope. */
function encodeCompletionsTools(tools) {
  return asArray(tools).map((tool) => ({
    type: 'function',
    function: {
      name: String(tool.name ?? ''),
      ...(strOr(tool.description) ? { description: tool.description } : {}),
      parameters: asObject(tool.parameters) ?? { type: 'object', properties: {} },
    },
  }))
}

/**
 * Build an `anthropic-messages` body.
 *
 * Two rules are not negotiable upstream and are handled here rather than
 * discovered as a 400:
 *  - `max_tokens` is required, and the thinking budget has to fit under it.
 *    pi-ai's own anthropic route adds the budget to the caller's cap
 *    (`adjustMaxTokensForThinking`, simple-options.js:63), and so does this
 *    layer when the budget came from an effort hint. A budget the caller
 *    declared is left exactly as asked for; only the ceiling grows.
 *  - `temperature` and `thinking` are mutually exclusive: pi-ai stops sending
 *    temperature the moment thinking is on (`anthropic-messages.js:956-962`).
 *    A canonical request that still carries both loses the temperature.
 *
 * @param {object} request
 * @returns {object}
 */
function encodeAnthropicBody(request) {
  const budget = thinkingBudget(request)
  const declared = numOr(request.maxTokens, ANTHROPIC_DEFAULT_MAX_TOKENS)
  let maxTokens = declared
  if (budget !== undefined) {
    if (!thinkingBudgetIsDeclared(request)) {
      maxTokens = declared + budget
    } else if (declared <= budget) {
      // A budget at or above the ceiling is a request this api would reject;
      // make room for an answer rather than truncate the thinking.
      maxTokens = budget + MIN_ANSWER_TOKENS
    }
  }

  const body = { model: request.model, max_tokens: maxTokens, stream: true }
  if (strOr(request.system)) body.system = [{ type: 'text', text: request.system }]

  const messages = []
  for (const message of asArray(request.messages)) {
    const parts = asArray(message.parts)
    const blocks = []
    if (message.role === 'assistant') {
      for (const part of parts) {
        if (part.type === 'thinking') {
          // An anthropic thinking block is only verified if it carries the
          // signature *this* provider issued. Anything else — a responses
          // `encrypted_content`, somebody else's signature — would be rejected
          // or mis-verified, so the block is dropped instead of replayed.
          if (part.redacted === true) {
            if (strOr(part.signature)) blocks.push({ type: 'redacted_thinking', data: part.signature })
            continue
          }
          if (!strOr(part.signature) || part.signature.startsWith('{')) continue
          blocks.push({ type: 'thinking', thinking: String(part.text ?? ''), signature: part.signature })
        } else if (part.type === 'text') {
          if (typeof part.text === 'string' && part.text.length > 0) blocks.push({ type: 'text', text: part.text })
        } else if (part.type === 'tool-call') {
          blocks.push({
            type: 'tool_use',
            id: mappedToolId(part.id, 'tool-call', part.name),
            name: String(part.name ?? ''),
            // `input` is an object upstream, never a string.
            input: parseJsonObject(String(part.argsJson ?? '')),
          })
        }
      }
      appendBlocks(messages, 'assistant', blocks)
      continue
    }

    // Tool results lead the user turn: the API requires `tool_result` blocks to
    // come before any other content in the message that answers a tool call.
    const results = []
    const content = []
    for (const part of parts) {
      if (part.type === 'tool-result') {
        results.push({
          type: 'tool_result',
          tool_use_id: mappedToolId(part.id, 'tool-result'),
          content: typeof part.resultJson === 'string' ? part.resultJson : String(part.resultJson ?? ''),
          is_error: part.isError === true,
        })
      } else if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        content.push({ type: 'text', text: part.text })
      } else if (part.type === 'image') {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: strOr(part.mediaType) ?? 'image/png', data: String(part.dataBase64 ?? '') },
        })
      }
    }
    // Anthropic needs a text block to hang a picture on when there is nothing
    // else in the turn, or the request is rejected as empty.
    if (results.length === 0 && content.length > 0 && content.every((block) => block.type === 'image')) {
      content.unshift({ type: 'text', text: '(see attached image)' })
    }
    appendBlocks(messages, 'user', [...results, ...content])
  }
  if (messages.length === 0) messages.push({ role: 'user', content: [{ type: 'text', text: '' }] })
  body.messages = messages

  if (hasThinking(request)) {
    if (asObject(request.thinking).adaptive === true) {
      body.thinking = { type: 'adaptive', display: 'summarized' }
      body.output_config = { effort: 'high' }
    } else if (budget !== undefined) {
      body.thinking = { type: 'enabled', budget_tokens: budget }
    }
  }
  // Sampling parameters the target cannot combine with thinking are dropped,
  // not negotiated: a rejected request is worse than one that lost a knob.
  if (!hasThinking(request) && numOr(request.temperature, undefined) !== undefined) body.temperature = request.temperature
  if (numOr(request.topP, undefined) !== undefined) body.top_p = request.topP
  if (Array.isArray(request.stop) && request.stop.length > 0) body.stop_sequences = request.stop
  const tools = asArray(request.tools).map((tool) => ({
    name: String(tool.name ?? ''),
    ...(strOr(tool.description) ? { description: tool.description } : {}),
    input_schema: asObject(tool.parameters) ?? { type: 'object', properties: {} },
  }))
  if (tools.length > 0) body.tools = tools
  return body
}

/** Merge blocks into the previous message when the role repeats. */
function appendBlocks(messages, role, blocks) {
  if (blocks.length === 0) return
  const last = messages.at(-1)
  if (last && last.role === role) {
    last.content.push(...blocks)
    return
  }
  messages.push({ role, content: blocks })
}

/**
 * Build an `openai-responses` body.
 *
 * `system` goes in `input[0]` as an `input_text` block array; `store:false` is
 * the only mode this gateway can honestly claim, since it never holds server
 * side state. `max_output_tokens` is floored at 16 the way pi-ai does, because
 * smaller values are rejected outright.
 *
 * @param {object} request
 * @returns {object}
 */
function encodeResponsesBody(request) {
  const input = []
  if (strOr(request.system)) {
    input.push({ role: 'system', content: [{ type: 'input_text', text: request.system }] })
  }

  for (const message of asArray(request.messages)) {
    const parts = asArray(message.parts)
    if (message.role === 'assistant') {
      for (const part of parts) {
        // Only a reasoning item this dialect issued can be replayed; its
        // `encrypted_content` is what makes it verifiable.
        if (part.type === 'thinking' && strOr(part.signature) && part.signature.startsWith('{')) {
          try {
            const item = JSON.parse(part.signature)
            if (asObject(item)?.type === 'reasoning') input.push(item)
          } catch {
            // A signature that is not the JSON item we expect is not replayable.
          }
        }
      }
      const text = joinText(parts)
      if (text.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        })
      }
      for (const part of parts) {
        if (part.type !== 'tool-call') continue
        const callId = mappedToolId(part.id, 'tool-call', part.name)
        input.push({
          type: 'function_call',
          id: itemIdFor(callId),
          call_id: callId,
          name: String(part.name ?? ''),
          arguments: String(part.argsJson ?? ''),
        })
      }
      continue
    }

    for (const part of parts) {
      if (part.type !== 'tool-result') continue
      input.push({
        type: 'function_call_output',
        call_id: mappedToolId(part.id, 'tool-result'),
        output: typeof part.resultJson === 'string' ? part.resultJson : String(part.resultJson ?? ''),
      })
    }

    const content = []
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        content.push({ type: 'input_text', text: part.text })
      } else if (part.type === 'image') {
        content.push({ type: 'input_image', detail: 'auto', image_url: dataUrlOf(part) })
      }
    }
    if (content.length > 0) input.push({ role: 'user', content })
  }

  const body = { model: request.model, input, stream: true, store: false }
  if (numOr(request.maxTokens, undefined) !== undefined) {
    body.max_output_tokens = Math.max(RESPONSES_MIN_OUTPUT_TOKENS, request.maxTokens)
  }
  if (numOr(request.temperature, undefined) !== undefined) body.temperature = request.temperature
  if (numOr(request.topP, undefined) !== undefined) body.top_p = request.topP
  if (hasThinking(request)) {
    body.reasoning = { effort: thinkingEffort(request), summary: 'auto' }
    body.include = ['reasoning.encrypted_content']
  }
  const tools = asArray(request.tools).map((tool) => ({
    type: 'function',
    name: String(tool.name ?? ''),
    ...(strOr(tool.description) ? { description: tool.description } : {}),
    parameters: asObject(tool.parameters) ?? { type: 'object', properties: {} },
  }))
  if (tools.length > 0) body.tools = tools
  return body
}

/** Auth headers for one target. Nothing is guessed: the wrong header is a 401. */
function requestHeaders(protocol, apiKey, extra) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
  const key = typeof apiKey === 'string' ? apiKey : ''
  if (protocol === 'google-generative-ai') {
    // Gemini takes the key in its own header and rejects a bearer token.
    if (key.length > 0) headers['x-goog-api-key'] = key
    delete headers.accept
  } else if (protocol === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (key.startsWith('sk-ant-oat')) {
      // A subscription token is a bearer credential, not an x-api-key.
      headers.authorization = `Bearer ${key}`
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20'
    } else if (key.length > 0) {
      headers['x-api-key'] = key
    }
  } else if (key.length > 0) {
    headers.authorization = `Bearer ${key}`
  }
  return { ...headers, ...asObject(extra) }
}

/**
 * Compile a canonical request into the body one provider expects.
 *
 * @param {'openai-completions'|'anthropic-messages'|'openai-responses'} protocol target api
 * @param {object} request canonical request, as produced by {@link decodeRequest}
 * @param {{baseURL: string, apiKey?: string, headers?: Record<string, string>, maxTokensField?: string}} options
 *   `maxTokensField` picks `max_completion_tokens` instead of `max_tokens` for a
 *   route whose provider rejects the other spelling.
 * @returns {{url: string, headers: Record<string, string>, body: string}}
 */
export function encodeRequest(protocol, request, options = {}) {
  assertProtocol(protocol)
  const baseURL = options.baseURL ?? ''
  const headers = requestHeaders(protocol, options.apiKey, options.headers)
  if (protocol === 'openai-completions') {
    return {
      url: joinEndpoint(baseURL, '/chat/completions'),
      headers,
      body: JSON.stringify(encodeCompletionsBody(request, options)),
    }
  }
  if (protocol === 'anthropic-messages') {
    return { url: anthropicEndpoint(baseURL), headers, body: JSON.stringify(encodeAnthropicBody(request)) }
  }
  if (protocol === 'google-generative-ai') {
    return { url: geminiEndpoint(baseURL, request.model), headers, body: JSON.stringify(encodeGeminiBody(request)) }
  }
  return { url: joinEndpoint(baseURL, '/responses'), headers, body: JSON.stringify(encodeResponsesBody(request)) }
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

/**
 * A line-oriented SSE reader that survives arbitrary chunk boundaries.
 *
 * This is the piece both hand-written pi-ai readers duplicate
 * (`anthropic-messages.js:236-296`, `openai-responses-shared.js`), and the
 * reason a translation layer cannot simply split on `\n\n`: a chunk may end
 * mid-line, mid-field or mid-UTF-8-sequence, and `\r\n`, `\r` and `\n` are all
 * legal line terminators.
 *
 * `push` accepts a string or raw bytes; bytes are decoded through one streaming
 * `TextDecoder` so a multi-byte character split across chunks still arrives
 * whole.
 *
 * @returns {{push: (chunk: string|Uint8Array) => {event: string, data: string}[], end: () => {event: string, data: string}[]}}
 */
function createSseReader() {
  let buffer = ''
  let decoder
  let event = ''
  let data = []
  // How far into `buffer` has already been searched for a line break. Without
  // this, pushing a large body at once rescans the same prefix once per frame.
  let scanned = 0

  /** Pull one logical line off the buffer, or `undefined` if none is complete. */
  function takeLine() {
    const newline = buffer.indexOf('\n', scanned)
    const carriage = buffer.indexOf('\r', scanned)
    let index = newline === -1 ? carriage : carriage === -1 ? newline : Math.min(newline, carriage)
    if (index === -1) {
      scanned = buffer.length
      return undefined
    }
    // A trailing `\r` may be the first half of `\r\n`: waiting for the next
    // chunk keeps one line from being counted twice.
    if (index === buffer.length - 1 && buffer[index] === '\r') {
      scanned = index
      return undefined
    }
    const line = buffer.slice(0, index)
    let next = index + 1
    if (buffer[index] === '\r' && buffer[next] === '\n') next += 1
    buffer = buffer.slice(next)
    scanned = 0
    return line
  }

  function flush(out) {
    if (event.length === 0 && data.length === 0) return
    out.push({ event, data: data.join('\n') })
    event = ''
    data = []
  }

  function consume(line, out) {
    if (line.length === 0) { flush(out); return }
    if (line.startsWith(':')) return // comment / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    // `id` and `retry` carry nothing a translated stream needs.
  }

  return {
    push(chunk) {
      if (typeof chunk === 'string') buffer += chunk
      else if (chunk) {
        decoder ??= new TextDecoder('utf-8')
        buffer += decoder.decode(chunk, { stream: true })
      }
      const out = []
      let line = takeLine()
      while (line !== undefined) {
        consume(line, out)
        line = takeLine()
      }
      return out
    },
    end() {
      const out = []
      // An unterminated last line is still a line: providers that close the
      // connection without a final newline must not lose their last event.
      if (buffer.length > 0) buffer += '\n'
      let line = takeLine()
      while (line !== undefined) {
        consume(line, out)
        line = takeLine()
      }
      flush(out)
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Stream decoding — upstream SSE → canonical events
// ---------------------------------------------------------------------------

/** Read an SSE frame's payload, tolerating a keep-alive or an empty frame. */
function framePayload(frame) {
  const data = frame.data.trim()
  if (data.length === 0) return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/**
 * Canonical stop reasons. The three protocols disagree on the vocabulary and
 * on which cases are errors: anthropic's `refusal` and `sensitive` both mean
 * "the model declined", which the canonical form reports as `content-filter`.
 */
function canonicalStopReason(protocol, reason) {
  if (typeof reason !== 'string' || reason.length === 0) return 'stop'
  if (protocol === 'openai-completions') {
    if (reason === 'stop' || reason === 'end') return 'stop'
    if (reason === 'length') return 'length'
    if (reason === 'function_call' || reason === 'tool_calls') return 'tool-call'
    if (reason === 'content_filter') return 'content-filter'
    return reason
  }
  if (protocol === 'anthropic-messages') {
    if (reason === 'end_turn' || reason === 'pause_turn' || reason === 'stop_sequence') return 'stop'
    if (reason === 'max_tokens') return 'length'
    if (reason === 'tool_use') return 'tool-call'
    if (reason === 'refusal' || reason === 'sensitive') return 'content-filter'
    return reason
  }
  if (protocol === 'google-generative-ai') {
    if (reason === 'STOP' || reason === 'FINISH_REASON_UNSPECIFIED' || reason === 'OTHER') return 'stop'
    if (reason === 'MAX_TOKENS') return 'length'
    if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT') return 'content-filter'
    if (reason === 'MALFORMED_FUNCTION_CALL') return 'tool-call'
    return 'stop'
  }
  if (reason === 'completed') return 'stop'
  if (reason === 'incomplete.max_output_tokens' || reason === 'max_output_tokens') return 'length'
  if (reason === 'incomplete.content_filter' || reason === 'content_filter') return 'content-filter'
  return reason
}

/**
 * Normalise an OpenAI usage block to pi-ai's disjoint accounting.
 *
 * `prompt_tokens` **includes** the cached prompt on the OpenAI side, while
 * anthropic's `input_tokens` **excludes** it. pi-ai reports `input` as the
 * non-cached remainder and keeps the cache in its own field
 * (`openai-completions.js:1173-1202`), so the subtraction happens here too;
 * otherwise a cached turn would be billed as new input on the way out.
 *
 * @param {Record<string, any>} usage
 * @returns {{input: number, output: number}}
 */
function completionsUsage(usage) {
  const prompt = numOr(usage.prompt_tokens, 0)
  const details = asObject(usage.prompt_tokens_details) ?? {}
  const cacheRead = numOr(details.cached_tokens, numOr(usage.prompt_cache_hit_tokens, numOr(usage.cached_tokens, 0)))
  const cacheWrite = numOr(details.cache_write_tokens, 0)
  return {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output: numOr(usage.completion_tokens, 0),
  }
}

/**
 * Decode one upstream SSE stream into canonical events.
 *
 * The returned object is fed raw text (or bytes) as it arrives; it never
 * assumes a chunk is a frame. `end()` flushes the tail and reports a stream
 * that stopped before its protocol's terminal event, because a truncated
 * answer must not look like a complete one.
 *
 * @param {'openai-completions'|'anthropic-messages'|'openai-responses'} protocol
 * @returns {{push: (chunk: string|Uint8Array) => object[], end: () => object[]}}
 */
export function createStreamDecoder(protocol) {
  assertProtocol(protocol)
  const reader = createSseReader()
  const state = { started: false, finished: false, done: false }

  /** Emit `start` before anything else, once. */
  function begin(out) {
    if (state.started) return
    state.started = true
    out.push({ type: 'start' })
  }

  const handle = protocol === 'openai-completions'
    ? decodeCompletionsFrame
    : protocol === 'anthropic-messages'
      ? decodeAnthropicFrame
      : protocol === 'google-generative-ai'
        ? decodeGeminiFrame
        : decodeResponsesFrame

  return {
    push(chunk) {
      const out = []
      for (const frame of reader.push(chunk)) {
        // `[DONE]` is the completions terminator; a proxy in front of either
        // other dialect may forward it too, and treating it as terminal there
        // is harmless. It is checked before the JSON gate because it is not
        // JSON at all.
        if (frame.data.trim() === '[DONE]') {
          state.done = true
          if (!state.finished) {
            begin(out)
            out.push({ type: 'finish', reason: 'stop' })
            state.finished = true
          }
          continue
        }
        const payload = framePayload(frame)
        if (payload !== undefined) handle(frame, payload, out, begin, state)
      }
      return out
    },
    end() {
      const out = []
      for (const frame of reader.end()) {
        if (frame.data.trim() === '[DONE]') {
          state.done = true
          continue
        }
        const payload = framePayload(frame)
        if (payload !== undefined) handle(frame, payload, out, begin, state)
      }
      if (!state.finished && !state.done) {
        // Silence is not success: a client waiting on this stream would either
        // hang or treat an empty answer as a real one. Both cases are reported.
        out.push({
          type: 'error',
          message: state.started
            ? `${protocol} stream ended before a terminal event`
            : `${protocol} stream carried no complete event`,
          retryable: true,
        })
      }
      return out
    },
  }
}

/** `openai-completions`: one JSON chunk per `data:` line, `[DONE]` to stop. */
function decodeCompletionsFrame(frame, payload, out, begin, state) {
  if (frame.data.trim() === '[DONE]') { state.done = true; return }
  begin(out)
  const error = asObject(payload.error)
  if (error) {
    out.push({
      type: 'error',
      message: String(error.message ?? error.code ?? 'upstream error'),
      retryable: retryableFor(undefined, error.code, error.type),
    })
    state.finished = true
    return
  }

  const choice = asObject(asArray(payload.choices)[0])
  const delta = asObject(choice?.delta)
  if (delta) {
    // pi-ai takes the first non-empty reasoning field, so the same precedence
    // is used here; otherwise a provider that fills two of them would duplicate.
    const reasoning = firstString(delta, ['reasoning_content', 'reasoning', 'reasoning_text'])
    if (reasoning) out.push({ type: 'thinking', text: reasoning })

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      out.push({ type: 'text', text: delta.content })
    }

    for (const rawCall of asArray(delta.tool_calls)) {
      const call = asObject(rawCall)
      if (!call) continue
      if (!state.toolIds) {
        state.toolIds = new Map()
        state.toolIdsByCall = new Map()
      }
      const fn = asObject(call.function) ?? {}
      const sourceId = strOr(call.id)
      // Three ways to recognise a call: its id, its index, or — for a provider
      // that sends neither on a fragment — the call that was open last. The
      // third one is a guess, but a fragment that lands on a finished call is
      // worse than a guess.
      let known = sourceId !== undefined ? state.toolIdsByCall.get(sourceId) : undefined
      if (known === undefined && call.index !== undefined) {
        known = state.toolIds.get(call.index)
        // A reused index with a different id is a second call, not a fragment.
        if (known !== undefined && sourceId !== undefined && known.sourceId !== undefined && known.sourceId !== sourceId) {
          known = undefined
        }
      }
      if (known === undefined && sourceId === undefined && call.index === undefined) known = state.openToolCall
      if (known === undefined) {
        known = {
          id: mappedToolId(call.id, 'tool-call', String(fn.name ?? ''), String(call.index ?? state.toolIds.size)),
          name: String(fn.name ?? ''),
          sourceId,
        }
        if (call.index !== undefined) state.toolIds.set(call.index, known)
        if (sourceId !== undefined) state.toolIdsByCall.set(sourceId, known)
        out.push({ type: 'tool-call-start', id: known.id, name: known.name })
      }
      state.openToolCall = known
      if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
        out.push({ type: 'tool-call-delta', id: known.id, argsJson: fn.arguments })
      }
    }
  }

  // Moonshot reports usage on the choice rather than the chunk.
  const usage = asObject(payload.usage) ?? asObject(choice?.usage)
  if (usage) out.push({ type: 'usage', ...completionsUsage(usage) })

  const finishReason = choice?.finish_reason
  if (typeof finishReason === 'string' && finishReason.length > 0) {
    out.push({ type: 'finish', reason: canonicalStopReason('openai-completions', finishReason) })
    state.finished = true
  }
}

/** `anthropic-messages`: `event:` names the frame; usage is split across two frames. */
function decodeAnthropicFrame(frame, payload, out, begin, state) {
  const type = frame.event.length > 0 ? frame.event : String(payload.type ?? '')
  if (type === 'error') {
    begin(out)
    const error = asObject(payload.error)
    out.push({
      type: 'error',
      message: String(error?.message ?? payload.message ?? frame.data),
      retryable: retryableFor(undefined, error?.type, error?.code),
    })
    state.finished = true
    return
  }
  if (type === 'ping' || type.length === 0) return

  begin(out)
  switch (type) {
    case 'message_start': {
      const message = asObject(payload.message) ?? {}
      const usage = asObject(message.usage) ?? {}
      // `input_tokens` already excludes the cache on this side.
      state.input = numOr(usage.input_tokens, 0)
      break
    }
    case 'content_block_start': {
      const block = asObject(payload.content_block) ?? {}
      if (block.type === 'tool_use') {
        const index = numOr(payload.index, 0)
        const id = mappedToolId(block.id, 'tool-call', String(block.name ?? ''), String(index))
        state.toolBlocks ??= new Map()
        state.toolBlocks.set(index, id)
        out.push({ type: 'tool-call-start', id, name: String(block.name ?? '') })
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        out.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        const text = typeof block.thinking === 'string' ? block.thinking : ''
        const signature = strOr(block.signature)
        if (text.length > 0 || signature !== undefined) {
          out.push({ type: 'thinking', text, ...(signature !== undefined ? { signature } : {}) })
        }
      }
      break
    }
    case 'content_block_delta': {
      const delta = asObject(payload.delta) ?? {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        out.push({ type: 'text', text: delta.text })
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        out.push({ type: 'thinking', text: delta.thinking })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json.length > 0) {
        const id = state.toolBlocks?.get(numOr(payload.index, 0))
        // A delta before its block start would have no id to hang on; the block
        // index is the best available identity.
        out.push({ type: 'tool-call-delta', id: id ?? mappedToolId(undefined, 'tool-call', String(payload.index ?? 0)), argsJson: delta.partial_json })
      }
      else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature.length > 0) {
        // The signature is the only part of a thinking block an upstream will
        // accept back, so it rides along as an optional field on the event.
        out.push({ type: 'thinking', text: '', signature: delta.signature })
      }
      break
    }
    case 'message_delta': {
      const usage = asObject(payload.usage)
      if (usage) {
        // pi-ai lets this frame overwrite only the fields that are present
        // (`anthropic-messages.js:643-689`); an encoder that puts the prompt
        // side here instead of in `message_start` therefore still counts.
        out.push({
          type: 'usage',
          input: numOr(usage.input_tokens, numOr(state.input, 0)),
          output: numOr(usage.output_tokens, 0),
        })
      }
      const reason = asObject(payload.delta)?.stop_reason
      if (typeof reason === 'string' && reason.length > 0) {
        out.push({ type: 'finish', reason: canonicalStopReason('anthropic-messages', reason) })
        state.finished = true
      }
      break
    }
    case 'message_stop':
      if (!state.finished) {
        out.push({ type: 'finish', reason: 'stop' })
        state.finished = true
      }
      break
    default:
      break
  }
}

/** `openai-responses`: the payload's own `type` is the event name. */
function decodeResponsesFrame(frame, payload, out, begin, state) {
  const type = String(payload.type ?? frame.event ?? '')
  if (type === 'error' || type === 'response.failed') {
    begin(out)
    const response = asObject(payload.response)
    const error = asObject(response?.error) ?? asObject(payload.error)
    const details = asObject(response?.incomplete_details)
    const message = error
      ? String(error.message ?? error.code ?? 'upstream error')
      : details?.reason
        ? `incomplete: ${details.reason}`
        : 'upstream error'
    out.push({ type: 'error', message, retryable: retryableFor(undefined, error?.code, error?.type) })
    state.finished = true
    return
  }
  if (type.length === 0) return

  begin(out)
  switch (type) {
    case 'response.output_item.added': {
      const item = asObject(payload.item) ?? {}
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const id = mappedToolId(item.call_id ?? item.id, 'tool-call', String(item.name ?? ''), String(payload.output_index ?? 0))
        state.toolItems ??= new Map()
        state.toolItems.set(String(payload.item_id ?? item.id ?? ''), id)
        state.sawToolCall = true
        out.push({ type: 'tool-call-start', id, name: String(item.name ?? '') })
      }
      break
    }
    case 'response.output_text.delta':
    case 'response.refusal.delta': {
      const delta = typeof payload.delta === 'string' ? payload.delta : ''
      if (delta.length > 0) out.push({ type: 'text', text: delta })
      break
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = typeof payload.delta === 'string' ? payload.delta : ''
      if (delta.length > 0) out.push({ type: 'thinking', text: delta })
      break
    }
    case 'response.reasoning_summary_part.done':
      // pi-ai joins summary parts with a blank line; keep the separator so the
      // replayed reasoning reads the same.
      out.push({ type: 'thinking', text: '\n\n' })
      break
    case 'response.function_call_arguments.delta': {
      const delta = typeof payload.delta === 'string' ? payload.delta : ''
      if (delta.length === 0) break
      const id = state.toolItems?.get(String(payload.item_id ?? ''))
      out.push({ type: 'tool-call-delta', id: id ?? mappedToolId(payload.item_id, 'tool-call', String(payload.output_index ?? 0)), argsJson: delta })
      break
    }
    case 'response.completed':
    case 'response.incomplete': {
      const response = asObject(payload.response) ?? {}
      const usage = asObject(response.usage)
      if (usage) {
        const details = asObject(usage.input_tokens_details) ?? {}
        const cacheRead = numOr(details.cached_tokens, 0)
        const cacheWrite = numOr(details.cache_write_tokens, 0)
        out.push({
          type: 'usage',
          // Same subtraction as the completions side: `input_tokens` is gross.
          input: Math.max(0, numOr(usage.input_tokens, 0) - cacheRead - cacheWrite),
          output: numOr(usage.output_tokens, 0),
        })
      }
      let reason = String(response.status ?? 'completed')
      const incomplete = asObject(response.incomplete_details)
      if (incomplete?.reason) reason = `incomplete.${incomplete.reason}`
      const mapped = canonicalStopReason('openai-responses', reason)
      // pi-ai re-labels a `completed` response that produced tool calls as a
      // tool use (`openai-responses-shared.js:487-489`); without the same
      // fixup a translated turn would look like it merely stopped talking.
      out.push({ type: 'finish', reason: mapped === 'stop' && state.sawToolCall === true ? 'tool-call' : mapped })
      state.finished = true
      break
    }
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// Stream encoding — canonical events → inbound-protocol SSE frames
// ---------------------------------------------------------------------------

/**
 * A JSON frame as the two OpenAI dialects write it: `data:` only.
 * @param {object} payload
 */
function dataFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** A frame the anthropic dialect writes: an `event:` name plus its JSON. */
function eventFrame(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** Canonical finish reason back to an OpenAI `finish_reason`. */
function openaiFinishReason(reason) {
  if (reason === 'stop') return 'stop'
  if (reason === 'length') return 'length'
  if (reason === 'tool-call') return 'tool_calls'
  if (reason === 'content-filter') return 'content_filter'
  return reason
}

/** Canonical finish reason back to an anthropic `stop_reason`. */
function anthropicStopReason(reason) {
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool-call') return 'tool_use'
  if (reason === 'content-filter') return 'refusal'
  return 'end_turn'
}

/**
 * Encode canonical events as the SSE the inbound route's client is parsing.
 *
 * Text, thinking and tool traffic is forwarded as it arrives; the terminal
 * frames (`finish`, the usage block, the protocol's terminator) are held until
 * `end()`. Two reasons: every protocol wants them last, and only at `end()` is
 * it known whether the upstream finished at all — a stream that stopped early
 * still gets a well-formed close instead of a socket that simply dies.
 *
 * @param {'openai-completions'|'anthropic-messages'|'openai-responses'} protocol
 * @param {{model?: string}} [options]
 * @returns {{push: (event: object) => string[], end: () => string[], headers: Record<string, string>}}
 */
export function createStreamEncoder(protocol, options = {}) {
  assertProtocol(protocol)
  const model = typeof options.model === 'string' ? options.model : ''
  const state = {
    started: false,
    finished: false,
    errored: false,
    ended: false,
    usage: undefined,
    finishReason: undefined,
  }
  const headers = { ...SSE_HEADERS }

  const writers = {
    'openai-completions': () => completionsWriter(model, state),
    'anthropic-messages': () => anthropicWriter(model, state),
    'openai-responses': () => responsesWriter(model, state),
    'google-generative-ai': () => geminiWriter(model, state),
  }
  const writer = writers[protocol]()

  return {
    push(event) {
      // A late event after the terminal frame would append a second one.
      if (state.ended || event === null || typeof event !== 'object') return []
      return writer.push(event)
    },
    end() {
      // Idempotent: a caller that closes in both its success path and a `finally`
      // must not emit a second `message_stop`.
      if (state.ended) return []
      state.ended = true
      return writer.end()
    },
    headers,
  }
}

/** `openai-completions` writer: `chat.completion.chunk` frames then `[DONE]`. */
function completionsWriter(model, state) {
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-gw${stableHash(model)}`
  const toolIndexes = new Map()

  const chunk = (delta, finishReason) => dataFrame({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  function start() {
    if (state.started) return []
    state.started = true
    return [chunk({ role: 'assistant', content: '' }, null)]
  }

  return {
    push(event) {
      switch (event.type) {
        case 'start':
          return start()
        case 'text':
          if (typeof event.text !== 'string' || event.text.length === 0) return []
          return [...start(), chunk({ content: event.text }, null)]
        case 'thinking':
          if (typeof event.text !== 'string' || event.text.length === 0) return []
          // `reasoning_content` is the field DeepSeek and most reasoning
          // endpoints read back; pi-ai accepts `reasoning` and `reasoning_text`
          // as aliases, so one spelling covers the inbound parsers.
          return [...start(), chunk({ reasoning_content: event.text }, null)]
        case 'tool-call-start': {
          const id = String(event.id ?? '')
          if (!toolIndexes.has(id)) toolIndexes.set(id, toolIndexes.size)
          const index = toolIndexes.get(id)
          return [...start(), chunk({
            tool_calls: [{ index, id, type: 'function', function: { name: String(event.name ?? ''), arguments: '' } }],
          }, null)]
        }
        case 'tool-call-delta': {
          const id = String(event.id ?? '')
          if (!toolIndexes.has(id)) toolIndexes.set(id, toolIndexes.size)
          const args = typeof event.argsJson === 'string' ? event.argsJson : ''
          if (args.length === 0) return []
          return [...start(), chunk({ tool_calls: [{ index: toolIndexes.get(id), function: { arguments: args } }] }, null)]
        }
        case 'usage':
          state.usage = { input: numOr(event.input, 0), output: numOr(event.output, 0) }
          return []
        case 'finish':
          state.finishReason = typeof event.reason === 'string' ? event.reason : 'stop'
          state.finished = true
          return []
        case 'error':
          state.errored = true
          // OpenAI's own stream convention: an `error` object instead of a chunk.
          return [dataFrame({
            error: { message: String(event.message ?? 'upstream error'), type: 'upstream_error' },
            ...(typeof event.retryable === 'boolean' ? { retryable: event.retryable } : {}),
          })]
        default:
          return []
      }
    },
    end() {
      const out = []
      if (state.finished) {
        out.push(chunk({}, openaiFinishReason(state.finishReason)))
        if (state.usage) {
          // The usage block is a `choices: []` chunk, exactly what
          // `stream_options.include_usage` produces.
          out.push(dataFrame({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: state.usage.input,
              completion_tokens: state.usage.output,
              total_tokens: state.usage.input + state.usage.output,
            },
          }))
        }
      }
      if (state.started || state.errored) out.push('data: [DONE]\n\n')
      return out
    },
  }
}

/**
 * `anthropic-messages` writer.
 *
 * Text and thinking stream inside content blocks; tool calls are buffered and
 * emitted as complete blocks at the end. That buffering is deliberate: a block
 * index must keep increasing, so two interleaved calls arriving from an
 * OpenAI-style stream (which numbers deltas per call rather than blocks) cannot
 * be replayed as two blocks without deciding an order — the end of the stream
 * is where that order is known.
 */
function anthropicWriter(model, state) {
  const id = `msg_gw${stableHash(model)}`
  let index = -1
  let open // { type: 'text'|'thinking', index }
  const tools = []

  const startFrame = () => eventFrame('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  function start() {
    if (state.started) return []
    state.started = true
    return [startFrame()]
  }

  function close() {
    if (!open) return []
    const out = [eventFrame('content_block_stop', { type: 'content_block_stop', index: open.index })]
    open = undefined
    return out
  }

  function openBlock(type) {
    index += 1
    open = { type, index }
    const block = type === 'text'
      ? { type: 'text', text: '' }
      : { type: 'thinking', thinking: '' }
    return [eventFrame('content_block_start', { type: 'content_block_start', index, content_block: block })]
  }

  /** Open a block of `type`, closing whatever was open if it is a different kind. */
  function ensure(type) {
    if (open?.type === type) return []
    return [...close(), ...openBlock(type)]
  }

  return {
    push(event) {
      switch (event.type) {
        case 'start':
          return start()
        case 'text': {
          if (typeof event.text !== 'string' || event.text.length === 0) return []
          return [
            ...start(),
            ...ensure('text'),
            eventFrame('content_block_delta', {
              type: 'content_block_delta',
              index: open.index,
              delta: { type: 'text_delta', text: event.text },
            }),
          ]
        }
        case 'thinking': {
          const text = typeof event.text === 'string' ? event.text : ''
          const signature = typeof event.signature === 'string' ? event.signature : ''
          if (text.length === 0 && signature.length === 0) return []
          const out = [...start(), ...ensure('thinking')]
          if (text.length > 0) {
            out.push(eventFrame('content_block_delta', {
              type: 'content_block_delta',
              index: open.index,
              delta: { type: 'thinking_delta', thinking: text },
            }))
          }
          // A signature cannot be manufactured, but one this provider issued can
          // be handed back: it is what makes the block replayable next turn.
          if (signature.length > 0) {
            out.push(eventFrame('content_block_delta', {
              type: 'content_block_delta',
              index: open.index,
              delta: { type: 'signature_delta', signature },
            }))
          }
          return out
        }
        case 'tool-call-start':
          tools.push({ id: String(event.id ?? ''), name: String(event.name ?? ''), args: '' })
          return [...start()]
        case 'tool-call-delta': {
          const call = tools.find((entry) => entry.id === String(event.id ?? ''))
          if (call && typeof event.argsJson === 'string') call.args += event.argsJson
          return []
        }
        case 'usage':
          state.usage = { input: numOr(event.input, 0), output: numOr(event.output, 0) }
          return []
        case 'finish':
          state.finishReason = typeof event.reason === 'string' ? event.reason : 'stop'
          state.finished = true
          return []
        case 'error':
          state.errored = true
          state.errorMessage = String(event.message ?? 'upstream error')
          return [eventFrame('error', {
            type: 'error',
            error: { type: 'api_error', message: state.errorMessage },
            ...(typeof event.retryable === 'boolean' ? { retryable: event.retryable } : {}),
          })]
        default:
          return []
      }
    },
    end() {
      // `event: error` is terminal in this dialect: the SDK throws on it, and a
      // `message_delta` claiming a stop reason afterwards would look like success
      // to anything that did not.
      if (state.errored) return []
      const out = [...start(), ...close()]
      for (const call of tools) {
        index += 1
        out.push(eventFrame('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        }))
        if (call.args.length > 0) {
          out.push(eventFrame('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: call.args },
          }))
        }
        out.push(eventFrame('content_block_stop', { type: 'content_block_stop', index }))
      }
      out.push(eventFrame('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: anthropicStopReason(state.finishReason ?? 'stop'),
          stop_sequence: null,
        },
        usage: {
          input_tokens: state.usage?.input ?? 0,
          output_tokens: state.usage?.output ?? 0,
        },
      }))
      out.push(eventFrame('message_stop', { type: 'message_stop' }))
      return out
    },
  }
}

/**
 * `openai-responses` writer.
 *
 * Every kind of output is an item: a reasoning item for thinking, a message
 * item for text, a function-call item per tool call. Argument deltas carry
 * their `item_id`, so parallel calls need no serialisation here — unlike the
 * anthropic writer.
 */
function responsesWriter(model, state) {
  const id = `resp_gw${stableHash(model)}`
  const createdAt = Math.floor(Date.now() / 1000)
  /** Finished items, kept with their slot so the final `output` is in order. */
  const collected = []
  let outputIndex = -1
  let message // { index, itemId, text }
  let reasoning // { index, itemId, text }
  const calls = new Map()

  function start() {
    if (state.started) return []
    state.started = true
    return [eventFrame('response.created', {
      type: 'response.created',
      response: { id, object: 'response', created_at: createdAt, status: 'in_progress', model, output: [] },
    })]
  }

  function closeMessage() {
    const current = message
    if (!current) return []
    message = undefined
    const part = { type: 'output_text', text: current.text, annotations: [] }
    const item = { type: 'message', role: 'assistant', status: 'completed', id: current.itemId, content: [part] }
    collected.push({ index: current.index, item })
    return [
      eventFrame('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: current.itemId,
        output_index: current.index,
        content_index: 0,
        text: current.text,
      }),
      eventFrame('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: current.itemId,
        output_index: current.index,
        content_index: 0,
        part,
      }),
      eventFrame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: current.index,
        item,
      }),
    ]
  }

  function closeReasoning() {
    const current = reasoning
    if (!current) return []
    reasoning = undefined
    const item = {
      type: 'reasoning',
      id: current.itemId,
      summary: [{ type: 'summary_text', text: current.text }],
    }
    collected.push({ index: current.index, item })
    return [eventFrame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: current.index,
      item,
    })]
  }

  function openMessage() {
    outputIndex += 1
    message = { index: outputIndex, itemId: `msg_gw${stableHash(`${model}:${outputIndex}`)}`, text: '' }
    return [eventFrame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: message.index,
      item: { type: 'message', role: 'assistant', status: 'in_progress', id: message.itemId, content: [] },
    })]
  }

  function openReasoning() {
    outputIndex += 1
    reasoning = { index: outputIndex, itemId: `rs_gw${stableHash(`${model}:${outputIndex}`)}`, text: '' }
    return [eventFrame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: reasoning.index,
      item: { type: 'reasoning', id: reasoning.itemId, summary: [] },
    })]
  }

  return {
    push(event) {
      switch (event.type) {
        case 'start':
          return start()
        case 'text': {
          if (typeof event.text !== 'string' || event.text.length === 0) return []
          const out = [...start()]
          if (!message) out.push(...closeReasoning(), ...openMessage())
          message.text += event.text
          out.push(eventFrame('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: message.itemId,
            output_index: message.index,
            content_index: 0,
            delta: event.text,
          }))
          return out
        }
        case 'thinking': {
          if (typeof event.text !== 'string' || event.text.length === 0) return []
          const out = [...start()]
          if (!reasoning) out.push(...closeMessage(), ...openReasoning())
          reasoning.text += event.text
          out.push(eventFrame('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoning.itemId,
            output_index: reasoning.index,
            summary_index: 0,
            delta: event.text,
          }))
          return out
        }
        case 'tool-call-start': {
          const callId = String(event.id ?? '')
          if (calls.has(callId)) return []
          outputIndex += 1
          const entry = {
            index: outputIndex,
            itemId: itemIdFor(callId),
            callId,
            name: String(event.name ?? ''),
            args: '',
          }
          calls.set(callId, entry)
          return [
            ...start(),
            // A tool call ends any open text/reasoning item: an item cannot be
            // interleaved with another item of a different type.
            ...closeMessage(),
            ...closeReasoning(),
            eventFrame('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: entry.index,
              item: {
                type: 'function_call',
                id: entry.itemId,
                call_id: entry.callId,
                name: entry.name,
                arguments: '',
                status: 'in_progress',
              },
            }),
          ]
        }
        case 'tool-call-delta': {
          const callId = String(event.id ?? '')
          const entry = calls.get(callId)
          if (!entry || typeof event.argsJson !== 'string' || event.argsJson.length === 0) return []
          entry.args += event.argsJson
          return [eventFrame('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: entry.itemId,
            output_index: entry.index,
            delta: event.argsJson,
          })]
        }
        case 'usage':
          state.usage = { input: numOr(event.input, 0), output: numOr(event.output, 0) }
          return []
        case 'finish':
          state.finishReason = typeof event.reason === 'string' ? event.reason : 'stop'
          state.finished = true
          return []
        case 'error':
          state.errored = true
          state.errorMessage = String(event.message ?? 'upstream error')
          return [eventFrame('error', {
            type: 'error',
            code: 'upstream_error',
            message: state.errorMessage,
            ...(typeof event.retryable === 'boolean' ? { retryable: event.retryable } : {}),
          })]
        default:
          return []
      }
    },
    end() {
      if (state.errored) {
        // `response.completed` after an error would advertise a success the
        // client was just told it did not get; the dialect has its own terminal
        // event for this.
        return [eventFrame('response.failed', {
          type: 'response.failed',
          response: {
            id,
            object: 'response',
            created_at: createdAt,
            status: 'failed',
            model,
            output: [],
            error: { code: 'upstream_error', message: state.errorMessage },
          },
        })]
      }
      const out = [...start(), ...closeMessage(), ...closeReasoning()]
      for (const call of calls.values()) {
        out.push(eventFrame('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: call.itemId,
          output_index: call.index,
          arguments: call.args,
        }))
        out.push(eventFrame('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: call.index,
          item: {
            type: 'function_call',
            id: call.itemId,
            call_id: call.callId,
            name: call.name,
            arguments: call.args,
            status: 'completed',
          },
        }))
        collected.push({
          index: call.index,
          item: {
            type: 'function_call',
            id: call.itemId,
            call_id: call.callId,
            name: call.name,
            arguments: call.args,
            status: 'completed',
          },
        })
      }
      const usage = state.usage ?? { input: 0, output: 0 }
      out.push(eventFrame(state.finished ? 'response.completed' : 'response.incomplete', {
        type: state.finished ? 'response.completed' : 'response.incomplete',
        response: {
          id,
          object: 'response',
          created_at: createdAt,
          status: state.finished ? 'completed' : 'incomplete',
          model,
          output: collected.sort((a, b) => a.index - b.index).map((entry) => entry.item),
          usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      }))
      return out
    },
  }
}
