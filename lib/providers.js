/** Configured instances, not a list of brand names, are the source of truth. */
import { createHash } from 'node:crypto';
import { BUILTIN_ROUTES } from './routes.js';
import { siblingName } from './engine.js';
import { identifyOfficialEndpoint } from './official.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);

// DSH's read-only DeepSeek account adapter cannot edit model lists, so this
// plugin has nothing to offer for it. The user asked for the row to be gone
// entirely (not merely hidden), including from checks and status.
const EXCLUDED_PROVIDERS = new Set(['deepseek-account']);
const EXCLUDED_NAMESPACES = new Set(['llm-deepseek-account']);
export function atPath(value, path) {
  for (const key of path) {
    if (!own(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

export function settingsDescriptors(settings, { redactSecrets = true } = {}) {
  if (typeof settings?.describe === 'function') return settings.describe({ redactSecrets }) ?? [];
  // Compatibility with older kernels. Never manufacture a revision on current DSH.
  if (typeof settings?.get !== 'function') return [];
  return ['llm-deepseek', 'llm-pi-ai'].flatMap((ns) => {
    const value = settings.get(ns);
    return value === undefined ? [] : [{ ns, value }];
  });
}

export function instanceId(entry, profileId = '') {
  return `cfg_${Buffer.from(JSON.stringify([profileId, entry.settingsNs, entry.settingsPath, entry.provider])).toString('base64url')}`;
}

function normalizedBase(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return undefined; }
}

function legacyRoute(provider, baseURL) {
  const route = BUILTIN_ROUTES[provider];
  if (!route || route.adapter === 'deepseek') return undefined;
  const base = normalizedBase(baseURL);
  const allowed = [...route.discovery.baseUrls, ...Object.values(route.protocols ?? {}).map((p) => p.baseUrl)];
  return base && allowed.some((value) => normalizedBase(value) === base) ? route : undefined;
}

function fallbackDirectory(descriptors) {
  const entries = [];
  for (const descriptor of descriptors) {
    if (descriptor.ns === 'llm-deepseek' || descriptor.ns.endsWith(':llm-deepseek')) {
      const route = BUILTIN_ROUTES['deepseek-official'];
      entries.push({ provider: route.provider, displayName: route.displayName, settingsNs: descriptor.ns,
        settingsPath: [], defaultBaseURL: route.discovery.baseUrls[0], nativeAuth: { env: [route.credentialRef] } });
    }
    if (descriptor.ns === 'llm-pi-ai' || descriptor.ns.endsWith(':llm-pi-ai')) {
      for (const provider of Object.keys(descriptor.value?.providers ?? {})) {
        const route = BUILTIN_ROUTES[provider];
        entries.push({ provider, displayName: route?.displayName ?? provider, settingsNs: descriptor.ns,
          settingsPath: ['providers', provider], defaultBaseURL: route?.discovery.baseUrls[0],
          nativeAuth: { env: route ? [route.credentialRef] : [] } });
      }
    }
  }
  return entries;
}

/** All configured rows are returned, including unsupported endpoints (never silently hidden). */
export function configuredTargets(ctx, state, options = {}) {
  const descriptors = settingsDescriptors(ctx.get('settings'), options);
  const llm = ctx.get('llm');
  const profileDir = ctx.get('profileContext')?.dir;
  const profileId = typeof profileDir === 'string' ? createHash('sha256').update(profileDir).digest('hex').slice(0, 24) : '';
  const hasDirectory = typeof llm?.listConfigurableProviders === 'function';
  const directory = hasDirectory ? llm.listConfigurableProviders() : fallbackDirectory(descriptors);
  if (!Array.isArray(directory)) throw new Error('DSH 供应商目录不可用，请稍后重试');
  const byNs = new Map(descriptors.map((descriptor) => [descriptor.ns, descriptor]));
  const seen = new Set();
  const targets = [];
  for (const entry of directory) {
    if (!entry || typeof entry.provider !== 'string' || typeof entry.settingsNs !== 'string' || !Array.isArray(entry.settingsPath)) continue;
    if (!entry.settingsPath.every((part) => typeof part === 'string')) continue;
    if (EXCLUDED_PROVIDERS.has(entry.provider) || EXCLUDED_NAMESPACES.has(entry.settingsNs)) continue;
    const descriptor = byNs.get(entry.settingsNs);
    if (!descriptor) continue;
    const profile = atPath(descriptor.value, entry.settingsPath);
    if (!object(profile)) continue; // declared / registered does not mean configured.
    const id = hasDirectory ? instanceId(entry, profileId) : entry.provider;
    if (seen.has(id)) continue;
    seen.add(id);
    const adapter = entry.settingsPath.length === 0 && entry.provider === 'deepseek-official' ? 'deepseek'
      : entry.settingsPath.length === 2 && entry.settingsPath[0] === 'providers' ? 'pi-ai' : undefined;
    // The native adapter resolves its own default endpoint from the service, and
    // some installed routes (opencode, …) register without defaultBaseURL. Do
    // not turn a documented built-in endpoint into "unknown endpoint": fall back
    // to the route table only when the profile and directory omit a base URL.
    // A user-supplied proxy/baseURL is never replaced here.
    const builtinDefault = adapter === 'deepseek'
      ? BUILTIN_ROUTES['deepseek-official'].discovery.baseUrls[0]
      : entry.settingsPath.length === 2 && entry.settingsPath[0] === 'providers'
        ? BUILTIN_ROUTES[entry.provider]?.discovery.baseUrls[0]
        : undefined;
    const baseURL = profile.baseURL ?? (entry.baseURLEnv ?? []).map((ref) => process.env[ref]).find(Boolean)
      ?? entry.defaultBaseURL ?? builtinDefault;
    const legacy = legacyRoute(entry.provider, baseURL);
    const endpoint = legacy ? undefined : identifyOfficialEndpoint(baseURL);
    const refs = profile.apiKeyEnv !== undefined ? [profile.apiKeyEnv] : (entry.nativeAuth?.env ?? []);
    const credentialRefs = [...new Set(refs.filter((ref) => typeof ref === 'string' && ref.length > 0))];
    const credentialRef = credentialRefs[0];
    const displayName = typeof profile.displayName === 'string' && profile.displayName.trim() ? profile.displayName : entry.displayName ?? entry.provider;
    const protocol = profile.api ?? endpoint?.protocol;
    const route = legacy ? { ...legacy, settingsNs: entry.settingsNs, settingsPath: [...entry.settingsPath], displayName }
      : { provider: entry.provider, displayName, adapter, settingsNs: entry.settingsNs, settingsPath: [...entry.settingsPath],
          defaultSelected: false, managedByDefault: true, defaultProtocol: protocol,
          protocols: protocol ? { [protocol]: { baseUrl: baseURL } } : {},
          ...(endpoint?.nativeProtocol ? { nativeProtocol: endpoint.nativeProtocol } : {}),
          ...(adapter === 'deepseek' ? { vision: BUILTIN_ROUTES['deepseek-official'].vision } : {}) };
    // Only a digest is persisted. Headers and API keys must never enter state or UI payloads.
    const configScope = createHash('sha256').update(JSON.stringify({ profileId, ns: entry.settingsNs, path: entry.settingsPath,
      provider: entry.provider, base: normalizedBase(baseURL) ?? null, api: profile.api ?? null,
      refs: credentialRefs, headers: profile.headers ?? {}, adapter })).digest('hex');
    const override = state.managedOverride(id) ?? state.managedOverride(entry.provider);
    const reason = !adapter ? '此 DSH 适配器暂不支持模型列表编辑'
      : !legacy && !endpoint ? '仅支持已识别的官方 HTTPS API；不会向未知端点发送凭证'
      : endpoint?.status === 'unsupported' ? endpoint.reason : undefined;
    targets.push({ id, actualProvider: entry.provider, route, legacy: !!legacy, official: endpoint,
      directoryEntry: entry, descriptor, profile, settingsPath: [...entry.settingsPath], configScope,
      managed: override === undefined ? route.managedByDefault !== false : override,
      existingModels: Array.isArray(profile.models) ? profile.models : [],
      baseUrls: legacy ? (profile.baseURL !== undefined ? [profile.baseURL] : [...legacy.discovery.baseUrls]) : [baseURL],
      credentialRefs, credentialRef, reason, settingsRevision: descriptor.revision });
  }
  // Protocol siblings synthesized by this plugin stay within their owning legacy
  // card. A user route that merely shares the name is NOT claimed: it may point
  // somewhere else, and hiding it would reproduce the invisible-provider bug.
  const claimed = new Set();
  for (const target of targets) if (target.legacy) {
    for (const protocol of Object.keys(target.route.protocols ?? {})) {
      const sibling = siblingName(target.route, protocol);
      const spec = target.route.protocols[protocol];
      const other = targets.find((item) => item.actualProvider === sibling && item.route.settingsNs === target.route.settingsNs);
      const owned = other !== undefined && other.profile.api === protocol
        && normalizedBase(other.profile.baseURL) === normalizedBase(spec.baseUrl)
        // The credential binding must match too: a user route with the same
        // transport but its own key is not ours to hide.
        && (other.profile.apiKeyEnv ?? undefined) === (target.route.credentialRef ?? undefined);
      if (owned) claimed.add(JSON.stringify([target.route.settingsNs, sibling]));
    }
  }
  return targets.filter((target) => !claimed.has(JSON.stringify([target.route.settingsNs, target.actualProvider])));
}
