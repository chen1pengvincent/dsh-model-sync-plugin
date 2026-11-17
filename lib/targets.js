/**
 * Enumerating what the harness is actually configured to serve.
 *
 * The registry is the only source of truth here. `llm.listConfigurableProviders()`
 * names every route the installed adapters can configure, and a settings
 * section that carries an object at the route's `settingsPath` is what makes
 * one of them *configured* — the same test the Models page uses to decide
 * whether a card is drawn. A route that is merely registered is not configured
 * and must not appear in this plugin's list.
 *
 * Model lists are read through `llm.listModels`, i.e. through the route the
 * user's composer will actually use, so the set this module diffs against is
 * the set of ids that exist today, whether they come from an explicit `models`
 * array or from the adapter's shipped catalog.
 */

import { createHash } from 'node:crypto'

import { hintedBaseURL } from './endpoints.js'

/**
 * Walk a settings section by path.
 * @param {unknown} root
 * @param {readonly string[]} path
 * @returns {unknown}
 */
export function atPath(root, path) {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = /** @type {Record<string, unknown>} */ (node)[key]
  }
  return node
}

/**
 * Keys the previous version of this plugin synthesised so that one provider
 * could serve several protocols: `<base>-chat`, `-messages`, `-responses`.
 *
 * Only a key whose *parent* route is also configured counts as synthetic. A
 * provider someone created by hand under the same name is theirs, and stays
 * visible and manageable — which is why this is a predicate over the whole
 * provider table rather than a name match.
 *
 * @param {readonly string[]} providers every provider key in one settings section
 * @returns {string[]} the synthetic ones
 */
export function syntheticSiblings(providers) {
  const present = new Set(providers)
  return providers.filter((provider) => {
    const match = /^(.+)-(chat|messages|responses)$/.exec(provider)
    return match !== null && present.has(match[1])
  })
}

