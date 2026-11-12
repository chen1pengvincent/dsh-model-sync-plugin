import fs from 'node:fs';
import {
  buildDeepseekEntry, buildPiAiEntry, buildModelsDevIndex, detectRouteRepairs,
  detectRouteUpdates, expectedSiblingNames, modelsDevMeta, modelsUrl, parseListing, planRouteChanges,
} from './engine.js';
import { atPath, configuredTargets, settingsDescriptors } from './providers.js';
import { discoverOfficialModels } from './official.js';
import { catalogSummary } from './catalog.js';

export const STARTUP_DELAY_MS = 8_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const clone = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ids = (models) => new Set(models.map((model) => model.id));

function userError(message, status = 400) {
  return Object.assign(new Error(message), { status, safe: true, publicMessage: message });
}

function reasonFor(error, fallback = '操作失败；配置和上次成功目录均已保留，请重试') {
  if (error?.safe === true && typeof error.publicMessage === 'string') return error.publicMessage;
  if (error?.code === 'SETTINGS_CONFLICT' || error?.name === 'SettingsConflictError') {
    return '模型配置已被其他窗口修改，请重新检查后确认选择；本次未覆盖配置';
  }
  return fallback;
}

function validateModels(models) {
  if (!Array.isArray(models) || models.some((item) => !object(item) || typeof item.id !== 'string' || !item.id.trim())) {
    throw userError('模型列表格式无效，请重新检查');
  }
  if (ids(models).size !== models.length) throw userError('模型 ID 重复，请先在 DSH 中消除重复配置');
  return models;
}

function publicResult(result) {
  const { configScope, ...rest } = result;
  return { ...rest, newItems: (result.newItems ?? []).map(({ entry, ...item }) => item) };
}

