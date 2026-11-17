/** Preferences apply to UI choices only; the LLM registry stays authoritative. */
export function hiddenModels(state) {
  return Array.isArray(state.hiddenModels)
    ? state.hiddenModels.filter((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string'))
    : []
}

export function updateVisibility(state, changes) {
  const hidden = new Map(hiddenModels(state).map((pair) => [JSON.stringify(pair), pair]))
  for (const { provider, id, visible } of changes) {
    const pair = [provider, id]
    const key = JSON.stringify(pair)
    if (visible) hidden.delete(key)
    else hidden.set(key, pair)
  }
  return [...hidden.values()]
}

export async function displayCatalog(ctx) {
  const llm = ctx.get('llm')
  const results = await Promise.all((llm?.listProviders?.() ?? []).map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id)
      return { provider: provider.id, name: provider.name, models: models.map(({ id, name }) => ({ id, name })) }
    } catch {
      return { provider: provider.id, name: provider.name, models: [], unavailable: true }
    }
  }))
  return results.filter((row) => row.models.length > 0 || row.unavailable)
}