/** A plain object, i.e. something a provider profile can be. */
function isProfile(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read every section this profile exposes, without secrets when the service
 * supports redaction. Redaction is what makes it safe to keep a copy of the
 * effective configuration on disk for the "restore" button.
 * @param {any} settings
 * @returns {{ns: string, value: unknown, revision: number}[]}
 */
export function describeSections(settings) {
  const described = settings.describe?.({ redactSecrets: true })
  if (Array.isArray(described)) return described
  return []
}

/**
 * The provider routes this profile has configured, with everything needed to
 * check them and to write their model list back.
 *
 * @param {any} ctx harness context
 * @returns {Promise<{targets: any[], problems: {provider: string, reason: string}[]}>}
 */
export async function configuredTargets(ctx) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const profileDir = ctx.get('profileContext')?.dir
  if (llm === undefined || settings === undefined) {
    return { targets: [], problems: [{ provider: '*', reason: 'the llm or settings service is unavailable' }] }
  }
  const profileId = typeof profileDir === 'string' ? createHash('sha256').update(profileDir).digest('hex').slice(0, 24) : 'unknown'
  const descriptors = describeSections(settings)
  const directory = llm.listConfigurableProviders?.() ?? []
  /** @type {any[]} */
  const targets = []
  /** @type {{provider: string, reason: string}[]} */
  const problems = []

  for (const entry of directory) {
    const descriptor = descriptors.find((row) => row.ns === entry.settingsNs)
    if (descriptor === undefined) continue
    const profile = atPath(descriptor.value, entry.settingsPath)
    if (!isProfile(profile)) continue

    const path = /** @type {Record<string, unknown>} */ (profile)
    const deepseek = entry.settingsPath.length === 0 && entry.provider === 'deepseek-official'
    const environment = deepseek ? ctx.get('launchEnvironment') : undefined
    const apiEnv = typeof path['apiKeyEnv'] === 'string'
      ? path['apiKeyEnv']
      : deepseek ? 'DEEPSEEK_API_KEY' : Array.isArray(entry.nativeAuth?.env) ? entry.nativeAuth.env[0] : undefined
    const baseURL = typeof path['baseURL'] === 'string'
      ? path['baseURL']
      : Array.isArray(entry.baseURLEnv) && process.env[entry.baseURLEnv[0]] !== undefined
        ? process.env[entry.baseURLEnv[0]]
        : entry.defaultBaseURL ?? hintedBaseURL(entry.provider)

    /** @type {string[]} */
    let effectiveIds = []
    try {
      const models = await llm.listModels(entry.provider)
      effectiveIds = Array.isArray(models) ? models.map((model) => String(model.id)) : []
    } catch (error) {
      problems.push({ provider: entry.provider, reason: `could not read the route's model list: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (effectiveIds.length === 0) continue

    let apiKey
    if (apiEnv !== undefined) {
      try {
        const resolved = credentials === undefined && deepseek
          ? (environment?.get(apiEnv)?.value ?? (environment === undefined ? process.env[apiEnv] : undefined))
          : await credentials?.resolve(apiEnv)
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (typeof value === 'string' && value.length > 0) apiKey = value
      } catch {
        apiKey = undefined
      }
    }

    const rawModels = path['models']
    targets.push({
      provider: entry.provider,
      displayName: typeof path['displayName'] === 'string' ? path['displayName'] : entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: [...entry.settingsPath, 'models'],
      // The profile's own protocol wins when it sets one; a mixed-catalog
      // route leaves it unset and the ladder decides per check.
      api: typeof path['api'] === 'string' ? path['api'] : undefined,
      baseURL: typeof baseURL === 'string' ? baseURL : undefined,
      requestBaseURL: typeof path['baseURL'] === 'string' ? path['baseURL'] : entry.defaultBaseURL,
      apiEnv,
      apiKey,
      headers: isProfile(path['headers']) ? path['headers'] : undefined,
      /** Whether this route currently states its own model list (vs inheriting the adapter's catalog). */
      explicitModels: Array.isArray(rawModels),
      /** The entries to preserve verbatim when a write happens. */
      modelEntries: Array.isArray(rawModels) ? rawModels : undefined,
      /**
       * `modelOverrides` and `models` cannot coexist (`resolveRouteModels`
       * rejects the pair), so a route carrying overrides must not be given a
       * list. The panel reports this instead of failing at write time.
       */
      hasModelOverrides: isProfile(path['modelOverrides']) && Object.keys(/** @type {object} */ (path['modelOverrides'])).length > 0,
      /**
       * Which adapter serves the route. Only the deepseek adapter validates a
       * stated `models` array without falling back to per-id catalog metadata,
       * so it is the adapter where a bare `{id}` materialization loses
       * capabilities (image input, context window, display name).
       */
      adapter: deepseek ? 'deepseek' : 'pi-ai',
      ...(deepseek ? {
        listingBaseURL: path['baseURL'] ?? (environment?.get('DEEPSEEK_BASE_URL')?.value
          ?? (environment === undefined ? process.env.DEEPSEEK_BASE_URL : undefined)) ?? 'https://api.deepseek.com',
        modelMaxTokens: path['maxTokens'] ?? 256_000,
      } : {}),
      effectiveIds,
      revision: descriptor.revision,
      // Stable across restarts because it is derived from configuration
      // identity, not from a random id at boot.
      key: `route_${createHash('sha256').update(`${profileId}|${entry.settingsNs}|${entry.settingsPath.join('.')}|${entry.provider}`).digest('hex').slice(0, 16)}`,
      declared: entry.declared === true,
    })
  }

  return { targets, problems }
}

/**
 * Routes that exist in the profile's settings but are not configurable entries,
 * i.e. leftover provider keys written by an earlier version of this plugin.
 * These have no route behind them; they only draw a card on the Models page.
 *
 * @param {any} ctx
 * @returns {string[]}
 */
export function foreignProviderKeys(ctx) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  if (llm === undefined || settings === undefined) return []
  const known = new Set((llm.listConfigurableProviders?.() ?? []).map((entry) => entry.provider))
  const descriptors = describeSections(settings)
  /** @type {string[]} */
  const foreign = []
  for (const descriptor of descriptors) {
    const providers = atPath(descriptor.value, ['providers'])
    if (!isProfile(providers)) continue
    for (const [provider, profile] of Object.entries(providers)) {
      if (known.has(provider)) continue
      if (!isProfile(profile)) continue
      foreign.push(provider)
    }
  }
  return foreign
}
