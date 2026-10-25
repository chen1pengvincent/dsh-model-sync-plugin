/**
 * dsh-model-sync — host orchestration (v2).
 *
 * Read path: discover `/models` per managed route and diff against settings.
 * Write path: only selected additions (plus an explicitly approved repair) are
 * appended through `ctx.settings.mutate`; nothing is ever deleted or rewritten
 * automatically. The v1 strict-mirror auto-apply was removed because it fought
 * the native Models editor and could mis-place mixed-protocol models.
 */

import { join } from 'node:path';

import {
  buildDeepseekEntry,
  buildModelsDevIndex,
  buildPiAiEntry,
  detectRouteRepairs,
  detectRouteUpdates,
  expectedSiblingNames,
  modelsDevMeta,
  vendorForModel,
  modelsUrl,
  parseListing,
  planDeepseekAdditions,
  planRouteChanges,
  siblingName,
  deepseekExisting,
} from './engine.js';
import { BUILTIN_ROUTES, PROTOCOL_LABELS } from './routes.js';
import { dshHome } from './state.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 20 * 1000;
export const STARTUP_DELAY_MS = 8000;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = 'dsh-model-sync/0.9.6';

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Read one settings section across kernel generations. The settings-file
 * service (≤ DSH Desktop 2.0.13) exposed `get(ns)`; the entry-based
 * SettingsForms service (2.0.17+, which migrated settings.yaml into the
 * profile's Cordis patch) exposes `describe()` with per-entry live `value`.
 * Try the old shape first, then the new one; both absent reads as
 * "section unavailable" so callers keep their honest unmanaged reporting.
 */
export function readSettingsSection(settings, ns) {
  if (settings === undefined || settings === null) return undefined;
  if (typeof settings.get === 'function') {
    const hit = settings.get(ns);
    if (hit !== undefined) return hit;
  }
  if (typeof settings.describe === 'function') {
    try {
      const descriptor = (settings.describe() ?? []).find((entry) => entry?.ns === ns);
      if (descriptor !== undefined) return descriptor.value;
    } catch {
      /* fall through to unavailable */
    }
  }
  return undefined;
}

/** Strip in-memory entry objects before persisting a display copy. */
function displayResult(result) {
  return {
    ...result,
    newItems: (result.newItems ?? []).map(({ entry, ...rest }) => rest),
  };
}

export class SyncController {
  constructor({ ctx, state, logger = console }) {
    this.ctx = ctx;
    this.state = state;
    this.logger = logger;
    this.running = false;
    this.refreshing = false;
    this.refreshQueued = false;
    this.discoveryCache = new Map();
    this.modelsDevIndexCache = undefined;
  }

  settings() {
    return this.ctx.get('settings');
  }

  async resolveCredential(ref) {
    const credentials = this.ctx.get('credentials');
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref);
        if (hit?.value !== undefined && hit.value.length > 0) return hit.value;
      } catch {
        /* fall through to ambient env */
      }
    }
    const ambient = process.env[ref];
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
  }

  /**
   * Describe one route's credential reference without reading its value.
   *
   * A read-only reference (`writable: false`) cannot be changed from the
   * settings UI. Through kernel 0.2.0 an env-sourced value was read-only and
   * shadowed the stored one; 0.2.1+ prefers stored credentials and reports the
   * env fallback as writable, so only the actual read-only bit is surfaced.
   * Returns `undefined` when the seam or the method is absent (older kernels,
   * tests).
   */
  async describeCredential(ref) {
    if (ref === undefined) return undefined;
    const credentials = this.ctx.get('credentials');
    if (credentials === undefined || typeof credentials.describe !== 'function') return undefined;
    try {
      const description = await credentials.describe(ref);
      if (description === undefined || description.configured !== true) {
        return { ref, configured: false };
      }
      const readOnly = description.writable === false;
      const envShadowed = readOnly && description.source === 'env';
      return {
        ref,
        configured: true,
        source: description.source,
        writable: !readOnly,
        readOnly,
        shadowed: readOnly,
        ...(readOnly
          ? {
              warning: envShadowed
                ? `凭证 ${ref} 由启动环境变量注入：设置页中它为只读，写入会被遮蔽。更换 Key 请先在启动环境里移除该变量（如 launchctl unsetenv ${ref}），再完全退出（⌘Q）并冷启动 DSH。`
                : `凭证 ${ref} 的来源（${description.source ?? '未知'}）为只读：设置页中无法修改，换 Key 请直接更新该来源。`,
            }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** Every route this plugin can check, joined with its resolved settings. */
  routeTargets() {
    const targets = [];
    const unmanaged = [];
    const piAiProviders = readSettingsSection(this.settings(), 'llm-pi-ai')?.providers ?? {};
    for (const route of Object.values(BUILTIN_ROUTES)) {
      const override = this.state.managedOverride(route.provider);
      const managed = override === undefined ? route.managedByDefault : override;
      if (route.adapter === 'deepseek') {
        const section = readSettingsSection(this.settings(), route.settingsNs);
        if (section === undefined) {
          if (managed) unmanaged.push({ provider: route.provider, reason: 'settings namespace unavailable' });
          continue;
        }
        targets.push({
          route,
          managed,
          existingModels: Array.isArray(section.models) ? section.models : [],
          baseUrls: section.baseURL !== undefined ? [section.baseURL, ...route.discovery.baseUrls] : route.discovery.baseUrls,
          credentialRef: section.apiKeyEnv ?? route.credentialRef,
        });
        continue;
      }
      const profile = piAiProviders[route.provider];
      if (profile === undefined) {
        if (managed) unmanaged.push({ provider: route.provider, reason: 'provider is not configured in settings' });
        continue;
      }
      targets.push({
        route: { ...route, displayName: profile.displayName ?? route.displayName, credentialRef: profile.apiKeyEnv ?? route.credentialRef },
        managed,
        profile,
        existingModels: Array.isArray(profile.models) ? profile.models : [],
        baseUrls: profile.baseURL !== undefined ? [profile.baseURL, ...route.discovery.baseUrls] : route.discovery.baseUrls,
        credentialRef: profile.apiKeyEnv ?? route.credentialRef,
      });
    }
    for (const provider of Object.keys(piAiProviders)) {
      if (BUILTIN_ROUTES[provider] === undefined && !this.isExpectedSibling(provider)) {
        unmanaged.push({ provider, reason: '没有内置端点信息，无法检查上游' });
      }
    }
    return { targets, unmanaged };
  }

  isExpectedSibling(provider) {
    for (const route of Object.values(BUILTIN_ROUTES)) {
      if (route.adapter !== 'pi-ai') continue;
      if (expectedSiblingNames(route).includes(provider)) return true;
    }
    return false;
  }

  /**
   * Find the built-in route that owns `provider` as one of its protocol
   * siblings. Returns `undefined` for anything else, so the removal API can
   * never touch user-created providers.
   */
  siblingOwner(provider) {
    for (const route of Object.values(BUILTIN_ROUTES)) {
      if (route.adapter !== 'pi-ai') continue;
      const expected = expectedSiblingNames(route);
      if (!expected.includes(provider)) continue;
      const protocol = Object.keys(route.protocols ?? {}).find((candidate) => siblingName(route, candidate) === provider);
      return { route, protocol };
    }
    return undefined;
  }

  decorateAllItems(route, allItems) {
    return (allItems ?? []).map((item) => ({
      ...item,
      removable: item?.added === true && typeof item.target === 'string',
    }));
  }

  /**
   * Panel data: every protocol-sibling model this plugin manages, grouped per
   * main route. Reads live settings so a renamed sibling card is still matched
   * by its current display name. Siblings without models are omitted.
   */
  managedSiblings() {
    const piAiProviders = readSettingsSection(this.settings(), 'llm-pi-ai')?.providers ?? {};
    const routes = [];
    for (const route of Object.values(BUILTIN_ROUTES)) {
      if (route.adapter !== 'pi-ai') continue;
      const profile = piAiProviders[route.provider];
      if (profile === undefined) continue;
      const expected = new Set(expectedSiblingNames(route));
      const registered = new Set(this.state.knownSiblings(route.provider));
      const siblings = [];
      for (const protocol of Object.keys(route.protocols ?? {})) {
        const provider = siblingName(route, protocol);
        if (!expected.has(provider)) continue;
        const siblingProfile = piAiProviders[provider];
        if (siblingProfile === undefined) continue;
        if (!registered.has(provider)) continue;
        const models = Array.isArray(siblingProfile.models) ? siblingProfile.models.filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string') : [];
        if (models.length === 0) continue;
        siblings.push({
          provider,
          protocol,
          label: PROTOCOL_LABELS[protocol] ?? protocol,
          displayName: siblingProfile.displayName ?? provider,
          models: models.map((model) => ({
            id: model.id,
            name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
            ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
            ...(Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
            ...(Array.isArray(model.input) ? { input: model.input.filter((entry) => entry === 'text' || entry === 'image') } : {}),
          })),
        });
      }
      if (siblings.length > 0) {
        routes.push({ provider: route.provider, displayName: profile.displayName ?? route.displayName, siblings });
      }
    }
    return { at: Date.now(), routes };
  }

  /**
   * Remove models from protocol siblings (the managed panel's delete).
   * Deletion only drops the settings entries: the models stay available
   * upstream and `check` will list them again, so the plugin side always shows
   * the full catalog. The main provider row and every non-sibling route are
   * untouchable here by construction. The whole batch writes settings once so
   * the official settings editor only ever sees a single revision bump, and the
   * upstream refresh runs in the background so the caller returns immediately.
   */
  async removeSiblingModels(items) {
    if (!Array.isArray(items) || items.length === 0) throw badRequest('removals 必须是非空数组');
    if (items.length > 100) throw badRequest('单次最多删除 100 个模型');
    for (const item of items) {
      const provider = item?.provider;
      const modelId = item?.modelId;
      if (typeof provider !== 'string' || typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 200) {
        throw badRequest('provider 和 modelId 必须是有效字符串');
      }
      const owner = this.siblingOwner(provider);
      if (owner === undefined) throw badRequest(`"${provider}" 不是插件托管的协议分流路由`);
      if (!this.state.knownSiblings(owner.route.provider).includes(provider)) {
        throw badRequest(`"${provider}" 不是本插件创建的协议分流路由，插件不会改动用户自建的 provider`);
      }
    }
    if (this.running) throw Object.assign(new Error('已有一个任务在运行'), { status: 409 });
    this.running = true;
    let changed = false;
    try {
      const settings = this.settings();
      const piAiProviders = readSettingsSection(settings, 'llm-pi-ai')?.providers ?? {};
      const plan = new Map();
      const unique = [];
      for (const { provider, modelId } of items) {
        let group = plan.get(provider);
        if (group === undefined) {
          const current = Array.isArray(piAiProviders[provider]?.models) ? piAiProviders[provider].models : [];
          group = { current, requested: new Set() };
          plan.set(provider, group);
        }
        if (group.requested.has(modelId)) continue;
        group.requested.add(modelId);
        unique.push({ provider, modelId });
      }
      const ops = [];
      for (const [provider, group] of plan) {
        group.next = group.current.filter((model) => !group.requested.has(model?.id));
        if (group.next.length === group.current.length) continue;
        if (group.next.length === 0) {
          // llm-pi-ai strict writes refuse a route that "resolves no models",
          // so emptying a sibling unsets the whole entry instead of leaving an
          // empty models list behind (the official editor removes providers
          // the same way).
          ops.push({ op: 'unset', path: ['providers', provider] });
        } else {
          ops.push({ op: 'set', path: ['providers', provider, 'models'], value: group.next });
        }
      }
      const results = unique.map(({ provider, modelId }) => {
        const group = plan.get(provider);
        return {
          provider,
          modelId,
          removed: group.current.some((model) => model?.id === modelId),
          remaining: group.next.length,
        };
      });
      const removed = results.filter((result) => result.removed).length;
      if (ops.length === 0) return { results, removed };
      const backup = this.backupSettings();
      await settings.mutate('llm-pi-ai', ops);
      changed = true;
      const firstHit = results.find((result) => result.removed) ?? results[0];
      this.state.data.lastRemove = {
        at: Date.now(),
        provider: firstHit.provider,
        modelId: firstHit.modelId,
        backup,
        items: results.map(({ provider, modelId, removed: hit }) => ({ provider, modelId, removed: hit })),
      };
      this.state.save();
      this.logger.info?.(`dsh-model-sync: removed ${removed} model(s)`);
      return { results, removed };
    } finally {
      this.running = false;
      if (changed) this.refreshAfterMutation();
    }
  }

  /**
   * Remove already-added models that this plugin owns. Sibling models are
   * removable by construction; primary-route models are removable only after
   * this plugin recorded them in `ownedModels`.
   */
  async removeManagedModels(items, { recheck = true } = {}) {
    if (!Array.isArray(items) || items.length === 0) throw badRequest('removals 必须是非空数组');
    if (items.length > 100) throw badRequest('单次最多删除 100 个模型');
    const normalized = [];
    for (const item of items) {
      const provider = item?.provider;
      const modelId = item?.modelId;
      if (typeof provider !== 'string' || typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 200) {
        throw badRequest('provider 和 modelId 必须是有效字符串');
      }
      normalized.push({ provider, modelId });
    }
    if (this.running) throw Object.assign(new Error('已有一个任务在运行'), { status: 409 });
    this.running = true;
    let changed = false;
    try {
      const settings = this.settings();
      const piAiProviders = readSettingsSection(settings, 'llm-pi-ai')?.providers ?? {};
      const deepseek = readSettingsSection(settings, 'llm-deepseek') ?? {};
      const plans = new Map();
      const unique = [];
      for (const { provider, modelId } of normalized) {
        const route = BUILTIN_ROUTES[provider];
        let namespace;
        let path;
        let current;
        let kind;
        if (route !== undefined) {
          if (route.adapter === 'deepseek') {
            namespace = route.settingsNs;
            path = ['models'];
            current = Array.isArray(deepseek.models) ? deepseek.models : [];
            kind = 'deepseek';
          } else {
            namespace = 'llm-pi-ai';
            path = ['providers', provider, 'models'];
            current = Array.isArray(piAiProviders[provider]?.models) ? piAiProviders[provider].models : [];
            kind = 'pi-ai';
          }
        } else {
          const owner = this.siblingOwner(provider);
          if (owner === undefined || !this.state.knownSiblings(owner.route.provider).includes(provider)) {
            throw badRequest(`"${provider}" 不是本插件创建的协议分流路由，插件不会改动用户自建的 provider`);
          }
          namespace = 'llm-pi-ai';
          path = ['providers', provider, 'models'];
          current = Array.isArray(piAiProviders[provider]?.models) ? piAiProviders[provider].models : [];
          kind = 'pi-ai';
        }
        let plan = plans.get(namespace);
        if (plan === undefined) {
          plan = { byProvider: new Map() };
          plans.set(namespace, plan);
        }
        let group = plan.byProvider.get(provider);
        if (group === undefined) {
          group = { provider, path, current, requested: new Set(), kind };
          plan.byProvider.set(provider, group);
        }
        if (!group.requested.has(modelId)) {
          group.requested.add(modelId);
          unique.push({ provider, modelId, namespace });
        }
      }
      const results = [];
      const operations = new Map();
      for (const [namespace, plan] of plans) {
        const ops = [];
        for (const group of plan.byProvider.values()) {
          const next = group.current.filter((model) => !group.requested.has(model?.id));
          if (next.length === group.current.length) continue;
          if (next.length === 0) {
            if (group.kind === 'pi-ai') ops.push({ op: 'unset', path: ['providers', group.provider] });
            else ops.push({ op: 'set', path: group.path, value: [] });
          } else {
            ops.push({ op: 'set', path: group.path, value: next });
          }
          for (const modelId of group.requested) {
            results.push({ provider: group.provider, modelId, removed: group.current.some((model) => model?.id === modelId), remaining: next.length });
          }
        }
        if (ops.length > 0) operations.set(namespace, ops);
      }
      const removed = results.filter((result) => result.removed).length;
      if (operations.size === 0) return { results, removed };
      const backup = this.backupSettings();
      for (const [namespace, ops] of operations) await settings.mutate(namespace, ops);
      changed = true;
      for (const result of results) {
        if (result.removed) this.state.forgetOwned(result.provider, [result.modelId]);
      }
      const firstHit = results.find((result) => result.removed) ?? results[0];
      this.state.data.lastRemove = {
        at: Date.now(),
        provider: firstHit.provider,
        modelId: firstHit.modelId,
        backup,
        items: results.map(({ provider, modelId, removed: hit }) => ({ provider, modelId, removed: hit })),
      };
      this.state.save();
      this.logger.info?.(`dsh-model-sync: removed ${removed} owned model(s)`);
      return { results, removed };
    } finally {
      this.running = false;
      if (changed && recheck) this.refreshAfterMutation();
    }
  }

  /**
   * Fire-and-forget upstream refresh after a settings write. Never blocks the
   * request path and never throws: even a fully failed check only means the
   * next explicit check or startup will catch up.
   */
  refreshAfterMutation() {
    if (this.running) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    void (async () => {
      try {
        await this.check();
      } catch {
        /* background refresh is best effort */
      } finally {
        this.refreshing = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          this.refreshAfterMutation();
        }
      }
    })();
  }

  /** Single-model facade kept for existing callers (e.g. older clients). */
  async removeSiblingModel(provider, modelId) {
    const out = await this.removeSiblingModels([{ provider, modelId }]);
    return { removed: out.results[0].removed, remaining: out.results[0].remaining };
  }

  async discoverModels(target) {
    const key = await this.resolveCredential(target.credentialRef);
    const errors = [];
    for (const base of target.baseUrls) {
      const url = modelsUrl(base);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
        let response;
        try {
          response = await fetch(url, {
            headers: {
              accept: 'application/json',
              ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
              'user-agent': USER_AGENT,
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        const models = parseListing(await response.json());
        if (models.length === 0) throw new Error(`${url} advertised no models`);
        return { models, base: url };
      } catch (error) {
        errors.push(`${url}: ${errorText(error)}`);
      }
    }
    throw new Error(errors.join('; ') || 'no discovery base URL');
  }

  async modelsDevIndex({ allowNetwork = true } = {}) {
    if (this.modelsDevIndexCache !== undefined) return this.modelsDevIndexCache;
    let cache = this.state.readModelsDevCache(MODELS_DEV_TTL_MS);
    if (cache !== undefined && cache.stale !== true) {
      this.modelsDevIndexCache = buildModelsDevIndex(cache.data);
      return this.modelsDevIndexCache;
    }
    if (!allowNetwork) {
      const fallback = cache ?? this.state.readModelsDevCache(undefined);
      return fallback === undefined ? buildModelsDevIndex({}) : buildModelsDevIndex(fallback.data);
    }
    try {
      const response = await fetch(MODELS_DEV_URL, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
      const data = await response.json();
      this.state.writeModelsDevCache(data);
      this.modelsDevIndexCache = buildModelsDevIndex(data);
      return this.modelsDevIndexCache;
    } catch (error) {
      cache = this.state.readModelsDevCache(undefined);
      if (cache !== undefined) {
        this.logger.warn?.(`dsh-model-sync: models.dev unavailable (${errorText(error)}); using cached copy`);
        this.modelsDevIndexCache = buildModelsDevIndex(cache.data);
        return this.modelsDevIndexCache;
      }
      this.logger.warn?.(`dsh-model-sync: models.dev unavailable (${errorText(error)}); protocol fallbacks only`);
      return buildModelsDevIndex({});
    }
  }

  /** Read-only check: discover upstream and diff against current settings. */
  async check() {
    this.discoveryCache.clear();
    const { targets, unmanaged } = this.routeTargets();
    const modelsDevIndex = await this.modelsDevIndex();
    const piAiProviders = readSettingsSection(this.settings(), 'llm-pi-ai')?.providers ?? {};
    const results = [];
    for (const target of targets) {
      const { route } = target;
      const credential = await this.describeCredential(target.credentialRef);
      const credentialFact = credential === undefined ? {} : { credential };
      if (!target.managed) {
        results.push({ provider: route.provider, status: 'unmanaged', reason: '未纳管', ...credentialFact });
        continue;
      }
      let found;
      try {
        found = await this.discoverModels(target);
        this.discoveryCache.set(route.provider, { models: found.models, base: found.base, at: Date.now() });
      } catch (error) {
        results.push({ provider: route.provider, status: 'discovery-failed', error: errorText(error), ...credentialFact });
        continue;
      }
      if (route.adapter === 'deepseek') {
        const planned = planDeepseekAdditions(route, found.models, target.existingModels, modelsDevIndex, undefined);
        const { removed } = deepseekExisting(target.existingModels, found.models);
        results.push({
          provider: route.provider,
          adapter: 'deepseek',
          status: 'ok',
          defaultSelected: route.defaultSelected !== false,
          discoveryBase: found.base,
          discovered: found.models.length,
          newItems: planned.additions.map((entry) => ({
            id: entry.id,
            name: entry.name,
            target: route.provider,
            ...vendorForModel(modelsDevIndex, entry.id, route.vendor),
            entry,
          })),
          allItems: this.decorateAllItems(route, planned.allItems),
          skipped: planned.skipped,
          removed,
          repairs: [],
          ...credentialFact,
        });
        continue;
      }
      const updates = detectRouteUpdates(route, found.models, piAiProviders, modelsDevIndex);
      const repairs = detectRouteRepairs(route, piAiProviders, modelsDevIndex);
      results.push({
        provider: route.provider,
        adapter: 'pi-ai',
        status: 'ok',
        defaultSelected: route.defaultSelected !== false,
        discoveryBase: found.base,
        discovered: found.models.length,
        newItems: updates.newItems.map((item) => ({
          ...item,
          entry: buildPiAiEntry(
            { id: item.id, name: item.name },
            undefined,
            modelsDevMeta(modelsDevIndex, route.modelsDevProvider, item.id),
            route,
            item.api,
          ),
        })),
        allItems: this.decorateAllItems(route, updates.allItems),
        skipped: updates.skipped,
        removed: updates.removed,
        repairs: repairs.map(({ entry, ...rest }) => rest),
        ...credentialFact,
      });
    }
    const payload = { at: Date.now(), results, unmanaged };
    const previousByProvider = new Map((this.state.data.lastCheck?.results ?? []).map((result) => [result.provider, result]));
    if (!this.state.data.providerUpdates || typeof this.state.data.providerUpdates !== 'object') this.state.data.providerUpdates = {};
    for (const result of results) {
      const previous = previousByProvider.get(result.provider);
      const previousIds = new Set((previous?.newItems ?? []).map((item) => item.id));
      const currentIds = (result.newItems ?? []).map((item) => item.id);
      const discoveredNew = currentIds.some((id) => !previousIds.has(id))
        || (previous === undefined && currentIds.length > 0)
        || (this.state.data.providerUpdates?.[result.provider] === undefined && currentIds.length > 0);
      if (discoveredNew) this.state.data.providerUpdates[result.provider] = payload.at;
    }
    this.state.data.lastCheck = { at: payload.at, results: results.map(displayResult), unmanaged };
    this.state.save();
    return payload;
  }

  /**
   * Apply selected additions plus the approved repair pass.
   * @param selections - { [provider]: string[] } model ids to add.
   * @param options - { repairs?: boolean }.
   */
  async applySelection(selections = {}, { repairs: includeRepairs = false, rememberHabit = true, recheck = true } = {}) {
    if (this.running) throw new Error('已有一个任务在运行');
    this.running = true;
    try {
      const settings = this.settings();
      const hasSnapshot = (this.state.data.lastCheck?.results ?? []).some((result) => Array.isArray(result.allItems) && result.allItems.length > 0);
      const modelsDevIndex = await this.modelsDevIndex({ allowNetwork: !hasSnapshot });
      const piAiProviders = readSettingsSection(settings, 'llm-pi-ai')?.providers ?? {};
      const { targets } = this.routeTargets();
      const applied = [];
      const errors = [];
      let backup;
      for (const target of targets) {
        const { route } = target;
        if (!target.managed) continue;
        const selectedIds = selections[route.provider] ?? [];
        let found;
        try {
          const cached = this.discoveryCache.get(route.provider);
          if (cached !== undefined && Date.now() - cached.at <= DISCOVERY_CACHE_TTL_MS) {
            found = cached;
          } else {
            const previous = this.state.data.lastCheck?.results?.find((result) => result.provider === route.provider);
            const previousModels = Array.isArray(previous?.allItems)
              ? previous.allItems.filter((item) => typeof item?.id === 'string').map((item) => ({ id: item.id, name: item.name }))
              : undefined;
            found = previousModels !== undefined && previousModels.length > 0
              ? { models: previousModels, base: previous.discoveryBase }
              : await this.discoverModels(target);
          }
        } catch (error) {
          if (selectedIds.length > 0) errors.push(`${route.provider}: ${errorText(error)}`);
          continue;
        }
        const previous = this.state.data.lastCheck?.results?.find((result) => result.provider === route.provider);
        const previousById = new Map((previous?.allItems ?? []).map((item) => [item.id, item]));
        const selectedPrevious = selectedIds
          .map((id) => previousById.get(id))
          .filter((item) => item !== undefined && item.status === 'available' && typeof item.target === 'string');
        const operations = [];
        if (route.adapter === 'deepseek') {
          if (selectedIds.length > 0) {
            if (selectedPrevious.length === selectedIds.length) {
              const entries = selectedPrevious.map((item) => buildDeepseekEntry(
                { id: item.id, name: item.name },
                undefined,
                modelsDevMeta(modelsDevIndex, route.modelsDevProvider, item.id),
                route,
              ));
              const known = new Set(target.existingModels.map((model) => model.id));
              operations.push({ op: 'set', path: ['models'], value: [...target.existingModels, ...entries.filter((entry) => !known.has(entry.id))] });
            } else {
              const planned = planDeepseekAdditions(route, found.models, target.existingModels, modelsDevIndex, selectedIds);
              if (planned.additions.length > 0) operations.push({ op: 'set', path: ['models'], value: planned.models });
            }
          }
        } else {
          let additions;
          if (selectedPrevious.length === selectedIds.length && selectedIds.length > 0) {
            additions = selectedPrevious.map((item) => ({
              ...item,
              entry: buildPiAiEntry(
                { id: item.id, name: item.name },
                undefined,
                modelsDevMeta(modelsDevIndex, route.modelsDevProvider, item.id),
                route,
                item.api,
              ),
            }));
          } else {
            const updates = detectRouteUpdates(route, found.models, piAiProviders, modelsDevIndex);
            const selected = new Set(selectedIds);
            additions = updates.newItems
              .filter((item) => selected.has(item.id))
              .map((item) => ({
                ...item,
                entry: buildPiAiEntry(
                  { id: item.id, name: item.name },
                  undefined,
                  modelsDevMeta(modelsDevIndex, route.modelsDevProvider, item.id),
                  route,
                  item.api,
                ),
              }));
          }
          const repairs = includeRepairs ? detectRouteRepairs(route, piAiProviders, modelsDevIndex) : [];
          if (additions.length > 0 || repairs.length > 0) {
            const planned = planRouteChanges(route, piAiProviders, { additions, repairs }, target.credentialRef, this.state.knownSiblings(route.provider));
            operations.push(...planned.operations);
            if (planned.createdSiblings.length > 0) {
              this.state.rememberSiblings(route.provider, [...new Set([...this.state.knownSiblings(route.provider), ...planned.createdSiblings])]);
            }
            for (const entry of planned.blocked) this.logger.warn?.(`dsh-model-sync: ${route.provider}: ${entry.provider} — ${entry.reason}`);
          }
        }
        if (operations.length === 0) continue;
        if (backup === undefined) backup = this.backupSettings();
        try {
          await settings.mutate(route.settingsNs, operations);
          applied.push({ provider: route.provider, added: selectedIds.length });
          this.logger.info?.(`dsh-model-sync: applied ${route.provider} (${selectedIds.length} selected)`);
        } catch (error) {
          errors.push(`${route.provider}: ${errorText(error)}`);
          this.logger.error?.(`dsh-model-sync: failed to apply ${route.provider}: ${errorText(error)}`);
        }
      }
      this.state.data.lastApply = { at: Date.now(), applied, errors, backup };
      if (rememberHabit && errors.length === 0) {
        if (!this.state.data.selectionHabits || typeof this.state.data.selectionHabits !== 'object') this.state.data.selectionHabits = {};
        const appliedProviders = new Set(applied.map((entry) => entry.provider));
        for (const result of this.state.data.lastCheck?.results ?? []) {
          const items = Array.isArray(result.newItems) ? result.newItems : [];
          if (items.length === 0) continue;
          const selected = selections[result.provider] ?? [];
          if (selected.length > 0 && appliedProviders.has(result.provider)) {
            this.state.data.selectionHabits[result.provider] = true;
          } else if (selected.length === 0) {
            delete this.state.data.selectionHabits[result.provider];
          }
        }
      }
      if (errors.length === 0) {
        const successfulProviders = new Set(applied.map((entry) => entry.provider));
        for (const result of this.state.data.lastCheck?.results ?? []) {
          if (!successfulProviders.has(result.provider)) continue;
          for (const item of result.newItems ?? []) {
            if (!(selections[result.provider] ?? []).includes(item.id)) continue;
            if (typeof item.target === 'string') this.state.rememberOwned(item.target, [item.id]);
          }
        }
      }
      this.state.save();
      if (recheck) await this.check();
      return { applied, errors, backup };
    } finally {
      this.running = false;
    }
  }

  backupSettings() {
    try {
      return this.state.backupSettingsFile(join(dshHome(), 'settings.yaml'));
    } catch (error) {
      this.logger.warn?.(`dsh-model-sync: settings backup failed: ${errorText(error)}`);
      return undefined;
    }
  }

  /**
   * Boot path: always check upstream; run the one-time protocol repair for the
   * v1 collapse if it has not run yet. Additions are never auto-applied.
   */
  async startup() {
    try {
      const payload = await this.check();
      const repairCount = payload.results.reduce((total, result) => total + (result.repairs?.length ?? 0), 0);
      if (repairCount > 0 && this.state.data.repairedAt === null) {
        this.logger.warn?.(`dsh-model-sync: repairing ${repairCount} misplaced model(s) left by the v1 strict mirror`);
        const outcome = await this.applySelection({}, { repairs: true, rememberHabit: false });
        if (outcome.errors.length === 0) {
          this.state.data.repairedAt = Date.now();
          this.state.save();
          this.logger.info?.(`dsh-model-sync: repair applied (${repairCount} model(s))`);
        } else {
          this.logger.error?.(`dsh-model-sync: repair incomplete: ${outcome.errors.join('; ')}`);
        }
        return;
      }
      const newCount = payload.results.reduce((total, result) => total + (result.newItems?.length ?? 0), 0);
      this.logger.info?.(`dsh-model-sync: update check complete — ${newCount} new model(s) available`);
    } catch (error) {
      this.logger.warn?.(`dsh-model-sync: startup check failed: ${errorText(error)}`);
    }
  }

  status() {
    return {
      running: this.running,
      repairedAt: this.state.data.repairedAt ?? null,
      lastCheck: this.state.data.lastCheck ?? null,
      lastApply: this.state.data.lastApply ?? null,
      managed: Object.fromEntries(Object.values(BUILTIN_ROUTES).map((route) => [route.provider, this.state.managedOverride(route.provider) ?? route.managedByDefault])),
      selectionHabits: { ...(this.state.data.selectionHabits ?? {}) },
      providerUpdates: { ...(this.state.data.providerUpdates ?? {}) },
      lastOpenedAt: this.state.data.lastOpenedAt ?? 0,
      startupDelayMs: STARTUP_DELAY_MS,
    };
  }

  markOpened() {
    return this.state.markOpened();
  }

  setSelectionHabit(provider, enabled) {
    if (BUILTIN_ROUTES[provider] === undefined) throw new Error(`unknown route "${provider}"`);
    this.state.setSelectionHabit(provider, enabled === true);
  }

  setManaged(provider, managed) {
    if (BUILTIN_ROUTES[provider] === undefined) throw new Error(`unknown route "${provider}"`);
    if (!this.state.data.managed || typeof this.state.data.managed !== 'object') this.state.data.managed = {};
    this.state.data.managed[provider] = managed === true;
    this.state.save();
  }
}
