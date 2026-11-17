/**
 * Listing endpoints for providers whose address is not in the route.
 *
 * pi-ai's catalog carries no route-level `baseURL` for a handful of providers
 * (`opencode`, `opencode-go`, …) because the address belongs to each *model*:
 * `https://opencode.ai/inference` for plain opencode, `…/inference/go` for
 * opencode-go, and the protocol decides the tail path. `LlmConfigurableProvider`
 * therefore reports no `defaultBaseURL` for them, and a plugin that only reads
 * the route finds nothing to ask.
 *
 * The previous version of this plugin solved it with a table like this one
 * (its `lib/routes.js` carried `discovery.baseUrls` per provider), which is why
 * it could report upstream counts for these routes while `discoverModels` could
 * not. The values below were re-verified against the live APIs on 2026-11-16:
 *
 * - `https://opencode.ai/inference/v1`     → 42 models (opencode)
 * - `https://opencode.ai/inference/go/v1`  → 22 models (opencode-go)
 *
 * A route that carries its own `baseURL` always wins: this table is consulted
 * only when the settings and the provider directory both say nothing, and an
 * unknown provider stays unknown (the panel then says so instead of failing).
 */

/** @type {Record<string, {baseURL: string, api?: string, note?: string}>} */
export const ENDPOINT_HINTS = {
  opencode: {
    baseURL: 'https://opencode.ai/inference/v1',
    note: 'the catalog puts this address on each model, not on the route',
  },
  'opencode-go': {
    baseURL: 'https://opencode.ai/inference/go/v1',
    note: 'the catalog puts this address on each model, not on the route',
  },
}

/**
 * Resolve the endpoint a check should ask, without inventing one for a
 * provider nobody has described.
 * @param {{provider: string, baseURL?: string}} target
 * @returns {{baseURL: string, source: 'route' | 'hint'} | {baseURL: undefined, source: 'unknown'}}
 */
export function endpointFor(target) {
  if (typeof target.baseURL === 'string' && target.baseURL.length > 0) {
    return { baseURL: target.baseURL, source: 'route' }
  }
  const hint = ENDPOINT_HINTS[target.provider]
  if (hint !== undefined && typeof hint.baseURL === 'string' && hint.baseURL.length > 0) {
    return { baseURL: hint.baseURL, source: 'hint' }
  }
  return { baseURL: undefined, source: 'unknown' }
}

/**
 * The address a gateway route should forward to, or `undefined` when even the
 * table has nothing to say. Kept separate from `endpointFor` so a caller can
 * tell "we do not know" from "the route says so".
 * @param {string} provider
 * @returns {string | undefined}
 */
export function hintedBaseURL(provider) {
  const hint = ENDPOINT_HINTS[provider]
  return hint !== undefined ? hint.baseURL : undefined
}