/** Old command integrations can still read a section, but never guess an entry id. */
export function readSettingsSection(settings, ns) {
  return settingsDescriptors(settings, { redactSecrets: false }).find((entry) => entry.ns === ns)?.value;
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
    this.checkPromise = undefined;
    this.disposed = false;
    this.scopeEpoch = 0;
  }

  settings() { return this.ctx.get('settings'); }
  routeTargets() { return configuredTargets(this.ctx, this.state, { redactSecrets: false }); }

  async resolveCredential(ref) {
    if (!ref) return undefined;
    try {
      const value = (await this.ctx.get('credentials')?.resolve(ref))?.value;
      if (typeof value === 'string' && value.trim()) return value;
    } catch { /* A resolver failure is not permission to display its error or secret. */ }
    const value = process.env[ref];
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  async describeCredential(ref) {
    if (!ref) return { ref, configured: false, warning: '尚未配置 API 凭证引用' };
    try {
      const metadata = await this.ctx.get('credentials')?.describe(ref);
      if (metadata) {
        const readOnly = metadata.writable === false;
        return {
          ref, configured: metadata.configured === true, source: metadata.source,
          writable: metadata.writable, readOnly, shadowed: metadata.shadowed,
          warning: readOnly ? '当前凭证来自只读环境或密钥存储；本插件不会修改凭证' : undefined,
        };
      }
    } catch { /* Metadata is optional. */ }
    return { ref, configured: Boolean(process.env[ref]), source: process.env[ref] ? 'environment' : undefined, writable: false };
  }

  async credentialFor(target) {
    for (const ref of target.credentialRefs ?? [target.credentialRef]) {
      const value = await this.resolveCredential(ref);
      if (value) return { ref, value };
    }
    return { ref: target.credentialRef, value: undefined };
  }

  scopeFor(target, credential, source = 'account-api') {
    // A public catalog does not depend on the secret, so rotating the key must not
    // look like a brand-new catalog and re-flag every model as newly added.
    const proof = source === 'models-dev' || source === 'official-schema'
      ? 'public-catalog'
      : credential.value;
    return this.state.catalogScope(target.configScope, JSON.stringify([credential.ref, proof, source]));
  }

  async effectiveModels(target) {
    if (Array.isArray(target.profile.models) && target.profile.models.length > 0) {
      return clone(validateModels(target.profile.models));
    }
    const llm = this.ctx.get('llm');
    if (typeof llm?.listModels !== 'function') return clone(validateModels(target.existingModels ?? []));
    let models;
    try { models = await llm.listModels(target.actualProvider); }
    catch { throw userError('无法读取 DSH 当前生效模型，不能安全保存；请先修复供应商配置'); }
    return validateModels(models).map((model) => {
      const row = { id: model.id };
      if (model.name !== undefined) row.name = model.name;
      if (model.inputModalities !== undefined) {
        row[target.route.adapter === 'deepseek' ? 'inputModalities' : 'input'] = clone(model.inputModalities);
      }
      // Do not materialize inherited token caps, protocol, or other SDK defaults.
      return row;
    });
  }

  async sdkIds(target) {
    if (target.route.adapter !== 'pi-ai' || typeof this.ctx.get('llm')?.discoverModels !== 'function') return undefined;
    const lookup = async (provider) => {
      try {
        // With no baseURL/apiKey this pi-ai hook is a static, no-network SDK lookup.
        return ids(validateModels(await this.ctx.get('llm').discoverModels(target.route.settingsNs, { provider })));
      } catch { return undefined; }
    };
    const direct = await lookup(target.actualProvider);
    if (direct !== undefined && direct.size > 0) return direct;
    // A custom-named route (for example "openai-work" pointing at
    // api.openai.com) has no installed catalog under its own name, but the
    // vendor's canonical catalog still describes the same models.
    const canonical = target.official?.vendor;
    return canonical !== undefined && canonical !== target.actualProvider ? lookup(canonical) : undefined;
  }

  async discoverModels(target, credential = undefined) {
    const auth = credential ?? await this.credentialFor(target);
    if (target.reason) throw userError(target.reason);
    if (target.official) {
      try {
        return await discoverOfficialModels(target.official, {
          apiKey: auth.value, headers: target.profile.headers, timeoutMs: DISCOVERY_TIMEOUT_MS,
        });
      } catch (error) {
        if (!this.codingCatalogUnavailable(target, error)) throw error;
        return await this.codingCatalogFallback(target);
      }
    }
    if (!target.legacy) throw userError('该端点不在已验证的官方 API 范围内');
    if (!auth.value) throw userError('未找到 API 凭证；请在 DSH 中配置后重试');
    // Retain the previously shipped integrations; never send credentials to a new proxy.
    for (const base of target.baseUrls) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), DISCOVERY_TIMEOUT_MS);
      try {
        const response = await fetch(modelsUrl(base), {
          headers: { Authorization: `Bearer ${auth.value}`, 'User-Agent': 'dsh-model-sync' },
          redirect: 'error', signal: abort.signal,
        });
        if (!response.ok) {
          const failure = userError(`模型目录请求失败（HTTP ${response.status}）`);
          failure.status = response.status;
          throw failure;
        }
        const body = await response.json();
        if (body?.has_more === true || body?.nextPageToken || body?.next_page) throw userError('目录存在未读取分页；已保留上次完整目录');
        const models = validateModels(parseListing(body, { strict: true }));
        if (models.length === 0) throw userError('上游返回空目录；不将其解释为删除全部模型');
        return { models, base, source: 'legacy-api' };
      } catch (error) {
        // Kimi Coding is a retained legacy route whose gateway has no /models;
        // only that exact missing-endpoint case may use the public catalog.
        if (this.codingCatalogUnavailable(target, error)) return await this.codingCatalogFallback(target);
        if (base === target.baseUrls.at(-1)) throw userError(reasonFor(error, '模型目录请求失败或超时；已保留上次完整目录'));
      } finally { clearTimeout(timer); }
    }
    throw userError('未配置可验证的模型目录端点');
  }

  /**
   * Kimi Coding's gateway answers 404 for /models (its coding keys are not
   * entitled to a list endpoint). Only that exact, evidence-based case may fall
   * back; auth or transport failures must stay failures.
   */
  codingCatalogUnavailable(target, error) {
    if (target.route.provider !== 'kimi-coding') return false;
    const status = error?.code === 'HTTP_ERROR' ? error.status : error?.status;
    return [404, 405, 501].includes(status);
  }

  /**
   * Public models.dev catalog for Kimi Coding. It is metadata only: no credential
   * is sent, and locally configured models are unioned in so a catalog lag is
   * never reported as a deletion.
   */
  async codingCatalogFallback(target) {
    const index = await this.modelsDevIndex({ allowNetwork: true });
    const models = new Map();
    for (const providerId of ['kimi-code-plan-cn', 'kimi-code-plan-global']) {
      for (const [id, meta] of Object.entries(index.providers[providerId]?.models ?? {})) {
        if (models.has(id)) continue;
        const input = Array.isArray(meta.modalities?.input)
          ? meta.modalities.input.filter((value) => typeof value === 'string' && value.length > 0)
          : undefined;
        models.set(id, {
          id,
          ...(meta.name === undefined ? {} : { name: meta.name }),
          selectable: true,
          ...(meta.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow }),
          ...(meta.maxTokens === undefined ? {} : { maxTokens: meta.maxTokens }),
          ...(input === undefined || input.length === 0 ? {} : { input }),
        });
      }
    }
    for (const entry of [...(target.profile.models ?? []), ...(target.existingModels ?? [])]) {
      if (typeof entry?.id !== 'string' || models.has(entry.id)) continue;
      models.set(entry.id, {
        id: entry.id,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        selectable: true,
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
        ...(entry.input === undefined ? {} : { input: entry.input }),
      });
    }
    if (models.size === 0) {
      throw userError('Kimi Coding 官方接口未提供模型列表，且未能读取公开目录；已保留上次成功目录');
    }
    return {
      models: [...models.values()],
      base: 'https://models.dev/api.json',
      source: 'models-dev',
      notice: 'Kimi Coding 官方接口未提供模型列表（HTTP 404）；已改用 models.dev 公开目录，不会向该目录发送凭证。',
    };
  }

  async modelsDevIndex({ allowNetwork = true } = {}) {
    const cached = this.state.readModelsDevCache();
    if (cached?.data && (!allowNetwork || Date.now() - cached.at < MODELS_DEV_TTL_MS)) return buildModelsDevIndex(cached.data);
    if (!allowNetwork) return buildModelsDevIndex(cached?.data ?? {});
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DISCOVERY_TIMEOUT_MS);
    try {
      const response = await fetch('https://models.dev/api.json', { signal: abort.signal, redirect: 'error' });
      if (response.ok) {
        const data = await response.json();
        this.state.writeModelsDevCache(data);
        return buildModelsDevIndex(data);
      }
    } catch { /* Optional metadata must never erase a usable model catalog. */ }
    finally { clearTimeout(timer); }
    return buildModelsDevIndex(cached?.data ?? {});
  }

  baseResult(target) {
    return {
      provider: target.id, displayName: target.route.displayName, adapter: target.route.adapter,
      settingsRevision: target.settingsRevision, configScope: target.configScope,
      defaultSelected: own(this.state.data.selectionHabits, target.id) ? this.state.selectionHabit(target.id) : (target.route.defaultSelected ?? true),
      newItems: [], removed: [], skipped: [], repairs: [], allItems: [],
    };
  }

  async resultFor(target, found, metadata) {
    const base = this.baseResult(target);
    let result;
    if (target.legacy) {
      const profiles = target.descriptor.value.providers ?? {};
      const updates = detectRouteUpdates(target.route, found.models, profiles, metadata);
      result = { ...base, ...updates, repairs: detectRouteRepairs(target.route, profiles, metadata) };
      // Unsuitable rows stay in the diagnostics payload, never in the main list.
      result.allItems = updates.allItems.filter((item) => item.status !== 'skipped').map((item) => ({
        ...item, originProviderName: item.target, target: target.id,
        removable: item.added === true,
      }));
      result.skipped = (updates.skipped ?? []).map((item) => ({
        ...item, target: target.id, reasonCode: item.reasonCode ?? 'non-chat',
      }));
      result.removed = updates.removed.map((item) => ({ ...item, originProviderName: item.provider, provider: target.id }));
    } else {
      const effective = await this.effectiveModels(target);
      const enabled = new Map(effective.map((entry) => [entry.id, entry]));
      const upstream = ids(found.models);
      const upstreamById = new Map(found.models.map((model) => [model.id, model]));
      const sdkKnown = !target.profile.api && target.official?.vendor === 'openai' ? await this.sdkIds(target) : undefined;
      // Dated snapshots use ISO dates (OpenAI), compact dates (Anthropic) or
      // preview dates (Google); each form resolves to its undated alias.
      const snapshotAlias = (id) => id
        .replace(/-\d{4}-\d{2}-\d{2}$/u, '')
        .replace(/-20\d{6}$/u, '')
        .replace(/-preview-\d{2}-\d{2}$/u, '');
      const allItems = [];
      const skipped = [];
      for (const model of found.models) {
        let selectable = model.selectable !== false;
        let reason = model.reason;
        let reasonCode = selectable ? undefined : 'non-chat';
        let needsProtocol = false;
        let duplicateOf;
        if (selectable) {
          const alias = snapshotAlias(model.id);
          const aliasModel = alias !== model.id ? upstreamById.get(alias) : undefined;
          // OpenAI lists both a dated snapshot and its undated alias. They are
          // the same model, so the snapshot is noise in an explicit chooser.
          if (aliasModel !== undefined && aliasModel.selectable !== false) {
            selectable = false;
            duplicateOf = alias;
            reason = `与无日期别名 ${alias} 重复的日期快照，不单独展示。`;
            reasonCode = 'duplicate';
          }
        }
        if (selectable && !enabled.has(model.id) && target.official?.vendor === 'openai' && !target.profile.api && !sdkKnown?.has(model.id)) {
          if (target.official?.nativeProtocol) {
            // The user explicitly allows one provider-level protocol write to
            // unlock a chat model the installed SDK catalog does not describe.
            needsProtocol = true;
            reason = `该模型不在 DSH SDK 目录中；添加时会写入供应商协议 ${target.official.nativeProtocol}。`;
            reasonCode = 'protocol';
          } else {
            selectable = false;
            reason = '新模型的调用协议不在当前 SDK 目录中；请先在 DSH 为此供应商明确配置 API 协议，再检查';
            reasonCode = 'protocol';
          }
        }
        const added = enabled.has(model.id);
        const item = {
          id: model.id, name: model.name ?? model.id, target: target.id,
          api: needsProtocol ? target.official.nativeProtocol : (target.profile.api ?? target.official?.protocol),
          vendor: target.official?.vendor,
          added, removable: added, selectable,
          status: added ? 'added' : selectable ? 'available' : 'skipped',
          reason,
          ...(reasonCode ? { reasonCode } : {}),
          ...(needsProtocol ? { needsProtocol: true } : {}),
          ...(duplicateOf ? { duplicateOf } : {}),
        };
        if (item.status === 'skipped') skipped.push(item);
        else allItems.push(item);
      }
      const newItems = allItems.filter((item) => item.status === 'available').map((item) => {
        const discovered = found.models.find((model) => model.id === item.id);
        const entry = target.route.adapter === 'deepseek'
          ? buildDeepseekEntry(discovered, undefined, undefined, target.route)
          : buildPiAiEntry(discovered, undefined, undefined, target.route, item.api);
        return { ...item, entry };
      });
      result = { ...base, allItems, newItems,
        removed: effective.filter((entry) => !upstream.has(entry.id)).map((entry) => ({ id: entry.id, provider: target.id })),
        skipped,
      };
    }
    const displayable = result.allItems ?? [];
    const vendorIds = new Set(displayable
      .map((item) => item.vendorId ?? item.vendor)
      .filter((vendor) => vendor !== undefined && vendor !== 'other'));
    // Single-vendor providers use the two-column grid; multi-vendor gateways
    // keep their vendor-grouped cards. An unknown vendor bucket ("other") must
    // not turn a single-vendor route into a grouped one.
    const layout = target.route.multiVendor === true || vendorIds.size > 1 ? 'groups' : 'grid';
    return { ...result, layout, status: 'ok', base: found.base, source: found.source ?? 'account-api', notice: found.notice };
  }

  async check() {
    if (this.disposed) throw userError('插件已停止，请刷新后重试', 409);
    if (this.checkPromise) return this.checkPromise;
    if (this.running) {
      this.refreshQueued = true;
      return this.state.data.lastCheck ?? { at: Date.now(), results: [] };
    }
    this.refreshing = true;
    this.checkPromise = this.performCheck();
    try { return await this.checkPromise; }
    finally {
      this.checkPromise = undefined;
      this.refreshing = false;
      if (this.refreshQueued) { this.refreshQueued = false; this.refreshAfterMutation(); }
    }
  }

  async performCheck() {
    const targets = this.routeTargets();
    const metadata = await this.modelsDevIndex({ allowNetwork: targets.some((target) => target.managed && target.legacy) });
    const results = [];
    for (let target of targets) {
      if (this.disposed) break;
      if (!target.managed || target.reason) {
        results.push({ ...this.baseResult(target), status: target.managed ? 'unsupported' : 'unmanaged', reason: target.reason });
        continue;
      }
      const credential = await this.credentialFor(target);
      const credentialMetadata = await this.describeCredential(credential.ref);
      try {
        const found = await this.discoverModels(target, credential);
        const epoch = this.scopeEpoch;
        const current = this.routeTargets().find((item) => item.id === target.id);
        if (!current || current.configScope !== target.configScope || !current.managed) throw userError('供应商配置已变化，请重新检查');
        const currentCredential = await this.credentialFor(current);
        if (currentCredential.value !== credential.value || currentCredential.ref !== credential.ref) throw userError('供应商凭证已变化，请重新检查');
        target = current;
        const result = await this.resultFor(target, found, metadata);
        const finalTarget = this.routeTargets().find((item) => item.id === target.id);
        if (this.disposed || epoch !== this.scopeEpoch || !finalTarget || !finalTarget.managed || finalTarget.reason ||
          finalTarget.configScope !== target.configScope || finalTarget.settingsRevision !== target.settingsRevision) {
          throw userError('检查期间供应商配置或凭证发生变化；未采用此目录，请重新检查');
        }
        const scope = this.scopeFor(target, credential, result.source);
        // The unread baseline follows what the panel actually shows. Unsuitable
        // rows (non-chat endpoints, duplicate dated snapshots, unresolvable
        // protocols) are excluded so they cannot inflate added/removed counts.
        const visible = Array.isArray(result.allItems) ? new Set(result.allItems.map((item) => item.id)) : undefined;
        const committed = visible === undefined ? found.models : found.models.filter((model) => visible.has(model.id));
        this.state.commitCatalog(target.id, scope, target.configScope, committed, { base: found.base, allowEmpty: true });
        const record = this.state.catalog(target.id, target.configScope);
        record.source = result.source;
        record.notice = found.notice;
        result.catalog = catalogSummary(record);
        result.credential = credentialMetadata;
        this.discoveryCache.set(target.id, { ...found, at: record.checkedAt, scope });
        results.push(result);
      } catch (error) {
        const record = this.state.catalog(target.id, target.configScope);
        const reusable = record && record.scope === this.scopeFor(target, credential, record.source);
        let stale;
        if (reusable) {
          try { stale = await this.resultFor(target, record, metadata); } catch { /* Keep a failed card visible. */ }
        }
        results.push({ ...this.baseResult(target), ...stale, status: 'discovery-failed', stale: Boolean(reusable),
          reason: reasonFor(error, '目录检查失败；上次成功目录和未读变化已保留'), credential: credentialMetadata,
          catalog: reusable ? catalogSummary(record) : undefined,
        });
      }
    }
    const outcome = { at: Date.now(), results };
    if (this.disposed) return outcome;
    this.state.data.lastCheck = outcome;
    this.state.save();
    return outcome;
  }

  status() {
    const targets = this.routeTargets();
    const previous = this.state.data.lastCheck;
    const results = targets.map((target) => {
      const saved = previous?.results.find((item) => item.provider === target.id);
      if (!target.managed || target.reason) return publicResult({ ...this.baseResult(target), status: target.managed ? 'unsupported' : 'unmanaged', reason: target.reason });
      if (!saved || saved.configScope !== target.configScope || saved.settingsRevision !== target.settingsRevision) {
        return publicResult({ ...this.baseResult(target), status: 'needs-check', reason: '供应商已新增或配置已变化，请检查模型目录' });
      }
      const record = this.state.catalog(target.id, target.configScope);
      return publicResult({ ...saved, catalog: saved.catalog && record ? catalogSummary(record) : saved.catalog });
    });
    return {
      running: this.running || this.refreshing, lastCheck: { at: previous?.at, results },
      lastApply: this.state.data.lastApply, lastRemove: this.state.data.lastRemove,
      managed: targets.map((target) => ({ provider: target.id, displayName: target.route.displayName, managed: target.managed, reason: target.reason })),
      selectionHabits: this.state.data.selectionHabits, managedSiblings: this.managedSiblings(),
    };
  }

  async markViewed(provider, revision) {
    if (this.disposed) return { acknowledged: false, reason: '插件已停止' };
    const epoch = this.scopeEpoch;
    const target = this.routeTargets().find((item) => item.id === provider);
    if (!target || !target.managed || target.reason || typeof revision !== 'string') return { acknowledged: false, reason: '供应商或目录版本已失效' };
    const latest = this.state.data.lastCheck?.results.find((item) => item.provider === provider);
    const record = this.state.catalog(provider, target.configScope);
    if (latest?.status !== 'ok' || !record || latest.configScope !== target.configScope || latest.settingsRevision !== target.settingsRevision) {
      return { acknowledged: false, reason: '当前目录未成功读取，不能标记为已查看' };
    }
    const credential = await this.credentialFor(target);
    const current = this.routeTargets().find((item) => item.id === provider);
    const currentRecord = current && this.state.catalog(provider, current.configScope);
    if (this.disposed || epoch !== this.scopeEpoch || !current || !current.managed || current.reason ||
      current.configScope !== target.configScope || current.settingsRevision !== target.settingsRevision ||
      !currentRecord || currentRecord.scope !== record.scope ||
      currentRecord.scope !== this.scopeFor(current, credential, currentRecord.source)) {
      return { acknowledged: false, reason: '供应商或凭证已变化，请重新检查' };
    }
    // R may still be acknowledged while R+1 exists; the state layer advances
    // only to the exact rendered revision, never blindly to the latest one.
    const { acknowledged } = this.state.acknowledgeCatalog(provider, revision);
    return { acknowledged, reason: acknowledged ? undefined : '目录版本已过期',
      catalog: catalogSummary(this.state.catalog(provider, current.configScope)) };
  }

  // Backwards compatible endpoint; opening the panel is NOT a catalog receipt.
  markOpened() { return { acknowledged: false }; }

  setManaged(provider, managed) {
    if (!this.routeTargets().some((target) => target.id === provider)) throw userError('供应商已不存在');
    this.state.data.managed[provider] = Boolean(managed);
    this.state.save();
    this.refreshAfterMutation();
  }

  setSelectionHabit(provider, enabled) {
    if (!this.routeTargets().some((target) => target.id === provider)) throw userError('供应商已不存在');
    this.state.setSelectionHabit(provider, Boolean(enabled));
  }

  async backupSettings() {
    const settings = this.settings();
    const file = typeof settings?.prepareDocument === 'function'
      ? await settings.prepareDocument() : this.ctx.get('profileContext')?.patchPath;
    if (typeof file !== 'string' || !file || !fs.existsSync(file)) throw userError('无法备份当前配置补丁，已取消保存');
    this.state.backupSettingsFile(file);
  }

  async planOfficial(target, selected, removals, record, includeRepairs) {
    const effective = await this.effectiveModels(target);
    const existingIds = ids(effective);
    const requested = new Set(selected);
    for (const id of requested) if (removals.has(id)) throw userError('同一模型不能同时添加和移除');
    const result = await this.resultFor(target, record, new Map());
    const choices = new Map(result.newItems.map((item) => [item.id, item]));
    for (const id of requested) if (!existingIds.has(id) && !choices.has(id)) throw userError('选中的模型不在当前可用目录中，请重新检查');
    for (const id of removals) if (!existingIds.has(id)) throw userError('待移除模型已变化，请重新检查');
    let models = effective.filter((model) => !removals.has(model.id));
    const added = [...requested].filter((id) => !existingIds.has(id));
    models.push(...added.map((id) => clone(choices.get(id).entry)));
    if (models.length === 0) throw userError('不能移除最后一个模型：空列表会让 DSH 恢复默认目录，而不是禁用供应商');
    const ops = [];
    // A chat model the installed catalog does not describe needs an explicit
    // route protocol; the user opted into that write when selecting it.
    if (added.some((id) => choices.get(id)?.needsProtocol === true) && target.profile.api === undefined) {
      const nativeProtocol = target.official?.nativeProtocol;
      if (nativeProtocol === undefined) throw userError('该模型需要明确的供应商协议，但当前供应商没有可用的默认协议；未写入');
      ops.push({ op: 'set', path: [...target.settingsPath, 'api'], value: nativeProtocol });
    }
    const overrides = target.profile.modelOverrides;
    if (object(overrides) && Object.keys(overrides).length > 0 && (added.length || removals.size)) {
      // llm-pi-ai refuses modelOverrides beside an explicit models list. Migrate
      // every manual field onto the materialized entry (the override wins; the
      // entry keeps its id) instead of silently dropping or refusing the save.
      const finalIds = ids(models);
      if (Object.keys(overrides).some((id) => !finalIds.has(id) && !removals.has(id))) throw userError('存在无法匹配到模型的手工覆盖；本次未迁移或丢弃任何覆盖');
      models = models.map((model) => ({ ...model, ...clone(overrides[model.id] ?? {}) }));
      ops.push({ op: 'set', path: [...target.settingsPath, 'modelOverrides'], value: {} });
    }
    if (added.length || removals.size || ops.length) ops.push({ op: 'set', path: [...target.settingsPath, 'models'], value: models });
    return { target, ops, added: added.length, removed: removals.size, addedIds: added, removedIds: [...removals], createdSiblings: [] };
  }

  async planLegacy(target, selected, removals, record, includeRepairs) {
    const metadata = await this.modelsDevIndex({ allowNetwork: false });
    const profiles = target.descriptor.value.providers ?? {};
    // A native pi-ai route with no explicit models serves the installed catalog.
    // Writing only the additions would replace that catalog (and a modelOverrides
    // block beside a models list is refused by llm-pi-ai), so materialize what
    // the harness reports as served, with manual overrides merged in, and clear
    // the now-redundant overrides block.
    const overrides = object(target.profile.modelOverrides) ? target.profile.modelOverrides : {};
    const overrideIds = Object.keys(overrides);
    const explicitModels = Array.isArray(target.profile.models) ? target.profile.models : [];
    let servedModels;
    if (explicitModels.length === 0 || overrideIds.length > 0) {
      servedModels = await this.effectiveModels(target);
      if (overrideIds.length > 0) {
        const available = new Set(servedModels.map((model) => model.id));
        for (const id of overrideIds) {
          if (!available.has(id)) throw userError(`手工覆盖 "${id}" 无法匹配到当前生效模型；本次未写入`);
        }
        servedModels = servedModels.map((model) => ({ ...model, ...clone(overrides[model.id] ?? {}) }));
      }
    }
    const updates = detectRouteUpdates(target.route, record.models, profiles, metadata);
    const requested = new Set(selected);
    for (const id of requested) if (removals.has(id)) throw userError('同一模型不能同时添加和移除');
    // Discovery exposes display facts only. Construct writable entries from the
    // checked host snapshot at the explicit save boundary, never from the client.
    const discovered = new Map(record.models.map((model) => [model.id, model]));
    const additions = updates.newItems.filter((item) => requested.has(item.id)).map((item) => ({
      ...item,
      entry: buildPiAiEntry(discovered.get(item.id), undefined,
        modelsDevMeta(metadata, target.route.modelsDevProvider, item.id), target.route, item.api),
    }));
    for (const id of requested) if (!additions.some((item) => item.id === id) && !updates.allItems.some((item) => item.id === id && item.added)) throw userError('模型不可添加，请重新检查');
    const repairs = includeRepairs ? detectRouteRepairs(target.route, profiles, metadata) : [];
    const known = [...new Set([...this.state.knownSiblings(target.id), ...this.state.knownSiblings(target.actualProvider)])];
    // When explicit models coexist with modelOverrides, the merged rows (not the
    // raw profile list) are the baseline, so the manual fields survive the
    // materialization and the overrides block can be cleared in the same write.
    const plan = planRouteChanges(target.route, profiles,
      { additions, repairs, servedModels, seedServed: overrideIds.length > 0 }, target.credentialRef, known);
    if (plan.blocked.length) throw userError('同名协议路由不属于本插件；为保护已有配置，本次未保存');
    const ops = clone(plan.operations);
    const working = clone(profiles);
    // A removal-only apply never reaches planRouteChanges, so seed the merged
    // baseline here as well: filtering the raw rows would drop the manual
    // override fields right before the overrides block is cleared.
    if (overrideIds.length > 0 && explicitModels.length > 0 && removals.size > 0) {
      working[target.actualProvider] = { ...working[target.actualProvider], models: clone(servedModels) };
    }
    for (const operation of ops) {
      const path = operation.path.slice(1);
      let parent = working;
      for (const part of path.slice(0, -1)) parent = parent[part] ??= {};
      if (operation.op === 'unset') delete parent[path.at(-1)];
      else parent[path.at(-1)] = clone(operation.value);
    }
    let removed = 0;
    const names = [target.actualProvider, ...expectedSiblingNames(target.route)];
    for (const id of removals) {
      const owners = names.filter((name) => working[name]?.models?.some((model) => model.id === id));
      if (owners.length !== 1) throw userError('待移除模型不存在或分属多个协议路由，请在 DSH 中明确处理');
      const name = owners[0];
      const models = working[name].models.filter((model) => model.id !== id);
      if (!models.length) {
        const inherited = atPath(target.descriptor.base, ['providers', name]);
        if (name === target.actualProvider || !known.includes(name) || inherited !== undefined) throw userError('不能清空最后一个模型或删除非本插件独占的协议路由');
        delete working[name];
      } else working[name].models = models;
      removed += 1;
    }
    // Rebuild provider/model paths exactly once. Keep transport changes only
    // for surviving existing routes; a full create/unset owns all child paths.
    const finalOps = ops.filter((operation) => operation.path.length > 2
      && operation.path.at(-1) !== 'models'
      && profiles[operation.path[1]] && working[operation.path[1]]);
    for (const name of names) {
      const before = profiles[name];
      const after = working[name];
      if (!before && after) {
        finalOps.push({ op: 'set', path: ['providers', name], value: after });
      } else if (before && !after) {
        if (!known.includes(name) || atPath(target.descriptor.base, ['providers', name]) !== undefined) {
          throw userError('不能删除非本插件独占的协议路由；本次未写入');
        }
        finalOps.push({ op: 'unset', path: ['providers', name] });
      } else if (before && after && JSON.stringify(before.models) !== JSON.stringify(after.models)) {
        finalOps.push({ op: 'set', path: ['providers', name, 'models'], value: after.models });
      }
    }
    // The override fields were merged into the materialized entries above, so the
    // block must be cleared in the same write. Clear it only when the main
    // route's models are actually rewritten: a sibling-only or no-op apply would
    // otherwise drop manual overrides without persisting them anywhere.
    const mainModelsWritten = finalOps.some((operation) => operation.op === 'set'
      && operation.path.length === 3 && operation.path[0] === 'providers'
      && operation.path[1] === target.actualProvider && operation.path[2] === 'models');
    if (overrideIds.length > 0 && mainModelsWritten) {
      finalOps.push({ op: 'set', path: [...target.settingsPath, 'modelOverrides'], value: {} });
    }
    return { target, ops: finalOps, added: additions.length, removed, addedIds: additions.map((item) => item.id), removedIds: [...removals], createdSiblings: plan.createdSiblings };
  }

  async validatePlans(plans) {
    // Planning and prepareDocument/backup may await external services. Recheck
    // non-settings state too: Settings CAS alone cannot detect a replaced key,
    // revoked management consent, or disposal while those awaits were pending.
    const epoch = this.scopeEpoch;
    const credentials = await Promise.all(plans.map((plan) => this.credentialFor(plan.target)));
    const targets = this.routeTargets();
    if (this.disposed || epoch !== this.scopeEpoch) throw userError('保存期间配置或凭证发生变化；本组未写入，请重新检查', 409);
    for (const [index, plan] of plans.entries()) {
      const current = targets.find((target) => target.id === plan.target.id);
      const record = current && this.state.catalog(current.id, current.configScope);
      if (!current || !current.managed || current.reason || current.configScope !== plan.target.configScope ||
        current.settingsRevision !== plan.target.settingsRevision || !record || record.scope !== plan.catalogScope ||
        catalogSummary(record).revision !== plan.catalogRevision || Date.now() - record.checkedAt > CATALOG_TTL_MS ||
        plan.catalogScope !== this.scopeFor(current, credentials[index], plan.catalogSource)) {
        throw userError('保存期间供应商、凭证或目录发生变化；本组未写入，请重新检查', 409);
      }
    }
  }

  async applySelection(selections = {}, { removals = [], expectedRevisions = {}, repairs = false, rememberHabit = true, recheck = true } = {}) {
    if (this.disposed) throw userError('插件已停止，请刷新后重试', 409);
    if (this.running || this.refreshing) throw userError('正在检查或保存，请稍后重试', 409);
    if (!object(selections) || !object(expectedRevisions) || !Array.isArray(removals)) throw userError('选择参数格式无效');
    for (const selected of Object.values(selections)) if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string' || !id)) throw userError('模型 ID 列表无效');
    if (removals.some((item) => !object(item) || typeof item.provider !== 'string' || typeof item.id !== 'string')) throw userError('移除参数格式无效');
    const targets = this.routeTargets();
    const requested = new Set([...Object.keys(selections), ...removals.map((item) => item.provider)]);
    if (repairs) for (const target of targets.filter((item) => item.managed && item.legacy)) requested.add(target.id);
    const applied = [];
    const errors = [];
    const warnings = [];
    const outcome = { at: Date.now(), applied, errors, warnings };
    const groups = new Map();
    for (const provider of requested) {
      const target = targets.find((item) => item.id === provider);
      if (!target) { errors.push({ provider, reason: '供应商已不存在，请重新检查' }); continue; }
      const ns = target.route.settingsNs;
      const group = groups.get(ns) ?? { targets: [], plans: [], errors: [], revision: target.settingsRevision };
      group.targets.push(target);
      groups.set(ns, group);
    }
    this.running = true;
    try {
      for (const group of groups.values()) {
        for (const target of group.targets) {
          try {
            if (!target.managed || target.reason) throw userError('该供应商当前未托管或尚不支持实时目录');
            const result = this.state.data.lastCheck?.results.find((item) => item.provider === target.id);
            const expected = own(expectedRevisions, target.id) ? expectedRevisions[target.id] : result?.settingsRevision;
            if (target.settingsRevision !== undefined && (!Number.isSafeInteger(expected) || expected !== target.settingsRevision)) throw userError('模型配置已被修改，请重新检查后确认选择；本次未覆盖配置', 409);
            const record = this.state.catalog(target.id, target.configScope);
            if (result?.status !== 'ok' || !record || Date.now() - record.checkedAt > CATALOG_TTL_MS) throw userError('需要一次成功且未过期的目录检查后才能保存');
            const credential = await this.credentialFor(target);
            if (record.scope !== this.scopeFor(target, credential, record.source)) throw userError('凭证已变化，请重新检查后确认选择');
            const selected = [...new Set(selections[target.id] ?? [])];
            const removed = new Set(removals.filter((item) => item.provider === target.id).map((item) => item.id));
            const plan = await (target.legacy
              ? this.planLegacy(target, selected, removed, record, repairs)
              : this.planOfficial(target, selected, removed, record, repairs));
            group.plans.push({ ...plan, catalogScope: record.scope, catalogRevision: catalogSummary(record).revision, catalogSource: record.source });
          } catch (error) { group.errors.push({ provider: target.id, reason: reasonFor(error) }); }
        }
        if (group.errors.length) {
          for (const target of group.targets) errors.push(group.errors.find((item) => item.provider === target.id) ?? { provider: target.id, reason: '同一配置命名空间存在冲突；本组未进行任何写入' });
          continue;
        }
        const operations = group.plans.flatMap((plan) => plan.ops);
        try {
          const paths = operations.map((operation) => JSON.stringify(operation.path));
          if (new Set(paths).size !== paths.length) throw userError('选择涉及重叠的协议路由；本组未写入，请分别确认');
          if (operations.length) await this.backupSettings();
          await this.validatePlans(group.plans);
          if (operations.length) {
            await this.settings().mutate(group.targets[0].route.settingsNs, operations, group.revision);
          }
        } catch (error) {
          for (const target of group.targets) errors.push({ provider: target.id, reason: reasonFor(error) });
          continue;
        }
        // Settings.mutate is the commit point. Derived local bookkeeping must
        // never turn a committed operation into a retryable "nothing changed".
        for (const plan of group.plans) {
          applied.push({ provider: plan.target.id, displayName: plan.target.route.displayName, added: plan.added, removed: plan.removed, createdSiblings: plan.createdSiblings });
          try {
            if (plan.createdSiblings.length) this.state.rememberSiblings(plan.target.id, [...new Set([...this.state.knownSiblings(plan.target.id), ...plan.createdSiblings])]);
            this.state.rememberOwned(plan.target.id, plan.addedIds);
            this.state.forgetOwned(plan.target.id, plan.removedIds);
            if (rememberHabit && own(selections, plan.target.id)) this.state.data.selectionHabits[plan.target.id] = selections[plan.target.id].length > 0;
          } catch {
            warnings.push({ provider: plan.target.id, reason: '模型配置已保存，但插件状态记账未完成。请勿重复提交；重新检查配置后再操作。' });
          }
        }
      }
      outcome.at = Date.now();
      this.state.data.lastApply = outcome;
      try { this.state.save(); }
      catch {
        warnings.push({ reason: applied.length
          ? '模型配置已保存，但本次操作的插件状态保存失败。请勿重复提交；重新检查配置后再操作。'
          : '插件状态保存失败；本次未修改模型配置，请重新检查。' });
        this.state.data.lastApply = outcome;
      }
    } finally { this.running = false; }
    if (recheck && !this.disposed) {
      try { await this.check(); }
      catch { warnings.push({ reason: '保存结果已确认，但保存后的目录检查失败；请勿重复提交已成功的选择，请稍后重新检查。' }); }
    } else if (this.refreshQueued) { this.refreshQueued = false; this.refreshAfterMutation(); }
    return outcome;
  }

  siblingOwner(provider, owner) {
    const candidates = this.routeTargets().filter((target) => target.legacy &&
      expectedSiblingNames(target.route).includes(provider) && (owner === undefined || target.id === owner));
    if (candidates.length > 1) throw userError('协议路由属于多个配置命名空间，请指定 owner 后重试', 409);
    return candidates[0];
  }
  isExpectedSibling(provider, owner) { return Boolean(this.siblingOwner(provider, owner)); }

  managedSiblings() {
    const output = [];
    for (const target of this.routeTargets().filter((item) => item.legacy)) {
      const saved = this.state.data.lastCheck?.results.find((item) => item.provider === target.id);
      const record = this.state.catalog(target.id, target.configScope);
      const ready = target.managed && !target.reason && saved?.status === 'ok' &&
        saved.configScope === target.configScope && saved.settingsRevision === target.settingsRevision &&
        record && Date.now() - record.checkedAt <= CATALOG_TTL_MS;
      for (const provider of expectedSiblingNames(target.route)) {
        const profile = target.descriptor.value.providers?.[provider];
        if (!profile) continue;
        output.push({ provider, owner: target.id, routeProvider: target.actualProvider,
          settingsRevision: target.settingsRevision, status: ready ? 'ok' : 'needs-check',
          reason: ready ? undefined : target.reason ?? '请先检查此供应商的模型目录，再重新确认移除项',
          displayName: profile.displayName ?? provider,
          models: (profile.models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id })),
        });
      }
    }
    return output;
  }

  resolveRemovals(items) {
    if (!Array.isArray(items) || !items.length) throw userError('请至少选择一个模型');
    const targets = this.routeTargets();
    return items.map((item) => {
      if (!item || typeof item.provider !== 'string' || !item.provider || typeof item.id !== 'string' || !item.id ||
        (item.owner !== undefined && (typeof item.owner !== 'string' || !item.owner))) throw userError('模型移除项格式无效');
      const direct = targets.find((entry) => entry.id === item.provider);
      const target = direct && (item.owner === undefined || item.owner === direct.id)
        ? direct : this.siblingOwner(item.provider, item.owner);
      if (!target) throw userError('供应商不存在、owner 已失效或不属于本插件');
      return { provider: target.id, id: item.id };
    });
  }

  async removeManagedModels(items, options = {}) {
    const removals = this.resolveRemovals(items);
    const result = await this.applySelection({}, { ...options, removals });
    this.state.data.lastRemove = { at: result.at, removed: result.applied, errors: result.errors, warnings: result.warnings };
    try { this.state.save(); }
    catch {
      result.warnings.push({ reason: result.applied.length
        ? '模型配置已保存，但移除记录的插件状态保存失败。请勿重复提交；重新检查配置后再操作。'
        : '移除记录的插件状态保存失败；本次未修改模型配置，请重新检查。' });
    }
    return result;
  }

  async removeSiblingModels(items, options = {}) {
    if (!Array.isArray(items) || items.some((item) => !item || !this.isExpectedSibling(item.provider, item.owner))) throw userError('只能移除本插件识别的协议路由模型');
    return this.removeManagedModels(items, options);
  }
  async removeSiblingModel(provider, modelId) { return this.removeSiblingModels([{ provider, id: modelId }]); }

  refreshAfterMutation() {
    if (this.disposed) return;
    this.scopeEpoch += 1;
    if (this.running || this.refreshing) { this.refreshQueued = true; return; }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.disposed) void this.check().catch(() => this.logger.warn?.('模型目录刷新失败，已保留上次成功目录'));
    }, 250);
    this.refreshTimer.unref?.();
  }

  async startup() { return this.check(); } // Read-only: never auto-repair user settings.
  dispose() { this.disposed = true; clearTimeout(this.refreshTimer); }
}
