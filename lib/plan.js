/**
 * Turning a comparison into the smallest settings edit that closes it.
 *
 * Two rules drive everything here:
 *
 *  1. **Never invent a route.** Every op targets a `settingsPath` that already
 *     exists on a configured provider. A new provider key would draw a card on
 *     the Models page and a group in the composer, which is exactly what the
 *     user must not see.
 *  2. **Prefer replace-nothing.** When the route already states its own
 *     `models` array, that array is edited in place: existing entries are
 *     preserved verbatim (they may carry per-model `contextWindow` overrides)
 *     and only additions are appended. When the route inherits the adapter's
 *     catalog, writing a list materializes it — so the materialization starts
 *     from every id the route serves today, then appends. A bare `{id}` entry
 *     inherits name, modalities, cost and capacities from the shipped catalog
 *     (`resolveEntry` falls back per field), so this loses nothing.
 *
 * Removals are reported, never planned. A provider's `/models` endpoint is a
 * listing, not a contract: aliases, dated snapshots and previews routinely go
 * unlisted while remaining callable. Dropping a model because the listing
 * stopped mentioning it would break a working configuration silently, so the
 * panel offers it as an explicit, per-model action instead.
 */

/**
 * Compare two id lists.
 * @param {{upstream: readonly {id: string, name?: string}[], effective: readonly string[]}} input
 * @returns {{added: {id: string, name?: string}[], gone: string[]}}
 */
export function diffModels(input) {
  const effective = new Set(input.effective)
  const upstreamIds = new Set(input.upstream.map((model) => model.id))
  return {
    added: input.upstream.filter((model) => !effective.has(model.id)),
    gone: input.effective.filter((id) => !upstreamIds.has(id)),
  }
}

/** The route's stated entries, whichever name the caller used for them. */
function entriesOf(target) {
  if (Array.isArray(target?.modelEntries)) return target.modelEntries
  if (Array.isArray(target?.entries)) return target.entries
  return undefined
}

/**
 * Build the `models` array to write.
 *
 * @param {object} input
 * @param {readonly unknown[]} [input.entries] the route's current array, when it states one
 * @param {readonly string[]} input.effectiveIds every id the route serves today
 * @param {readonly {id: string, name?: string}[]} input.additions ids to append
 * @param {(id: string) => object | undefined} [input.enrich] fields to restore on
 *   an entry this write synthesizes from an inherited catalog
 * @returns {{id: string, name?: string}[]}
 */
export function buildModelsWrite(input) {
  const source = Array.isArray(input.entries) && input.entries.length > 0
    ? input.entries
    : input.effectiveIds.map((id) => ({ id, ...(input.enrich?.(id) ?? {}) }))
  /** @type {{id: string, name?: string}[]} */
  const models = []
  const seen = new Set()
  const removed = new Set(input.removals)
  for (const entry of source) {
    const id = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? String((/** @type {any} */ (entry)).id ?? '') : ''
    if (id.length === 0 || seen.has(id) || removed.has(id)) continue
    seen.add(id)
    models.push(/** @type {any} */ (entry))
  }
  for (const addition of input.additions) {
    if (seen.has(addition.id)) continue
    seen.add(addition.id)
    // Pushed as given: the caller may have restored capabilities from the
    // catalog (`contextWindow`, `maxTokens`, `inputModalities`), and rebuilding
    // the entry from `id`/`name` here would silently drop them.
    models.push(/** @type {any} */ (addition))
  }
  return models
}

/**
 * One settings op that appends ids to a route's model list.
 *
 * @param {object} input
 * @param {{settingsPath: readonly string[], entries?: readonly unknown[], effectiveIds: readonly string[]}} input.target
 * @param {readonly {id: string, name?: string}[]} input.additions
 * @param {(id: string) => object | undefined} [input.enrich]
 * @returns {{op: 'set', path: string[], value: {id: string, name?: string}[]}}
 */
export function additionOp(input) {
  return {
    op: 'set',
    path: [...input.target.settingsPath],
    value: buildModelsWrite({
      entries: entriesOf(input.target),
      effectiveIds: input.target.effectiveIds,
      additions: input.additions,
      removals: input.removals,
      enrich: input.enrich,
    }),
  }
}

/**
 * Removing one model from a route's stated list.
 *
 * A route that inherits the adapter's catalog cannot express "minus one":
 * materializing would freeze the whole list, and the shipped catalog cannot be
 * edited. The caller reports that instead of writing something surprising.
 *
 * @param {{settingsPath: readonly string[], entries?: readonly unknown[]}} target
 * @param {string} id
 * @returns {{op: 'set', path: string[], value: object[]} | {unsupported: string}}
 */
export function removalOp(target, id) {
  const entries = entriesOf(target)
  if (entries === undefined) {
    return { unsupported: 'this provider inherits the built-in catalog, so a single model cannot be removed; clear the list to fall back to the catalog instead' }
  }
  const next = entries.filter((entry) => {
    const entryId = typeof entry === 'string' ? entry : (/** @type {any} */ (entry))?.id
    return String(entryId) !== id
  })
  if (next.length === entries.length) return { unsupported: `"${id}" is not in this provider's configured list` }
  // Removing the last entry cannot be expressed as an empty list: pi-ai reads
  // an empty `models` as "use the catalog again" (`configured.length > 0 ?
  // configured : defaults`), so `[]` and `unset` are the same thing. Say the
  // thing that is true, and let the caller explain it.
  if (next.length === 0) {
    return { op: 'unset', path: [...target.settingsPath], fallsBackToCatalog: true }
  }
  return { op: 'set', path: [...target.settingsPath], value: next.map((entry) => /** @type {object} */ (entry)) }
}

/**
 * Drop the route's stated list so it serves the adapter's catalog again.
 *
 * `unset` restores the inherited value only when the base layer actually has a
 * value at that path; otherwise it deletes the key and the schema default
 * applies at parse time. Either way a materialization is undone, so this is the
 * undo button as well.
 * @param {{settingsPath: readonly string[]}} target
 * @returns {{op: 'unset', path: string[]}}
 */
export function restoreOp(target) {
  return { op: 'unset', path: [...target.settingsPath] }
}
