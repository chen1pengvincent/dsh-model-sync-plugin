/**
 * dsh-model-sync — pure update-detection engine (v2).
 *
 * Scope is deliberately narrow: detect what upstream added (and, for display
 * only, what it no longer lists), map each new model onto the DSH settings
 * entry it needs, and plan additions/relocations. It never plans deletions of
 * user-managed entries; strict mirroring was removed because it raced the
 * native Models editor.
 *
 * Pure by design: all I/O lives in sync.js, so every rule here is unit-tested
 * and can be previewed without touching settings.
 */

import { PROTOCOL_LABELS, protocolFromNpm } from './routes.js';

export const ENGINE_VERSION = 2;

/** Join a base URL with the OpenAI-style model listing path. */
export function modelsUrl(base) {
  return `${String(base).replace(/\/+$/, '')}/models`;
}

function cleanString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cleanPositiveInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

/** Parse one provider listing response. */
export function parseListing(body) {
  const list = Array.isArray(body) ? body
    : body && Array.isArray(body.data) ? body.data
      : body && Array.isArray(body.models) ? body.models
        : undefined;
  if (list === undefined) throw new Error('listing has no "data" or "models" array');
  const seen = new Set();
  const models = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const id = cleanString(raw.id) ?? cleanString(raw.model) ?? cleanString(raw.name);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: cleanString(raw.name) ?? cleanString(raw.display_name),
      contextWindow: cleanPositiveInt(raw.context_window ?? raw.context_length ?? raw.contextWindow),
      maxTokens: cleanPositiveInt(raw.max_output_tokens ?? raw.max_tokens ?? raw.maxTokens),
    });
  }
  return models;
}

/** Index models.dev api.json. */
export function buildModelsDevIndex(apiJson) {
  const providers = {};
  const byModel = new Map();
  if (apiJson === null || typeof apiJson !== 'object') return { providers, byModel };
  for (const [providerId, provider] of Object.entries(apiJson)) {
    if (provider === null || typeof provider !== 'object') continue;
    const providerNpm = cleanString(provider.npm);
    const models = {};
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (model === null || typeof model !== 'object') continue;
      const npm = cleanString(model.provider?.npm) ?? providerNpm;
      const meta = {
        provider: providerId,
        npm,
        api: protocolFromNpm(npm),
        name: cleanString(model.name),
        attachment: model.attachment === true,
        reasoning: model.reasoning === true,
        reasoningOptions: Array.isArray(model.reasoning_options) ? model.reasoning_options : undefined,
        modalities: model.modalities && typeof model.modalities === 'object' ? model.modalities : undefined,
        contextWindow: cleanPositiveInt(model.limit?.context),
        maxTokens: cleanPositiveInt(model.limit?.output),
      };
      models[modelId] = meta;
      if (!byModel.has(modelId)) byModel.set(modelId, meta);
    }
    providers[providerId] = { id: providerId, npm: providerNpm, api: protocolFromNpm(providerNpm), models };
  }
  return { providers, byModel };
}

export function modelsDevMeta(index, preferredProviderId, modelId) {
  if (index === undefined || index === null) return undefined;
  const preferred = preferredProviderId === undefined ? undefined : index.providers?.[preferredProviderId];
  return preferred?.models?.[modelId] ?? index.byModel?.get(modelId);
}

