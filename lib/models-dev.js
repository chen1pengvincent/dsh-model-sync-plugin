/**
 * The public models.dev catalog, used only as a *fallback* source of metadata.
 *
 * This module deliberately does **not** replace the provider itself as the
 * authority. It answers one question — "what does the public catalog say about
 * this exact provider/model pair?" — and never guesses across providers. A model
 * that is only known under a different provider, or only under a canonical id,
 * is still useful for its name and family, but its numbers are not copied onto
 * this route: the same checkpoint can have different context and output limits
 * on OpenRouter, Google and a reseller.
 *
 * Everything returned here is marked with its provenance so the panel can say
 * "models.dev, medium confidence" instead of presenting a fallback as fact.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { requestJson } from './http.js'

/** Public catalog endpoint. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** The catalog is large (about 6.7 MB); the default 4 MB HTTP cap would truncate it. */
export const MODELS_DEV_MAX_BYTES = 16 * 1024 * 1024

/** Re-fetch at most once a day unless explicitly forced. */
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000

/** All levels the DSH schema knows. `off` is never a capability. */
export const DSH_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Provider names differ between DSH and models.dev only where the identity is
 * genuinely the same. This map is intentionally small: an alias is a claim that
 * the credentials and the model ids identify the same upstream, and a wrong
 * claim is worse than an unknown.
 */
const PROVIDER_ALIASES = {
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-code-plan-global': 'kimi-code-plan-global',
  'kimi-code-plan-cn': 'kimi-code-plan-cn',
}

/** The models.dev provider id for one DSH provider id. */
export function modelsDevProvider(provider) {
  return PROVIDER_ALIASES[provider] ?? provider
}

/** First positive integer among the candidates. */
function positive(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

/** A stable, non-empty string, or undefined. */
function text(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Turn one model's `reasoning_options` into the DSH `reasoningEfforts` object.
 *
 * models.dev has three option kinds: `effort` (named levels), `toggle` (on/off)
 * and `budget_tokens` (numeric budget). DSH's schema models named levels, so
 * only `effort` can be represented. A toggle or a budget is not silently coerced
 * into a level: that would invent a wire value the provider never advertised.
 *
 * @param {unknown} options
 * @returns {Record<string, string> | undefined}
 */
export function reasoningEffortsFromOptions(options) {
  if (!Array.isArray(options)) return undefined
  const seen = new Set()
  /** @type {Record<string, string>} */
  const efforts = {}
  for (const option of options) {
    if (option === null || typeof option !== 'object') continue
    if (/** @type {any} */ (option).type !== 'effort') continue
    const values = /** @type {any} */ (option).values
    if (!Array.isArray(values)) continue
    for (const raw of values) {
      if (typeof raw !== 'string') continue
      const level = raw.trim().toLowerCase()
      if (!DSH_LEVELS.includes(level) || seen.has(level)) continue
      seen.add(level)
      efforts[level] = level
    }
  }
  return seen.size === 0 ? undefined : efforts
}

/**
 * Build a provider/model index from a models.dev `api.json` payload.
 *
 * Keep exact route entries for capabilities. For display-only fallback, the
 * first model encountered for a canonical id or its short name wins.
 *
 * @param {unknown} payload
 * @param {number} [fetchedAt]
 */
export function indexModelsDev(payload, fetchedAt = Date.now()) {
  /** @type {Map<string, any>} */
  const providers = new Map()
  /** @type {Map<string, any>} */
  const displayModels = new Map()
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { fetchedAt, providers, displayModels }
  }
  for (const [providerId, rawProvider] of Object.entries(payload)) {
    const provider = /** @type {any} */ (rawProvider)
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) continue
    const models = new Map()
    const sourceModels = provider.models
    if (sourceModels !== null && typeof sourceModels === 'object' && !Array.isArray(sourceModels)) {
      for (const [modelId, rawModel] of Object.entries(sourceModels)) {
        const model = /** @type {any} */ (rawModel)
        if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
        models.set(modelId, model)
        const canonical = text(model.canonical_model_id)
        if (canonical !== undefined) {
          if (!displayModels.has(canonical)) displayModels.set(canonical, model)
          const suffix = canonical.slice(canonical.lastIndexOf('/') + 1)
          if (!displayModels.has(suffix)) displayModels.set(suffix, model)
        }
      }
    }
    providers.set(providerId, {
      id: providerId,
      name: text(provider.name) ?? providerId,
      doc: text(provider.doc),
      models,
    })
  }
  return { fetchedAt, providers, displayModels }
}

