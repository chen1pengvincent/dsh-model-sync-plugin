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
  buildModelsDevIndex,
  buildPiAiEntry,
  detectRouteRepairs,
  detectRouteUpdates,
  modelsDevMeta,
  modelsUrl,
  parseListing,
  planDeepseekAdditions,
  planRouteChanges,
  primaryProtocol,
  deepseekExisting,
} from './engine.js';
import { BUILTIN_ROUTES } from './routes.js';
import { dshHome } from './state.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 20 * 1000;
export const STARTUP_DELAY_MS = 8000;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
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
   * A reference supplied by the launching environment (`source: 'env'`) is
   * read-only in the settings UI and shadows the managed store, so a user who
   * edits the key there sees no effect. Surfacing that fact here beats
   * debugging a "cannot change the API key" report. Returns `undefined` when
   * the seam or the method is absent (older kernels, tests).
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
      const shadowed = description.writable === false;
      return {
        ref,
        configured: true,
        source: description.source,
        writable: description.writable !== false,
        shadowed,
        ...(shadowed
          ? {
              warning: `凭证 ${ref} 由启动环境变量注入：设置页中它为只读，写入会被遮蔽。更换 Key 请先在启动环境里移除该变量（如 launchctl unsetenv ${ref}），再完全退出（⌘Q）并冷启动 DSH。`,
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
      const siblings = Object.keys(route.protocols ?? {})
        .filter((protocol) => protocol !== primaryProtocol(route))
        .map((protocol) => `${route.provider}-${route.siblingSuffix?.[protocol] ?? protocol}`);
      if (siblings.includes(provider)) return true;
    }
    return false;
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
              'user-agent': 'dsh-model-sync/0.5.1',
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

  async modelsDevIndex() {
    let cache = this.state.readModelsDevCache(MODELS_DEV_TTL_MS);
    if (cache !== undefined && cache.stale !== true) return buildModelsDevIndex(cache.data);
    try {
      const response = await fetch(MODELS_DEV_URL, { headers: { accept: 'application/json', 'user-agent': 'dsh-model-sync/0.5.1' } });
      if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
      const data = await response.json();
      this.state.writeModelsDevCache(data);
      return buildModelsDevIndex(data);
    } catch (error) {
      cache = this.state.readModelsDevCache(undefined);
      if (cache !== undefined) {
        this.logger.warn?.(`dsh-model-sync: models.dev unavailable (${errorText(error)}); using cached copy`);
        return buildModelsDevIndex(cache.data);
      }
      this.logger.warn?.(`dsh-model-sync: models.dev unavailable (${errorText(error)}); protocol fallbacks only`);
      return buildModelsDevIndex({});
    }
  }

  /** Read-only check: discover upstream and diff against current settings. */
  async check() {
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
          newItems: planned.additions.map((entry) => ({ id: entry.id, name: entry.name, target: route.provider, entry })),
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
        skipped: updates.skipped,
        removed: updates.removed,
        repairs: repairs.map(({ entry, ...rest }) => rest),
        ...credentialFact,
      });
    }
    const payload = { at: Date.now(), results, unmanaged };
    this.state.data.lastCheck = { at: payload.at, results: results.map(displayResult), unmanaged };
    this.state.save();
    return payload;
  }

  /**
   * Apply selected additions plus the approved repair pass.
   * @param selections - { [provider]: string[] } model ids to add.
   * @param options - { repairs?: boolean }.
   */
  async applySelection(selections = {}, { repairs: includeRepairs = false } = {}) {
    if (this.running) throw new Error('已有一个任务在运行');
    this.running = true;
    try {
      const settings = this.settings();
      const modelsDevIndex = await this.modelsDevIndex();
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
          found = await this.discoverModels(target);
        } catch (error) {
          if (selectedIds.length > 0) errors.push(`${route.provider}: ${errorText(error)}`);
          continue;
        }
        const operations = [];
        if (route.adapter === 'deepseek') {
          if (selectedIds.length > 0) {
            const planned = planDeepseekAdditions(route, found.models, target.existingModels, modelsDevIndex, selectedIds);
            if (planned.additions.length > 0) {
              operations.push({ op: 'set', path: ['models'], value: planned.models });
            }
          }
        } else {
          const updates = detectRouteUpdates(route, found.models, piAiProviders, modelsDevIndex);
          const selected = new Set(selectedIds);
          const additions = updates.newItems
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
      this.state.save();
      await this.check();
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
        const outcome = await this.applySelection({}, { repairs: true });
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
      startupDelayMs: STARTUP_DELAY_MS,
    };
  }

  setManaged(provider, managed) {
    if (BUILTIN_ROUTES[provider] === undefined) throw new Error(`unknown route "${provider}"`);
    if (!this.state.data.managed || typeof this.state.data.managed !== 'object') this.state.data.managed = {};
    this.state.data.managed[provider] = managed === true;
    this.state.save();
  }
}