export function reasoningEffortsFromMeta(meta) {
  if (meta?.reasoningOptions === undefined) return undefined;
  const effort = meta.reasoningOptions.find((option) => option?.type === 'effort' && Array.isArray(option.values));
  if (effort === undefined) return undefined;
  const out = {};
  for (const level of ['low', 'high', 'max']) {
    if (effort.values.includes(level)) out[level] = level;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function inputFromMeta(meta) {
  if (meta?.modalities?.input !== undefined && Array.isArray(meta.modalities.input)) {
    return meta.modalities.input.includes('image') ? ['text', 'image'] : ['text'];
  }
  if (meta?.attachment === true) return ['text', 'image'];
  return undefined;
}

export function compatForModel(route, protocol, modelId) {
  const spec = route.protocols?.[protocol];
  if (spec === undefined) return undefined;
  let merged = spec.compat === undefined ? undefined : { ...spec.compat };
  for (const rule of spec.compatByModel ?? []) {
    if (new RegExp(rule.match, 'i').test(modelId)) {
      merged = { ...(merged ?? {}), ...rule.compat };
    }
  }
  return merged;
}

const DEEPSEEK_ENTRY_KEYS = ['id', 'name', 'description', 'contextWindow', 'maxTokens', 'inputModalities', 'imagePixelBudget', 'imageMaxBytes'];

function pickEntry(existing, keys) {
  if (existing === undefined) return undefined;
  const out = {};
  for (const key of keys) {
    if (existing[key] !== undefined) out[key] = existing[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildDeepseekEntry(discovered, existing, meta, route) {
  const kept = pickEntry(existing, DEEPSEEK_ENTRY_KEYS) ?? {};
  const entry = { id: discovered.id };
  entry.name = kept.name ?? discovered.name ?? meta?.name ?? discovered.id;
  const contextWindow = kept.contextWindow ?? discovered.contextWindow ?? meta?.contextWindow;
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  const maxTokens = kept.maxTokens ?? discovered.maxTokens ?? meta?.maxTokens;
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  if (kept.description !== undefined) entry.description = kept.description;
  const input = kept.inputModalities ?? inputFromMeta(meta);
  if (input !== undefined) {
    entry.inputModalities = input;
    if (input.includes('image') && route.vision !== undefined) {
      entry.imagePixelBudget = kept.imagePixelBudget ?? route.vision.imagePixelBudget;
      entry.imageMaxBytes = kept.imageMaxBytes ?? route.vision.imageMaxBytes;
    }
  }
  return entry;
}

const PIAI_ENTRY_KEYS = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'];

export function buildPiAiEntry(discovered, existing, meta, route, protocol) {
  if (existing !== undefined) return pickEntry(existing, PIAI_ENTRY_KEYS);
  const entry = { id: discovered.id };
  const name = discovered.name ?? meta?.name;
  if (name !== undefined) entry.name = name;
  const contextWindow = discovered.contextWindow ?? meta?.contextWindow;
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  const maxTokens = discovered.maxTokens ?? meta?.maxTokens;
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  const input = inputFromMeta(meta);
  if (input !== undefined) entry.input = input;
  const efforts = reasoningEffortsFromMeta(meta);
  if (efforts !== undefined) entry.reasoningEfforts = efforts;
  const compat = compatForModel(route, protocol, discovered.id);
  if (compat !== undefined) entry.compat = compat;
  return entry;
}

/** The protocol that owns the route's own profile (vs. a synthesized sibling). */
export function primaryProtocol(route) {
  const allowed = Object.keys(route.protocols ?? {});
  if (allowed.length === 0) return route.defaultProtocol;
  if (allowed.length === 1) return allowed[0];
  if (route.defaultProtocol !== undefined && allowed.includes(route.defaultProtocol)) return route.defaultProtocol;
  return allowed[0];
}

/** Deterministic sibling route name for one protocol of one provider. */
export function siblingName(route, protocol) {
  const suffix = route.siblingSuffix?.[protocol] ?? protocol;
  return `${route.provider}-${suffix}`;
}

/** Where one protocol's models belong. */
export function targetProvider(route, protocol) {
  return protocol === primaryProtocol(route) ? route.provider : siblingName(route, protocol);
}

/** Every sibling name this route could legitimately own. */
export function expectedSiblingNames(route) {
  return Object.keys(route.protocols ?? {})
    .filter((protocol) => protocol !== primaryProtocol(route))
    .map((protocol) => siblingName(route, protocol));
}

/**
 * Determine the wire protocol for one advertised model.
 *
 * The profile's own `api` is deliberately NOT an input: dsh-model-sync itself
 * writes `api` on the primary profile to make room for uncatalogued models, so
 * trusting it would collapse every sibling back into the primary route (v1
 * bug). Classification comes from models.dev, with the route default only as
 * an explicit last resort that callers must surface as an assumption.
 */
export function classifyProtocol(route, modelId, modelsDevIndex) {
  const allowed = Object.keys(route.protocols ?? {});
  if (allowed.length === 1) return { api: allowed[0], source: 'single-protocol' };
  const hasMetadata = modelsDevIndex !== undefined
    && modelsDevIndex.providers !== undefined
    && Object.keys(modelsDevIndex.providers).length > 0;
  if (!hasMetadata) return { api: undefined, source: 'no-metadata' };
  const meta = modelsDevMeta(modelsDevIndex, route.modelsDevProvider, modelId);
  if (meta?.api !== undefined && allowed.includes(meta.api)) return { api: meta.api, source: 'models.dev' };
  if (route.defaultProtocol !== undefined && allowed.includes(route.defaultProtocol)) {
    return { api: route.defaultProtocol, source: 'route-default' };
  }
  return { api: undefined, source: 'unknown' };
}

function modelsOf(provider, profiles) {
  const models = profiles?.[provider]?.models;
  return Array.isArray(models) ? models : [];
}

/**
 * Detect new / removed models across a provider's primary route and its
 * expected sibling routes. Read-only; returns display facts only.
 */
export function detectRouteUpdates(route, discovered, profiles, modelsDevIndex) {
  const providers = [route.provider, ...expectedSiblingNames(route)];
  const existingByProvider = new Map(providers.map((provider) => [provider, modelsOf(provider, profiles)]));
  const existingIds = new Set();
  for (const models of existingByProvider.values()) {
    for (const model of models) existingIds.add(model.id);
  }
  const newItems = [];
  const skipped = [];
  for (const item of discovered) {
    if (existingIds.has(item.id)) continue;
    const { api, source } = classifyProtocol(route, item.id, modelsDevIndex);
    if (api === undefined) {
      skipped.push({ id: item.id, reason: source === 'no-metadata' ? '缺少协议元数据（models.dev 不可用且无缓存）' : '无法判定协议' });
      continue;
    }
    newItems.push({ id: item.id, name: item.name, api, target: targetProvider(route, api), source });
  }
  const advertised = new Set(discovered.map((item) => item.id));
  const removed = [];
  for (const [provider, models] of existingByProvider.entries()) {
    for (const model of models) {
      if (!advertised.has(model.id)) removed.push({ id: model.id, provider });
    }
  }
  return { newItems, skipped, removed };
}

/**
 * Detect models sitting on the wrong route (the v1 collapse). Expected route
 * is recomputed from models.dev; entries are moved verbatim so their metadata
 * survives.
 */
export function detectRouteRepairs(route, profiles, modelsDevIndex) {
  const providers = [route.provider, ...expectedSiblingNames(route)];
  const repairs = [];
  for (const provider of providers) {
    for (const model of modelsOf(provider, profiles)) {
      const { api } = classifyProtocol(route, model.id, modelsDevIndex);
      if (api === undefined) continue;
      const target = targetProvider(route, api);
      if (target !== provider) repairs.push({ id: model.id, api, from: provider, to: target, entry: model });
    }
  }
  return repairs;
}

/**
 * Plan selected additions and repairs for one pi-ai route.
 *
 * Existing entries are carried over untouched; only the selected ids are
 * appended, and repaired entries move with their original object. Returns an
 * empty operation list when nothing was selected.
 */
export function planRouteChanges(route, profiles, { additions = [], repairs = [] } = {}, credentialRef, knownSiblings = []) {
  // Refuse to touch a sibling route that exists but was not created by us:
  // overwriting an unrelated provider of the same name would be destructive.
  const blocked = [];
  const blockedProviders = new Set();
  for (const provider of expectedSiblingNames(route)) {
    if (profiles?.[provider] !== undefined && !knownSiblings.includes(provider)) {
      blockedProviders.add(provider);
      blocked.push({ provider, reason: '同名路由已存在且不是本插件创建的，跳过以免覆盖' });
    }
  }
  const effectiveAdditions = additions.filter((addition) => !blockedProviders.has(addition.target));
  const effectiveRepairs = repairs.filter((repair) => !blockedProviders.has(repair.to) && !blockedProviders.has(repair.from));

  const involved = new Set([route.provider, ...expectedSiblingNames(route).filter((provider) => !blockedProviders.has(provider))]);
  for (const addition of effectiveAdditions) involved.add(addition.target);
  for (const repair of effectiveRepairs) {
    involved.add(repair.from);
    involved.add(repair.to);
  }
  const next = new Map();
  for (const provider of involved) {
    next.set(provider, [...modelsOf(provider, profiles)]);
  }
  const has = (provider, id) => next.get(provider)?.some((model) => model.id === id) === true;

  for (const repair of effectiveRepairs) {
    const from = next.get(repair.from);
    const index = from.findIndex((model) => model.id === repair.id);
    if (index === -1) continue;
    const [entry] = from.splice(index, 1);
    // compat is protocol-specific: an entry built for the source protocol must
    // not carry its switches onto a different one (DSH refuses unoffered
    // fields). Everything else (name/context/input/reasoning) travels intact.
    const moved = { ...entry };
    delete moved.compat;
    if (!has(repair.to, repair.id)) next.get(repair.to).push(moved);
  }
  for (const addition of effectiveAdditions) {
    if (addition.entry === undefined) continue;
    if (has(addition.target, addition.id)) continue;
    next.get(addition.target).push(addition.entry);
  }

  const primary = primaryProtocol(route);
  const multiProtocol = Object.keys(route.protocols ?? {}).length > 1;
  const mainAdditions = effectiveAdditions.some((addition) => addition.target === route.provider);
  const operations = [];
  for (const provider of involved) {
    const models = next.get(provider);
    const current = modelsOf(provider, profiles);
    const changed = JSON.stringify(models) !== JSON.stringify(current);
    if (provider === route.provider) {
      if (changed) operations.push({ op: 'set', path: ['providers', provider, 'models'], value: models });
      if (mainAdditions) {
        // A model the installed catalog does not describe needs a route-level
        // baseURL; only a mixed-protocol route also needs `api` forced.
        if (multiProtocol && profiles?.[provider]?.api !== primary) {
          operations.push({ op: 'set', path: ['providers', provider, 'api'], value: primary });
        }
        if (profiles?.[provider]?.baseURL !== route.protocols[primary].baseUrl) {
          operations.push({ op: 'set', path: ['providers', provider, 'baseURL'], value: route.protocols[primary].baseUrl });
        }
      }
      continue;
    }
    const protocol = Object.keys(route.protocols).find((candidate) => siblingName(route, candidate) === provider);
    if (protocol === undefined) continue;
    if (profiles?.[provider] === undefined) {
      if (models.length === 0) continue;
      operations.push({
        op: 'set',
        path: ['providers', provider],
        value: {
          displayName: `${route.displayName} · ${PROTOCOL_LABELS[protocol] ?? protocol}`,
          api: protocol,
          baseURL: route.protocols[protocol].baseUrl,
          apiKeyEnv: credentialRef,
          models,
        },
      });
      continue;
    }
    if (changed) operations.push({ op: 'set', path: ['providers', provider, 'models'], value: models });
    if (profiles[provider].api !== protocol) operations.push({ op: 'set', path: ['providers', provider, 'api'], value: protocol });
    if (profiles[provider].baseURL !== route.protocols[protocol].baseUrl) {
      operations.push({ op: 'set', path: ['providers', provider, 'baseURL'], value: route.protocols[protocol].baseUrl });
    }
  }
  const createdSiblings = [...involved].filter((provider) => provider !== route.provider && profiles?.[provider] === undefined && next.get(provider).length > 0);
  return { operations, createdSiblings, blocked };
}

/** Additions for one `llm-deepseek` catalog route, entries built and ready. */
export function planDeepseekAdditions(route, discovered, existingModels, modelsDevIndex, selectedIds) {
  const existingIds = new Set(existingModels.map((model) => model.id));
  const selected = selectedIds === undefined ? undefined : new Set(selectedIds);
  const additions = [];
  const skipped = [];
  for (const item of discovered) {
    if (existingIds.has(item.id)) continue;
    if (selected !== undefined && !selected.has(item.id)) continue;
    const meta = modelsDevMeta(modelsDevIndex, route.modelsDevProvider, item.id);
    additions.push(buildDeepseekEntry(item, undefined, meta, route));
  }
  return { additions, skipped, models: [...existingModels, ...additions] };
}

/** Current models for one deepseek route, keyed by provider for callers. */
export function deepseekExisting(existingModels, discovered) {
  const advertised = new Set(discovered.map((item) => item.id));
  return { removed: existingModels.filter((model) => !advertised.has(model.id)).map((model) => ({ id: model.id, provider: 'deepseek-official' })) };
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function isUnchanged(currentEntries, plannedEntries) {
  return stableStringify(currentEntries ?? []) === stableStringify(plannedEntries ?? []);
}