/**
 * The exact models.dev entry for one DSH route, or undefined.
 *
 * Exact means the same provider and the same model id. The only indirection is
 * the explicit provider alias table above. There is deliberately no
 * `byModel`/canonical fallback here.
 *
 * @param {ReturnType<typeof indexModelsDev>} index
 * @param {string} provider
 * @param {string} modelId
 * @returns {{provider: string, id: string, model: any} | undefined}
 */
export function lookupModelsDev(index, provider, modelId) {
  const id = modelsDevProvider(provider)
  const model = index.providers.get(id)?.models.get(modelId)
  if (model === undefined) return undefined
  return { provider: id, id: modelId, model }
}

/**
 * The input modalities DSH can express, taken from one models.dev entry.
 *
 * DSH's pi-ai schema accepts only `text` and `image`; models.dev also knows
 * `audio`, `video` and `pdf`, which are dropped rather than written into a
 * field the host would reject. This is exact-entry data only: a canonical
 * fallback says nothing about the route's capabilities.
 *
 * @param {any} meta
 * @returns {string[] | undefined}
 */
export function inputFromMeta(meta) {
  const raw = Array.isArray(meta?.modalities?.input) ? meta.modalities.input : []
  const input = []
  for (const value of raw) {
    if ((value === 'text' || value === 'image') && !input.includes(value)) input.push(value)
  }
  if (!input.includes('text')) return undefined
  return ['text', ...input.filter((value) => value !== 'text')]
}

/** Human-readable modality label from models.dev `modalities`. */
export function modalityLabel(meta) {
  const input = Array.isArray(meta?.modalities?.input) ? meta.modalities.input : []
  const labels = []
  const add = (key, label) => {
    if (input.includes(key) && !labels.includes(label)) labels.push(label)
  }
  add('text', '文本')
  add('image', '图像')
  add('audio', '音频')
  add('video', '视频')
  add('pdf', 'PDF')
  return labels.length === 0 ? undefined : labels.join('+')
}

/**
 * Metadata for one exact route. Numeric and reasoning fields are only present
 * when models.dev has an exact provider/model entry. Family/modality may fall
 * back to a canonical entry because those are descriptive, not contractual.
 *
 * @param {ReturnType<typeof indexModelsDev>} index
 * @param {string} provider
 * @param {string} modelId
 * @returns {{
 *   contextWindow?: number,
 *   maxTokens?: number,
 *   reasoningEfforts?: Record<string, string>,
 *   input?: string[],
 *   family?: string,
 *   modality?: string,
 *   canonical?: string,
 *   source: 'models.dev',
 *   confidence: 'medium'|'low',
 *   exact: boolean,
 * } | undefined}
 */
export function metadataFor(index, provider, modelId) {
  const exact = lookupModelsDev(index, provider, modelId)
  const meta = exact?.model ?? index.displayModels.get(modelId)
  if (meta === undefined) return undefined
  const contextWindow = exact === undefined ? undefined : positive(meta.limit?.context, meta.limit?.input)
  const maxTokens = exact === undefined ? undefined : positive(meta.limit?.output)
  const reasoningEfforts = exact === undefined ? undefined : reasoningEffortsFromOptions(meta.reasoning_options)
  const input = exact === undefined ? undefined : inputFromMeta(meta)
  const family = text(meta.family)
  const modality = modalityLabel(meta)
  // A canonical-only match is display information; it must not be presented as
  // an exact answer for this route.
  const hasValue = contextWindow !== undefined || maxTokens !== undefined || reasoningEfforts !== undefined ||
    input !== undefined || family !== undefined || modality !== undefined
  if (!hasValue) return undefined
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(input === undefined ? {} : { input }),
    ...(family === undefined ? {} : { family }),
    ...(modality === undefined ? {} : { modality }),
    ...(text(meta.canonical_model_id) === undefined ? {} : { canonical: text(meta.canonical_model_id) }),
    source: 'models.dev',
    confidence: exact === undefined ? 'low' : 'medium',
    exact: exact !== undefined,
  }
}

/** Whether a payload has at least one usable provider/model entry. */
export function hasCatalogModels(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  for (const provider of Object.values(payload)) {
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) continue
    const models = /** @type {any} */ (provider).models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    if (Object.values(models).some((model) => model !== null && typeof model === 'object' && !Array.isArray(model))) return true
  }
  return false
}

/**
 * Read a previously cached catalog, tolerating a corrupt file.
 * @param {string} path
 */
export async function readModelsDevCache(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (parsed.payload === undefined || !hasCatalogModels(parsed.payload)) return undefined
    return {
      payload: parsed.payload,
      fetchedAt: Number(parsed.fetchedAt) || 0,
    }
  } catch {
    return undefined
  }
}

/** Write the raw payload and fetch time atomically. */
export async function writeModelsDevCache(path, payload, fetchedAt = Date.now()) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await writeFile(temp, `${JSON.stringify({ fetchedAt, payload })}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

/**
 * Load the catalog, preferring a fresh cache and falling back to a stale one.
 *
 * A network failure with a stale cache is not fatal: the panel should keep
 * working with yesterday's metadata and show that it is stale.
 *
 * @param {object} options
 * @param {string} options.cachePath
 * @param {(options: object) => Promise<{status: number, json?: unknown}>} [options.fetch]
 * @param {number} [options.ttlMs]
 * @param {boolean} [options.force]
 * @param {AbortSignal} [options.signal]
 * @param {() => number} [options.now]
 */
export async function loadModelsDev(options) {
  const {
    cachePath,
    fetch = requestJson,
    ttlMs = MODELS_DEV_TTL_MS,
    force = false,
    now = Date.now,
  } = options
  // A forced refresh only needs the on-disk catalog if the network fails.
  const cached = force ? undefined : await readModelsDevCache(cachePath)
  const age = cached === undefined ? Infinity : now() - cached.fetchedAt
  if (cached !== undefined && age >= 0 && age < ttlMs) {
    return {
      index: indexModelsDev(cached.payload, cached.fetchedAt),
      fetchedAt: cached.fetchedAt,
      stale: false,
      fromCache: true,
    }
  }
  try {
    options.signal?.throwIfAborted()
    const reply = await fetch({
      url: MODELS_DEV_URL,
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
      timeoutMs: 20_000,
      maxBytes: MODELS_DEV_MAX_BYTES,
      signal: options.signal,
    })
    options.signal?.throwIfAborted()
    if (reply.status < 200 || reply.status >= 300) throw new Error(`models.dev answered ${String(reply.status)}`)
    const payload = reply.json
    if (!hasCatalogModels(payload)) {
      throw new Error('models.dev returned an empty catalog')
    }
    const fetchedAt = now()
    await writeModelsDevCache(cachePath, payload, fetchedAt).catch(() => undefined)
    return {
      index: indexModelsDev(payload, fetchedAt),
      fetchedAt,
      stale: false,
      fromCache: false,
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    const fallback = force ? await readModelsDevCache(cachePath) : cached
    if (fallback !== undefined) {
      return {
        index: indexModelsDev(fallback.payload, fallback.fetchedAt),
        fetchedAt: fallback.fetchedAt,
        stale: true,
        fromCache: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    throw error
  }
}
