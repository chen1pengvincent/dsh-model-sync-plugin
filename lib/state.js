/**
 * dsh-model-sync — profile-local on-disk state (v3).
 *
 * Everything the plugin persists lives under the supplied profile directory
 * (with `<DSH_HOME>/model-sync/` retained as the standalone default):
 *   state.json       last check / last apply / sibling ledger / repair marker
 *   models.dev.json  cached models.dev api.json (metadata + protocol mapping)
 *   backups/         settings.yaml snapshots taken before each write
 *
 * The plugin never stores credentials.
 */

import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { acknowledgeCatalog, catalogSummary, updateCatalog } from './catalog.js';

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function pluginDir() {
  return join(dshHome(), 'model-sync');
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        writeFileSync(`${file}.corrupt-${Date.now()}`, readFileSync(file));
      } catch {
        /* best effort */
      }
    }
  }
  return fallback;
}

function sameFile(file, identity) {
  try {
    const current = lstatSync(file);
    return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
  } catch { return false; }
}

function writeJsonAtomic(file, value, beforeCommit = () => {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(value, null, 2);
  // Exclusive, same-directory temporaries also work across worker threads/PIDs.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(16).toString('hex')}`;
  let descriptor;
  let identity;
  try {
    descriptor = openSync(tmp, 'wx', 0o600);
    identity = fstatSync(descriptor);
    writeFileSync(descriptor, payload, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    beforeCommit();
    renameSync(tmp, file);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    // Never delete a pre-existing or replaced temporary belonging to another writer.
    if (identity && sameFile(tmp, identity)) {
      try { unlinkSync(tmp); } catch { /* original state is still untouched on failure */ }
    }
  }
}

const DEFAULT_STATE = {
  version: 3,
  catalogs: {},
  scopeSalt: null,
  managed: {},
  siblings: {},
  repairedAt: null,
  lastCheck: null,
  lastApply: null,
  lastRemove: null,
  selectionHabits: {},
  ownedModels: {},
  providerUpdates: {},
  lastOpenedAt: 0,
  // Global switch: route every host request through the user's system proxy.
  // Intentional default is ON — the fix must keep working after an upgrade
  // without the user re-discovering the toggle.
  proxyEnabled: true,
};

const MAP_KEYS = new Set(['catalogs', 'managed', 'siblings', 'ownedModels', 'selectionHabits', 'providerUpdates']);
const MISSING = Symbol('missing');
const LOCK_WAIT_MS = 120;
const LOCK_POLL_MS = 5;
const lockWaitCell = new Int32Array(new SharedArrayBuffer(4));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ownValue = (object, key) => Object.hasOwn(object, key) ? object[key] : MISSING;

class StateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncStateError';
    this.code = code;
    this.safe = true;
    this.publicMessage = message;
  }
}

const invalidState = () => new StateError('STATE_INVALID', '模型同步状态格式无效；原文件未改动，请检查状态文件后重试。');
const stateConflict = () => new StateError('STATE_CONFLICT', '模型同步状态已发生冲突，本次修改未保存；请基于最新状态重试。');

function withStateLock(file, operation) {
  const lockFile = `${file}.lock`;
  let descriptor;
  let identity;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (descriptor === undefined) {
      try { descriptor = openSync(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new StateError('STATE_BUSY', '另一个进程正在保存模型状态，或遗留锁仍存在；本次未保存，请稍后重试。');
        Atomics.wait(lockWaitCell, 0, 0, Math.min(LOCK_POLL_MS, remaining));
      }
    }
    identity = fstatSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* acquisition did not complete */ }
    }
    if (error instanceof StateError) throw error;
    throw new StateError('STATE_LOCK_FAILED', '无法取得模型状态锁；本次修改未保存。');
  }

  const lock = {
    committed: false,
    assertHeld() {
      if (!sameFile(lockFile, identity)) throw new StateError('STATE_LOCK_LOST', '模型状态锁发生变化；已拒绝继续保存。');
    },
  };
  let result;
  let failure;
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
    result = operation(lock);
  } catch (error) { failure = error; }
  finally {
    // Do not reclaim locks by age/PID or unlink a replacement lock. A crash leaves
    // a conservative busy failure until an operator verifies and removes the lock.
    try {
      lock.assertHeld();
      unlinkSync(lockFile);
    } catch {
      if (!failure) {
        failure = new StateError('STATE_LOCK_RELEASE_FAILED', lock.committed
          ? '模型状态已保存，但状态锁未能释放；请检查锁文件后再继续。'
          : '模型状态锁未能释放；请检查锁文件后重试。');
        failure.committed = lock.committed;
      }
    }
    try { closeSync(descriptor); }
    catch {
      if (!failure) {
        failure = new StateError('STATE_LOCK_RELEASE_FAILED', lock.committed
          ? '模型状态已保存，但状态锁句柄未能关闭。' : '模型状态锁句柄未能关闭；本次修改未保存。');
        failure.committed = lock.committed;
      }
    }
  }
  if (failure) {
    if (failure instanceof StateError) throw failure;
    const error = new StateError('STATE_IO_FAILED', lock.committed
      ? '模型状态已经提交，但后续处理失败；请重新读取状态。' : '模型状态读写失败；本次修改未保存。');
    error.committed = lock.committed;
    throw error;
  }
  return result;
}

function readStateFile(file) {
  try {
    if (!lstatSync(file).isFile()) throw invalidState();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) throw invalidState();
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof StateError) throw error;
    if (error instanceof SyntaxError) throw invalidState();
    throw new StateError('STATE_READ_FAILED', '无法读取模型同步状态；原文件未改动。');
  }
}

function normalizeState(loaded) {
  if (loaded === undefined) return structuredClone(DEFAULT_STATE);
  let data;
  if (loaded.version === 2 || loaded.version === 3) {
    data = { ...structuredClone(DEFAULT_STATE), ...loaded, version: 3 };
  } else if (loaded.version === undefined || loaded.version === 1) {
    data = structuredClone(DEFAULT_STATE);
    // A v1 catalog's metadata guessing is not a verified discovery baseline.
    for (const key of ['managed', 'siblings']) {
      if (Object.hasOwn(loaded, key)) {
        if (!isRecord(loaded[key])) throw invalidState();
        data[key] = loaded[key];
      }
    }
  } else {
    throw new StateError('STATE_VERSION_UNSUPPORTED', '模型状态版本不受支持；原文件未改动，禁止降级覆盖。');
  }
  for (const key of MAP_KEYS) if (!isRecord(data[key])) throw invalidState();
  // Hand-written fixtures and older state files predate the switch; a missing
  // value means "not turned off", never a read failure.
  if (typeof data.proxyEnabled !== 'boolean') data.proxyEnabled = true;
  return data;
}

function validateState(data) {
  if (!isRecord(data) || data.version !== 3 || typeof data.scopeSalt !== 'string' || !data.scopeSalt.length) throw invalidState();
  for (const key of MAP_KEYS) if (Object.hasOwn(data, key) && !isRecord(data[key])) throw invalidState();
}

function jsonSnapshot(data) {
  try {
    const result = JSON.parse(JSON.stringify(data));
    validateState(result);
    return result;
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw invalidState();
  }
}

function mergeValue(base, local, remote) {
  if (isDeepStrictEqual(local, base)) return remote;
  if (isDeepStrictEqual(remote, base) || isDeepStrictEqual(local, remote)) return local;
  throw stateConflict();
}

function mergeKeys(base, local, remote, mergeMaps = false) {
  const entries = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const previous = ownValue(base, key);
    const desired = ownValue(local, key);
    const current = ownValue(remote, key);
    let value;
    if (mergeMaps && MAP_KEYS.has(key) && isRecord(desired) && isRecord(current)
      && (isRecord(previous) || previous === MISSING)) {
      // Each catalog/ledger entry is an atomic unit. Never splice serial, seen,
      // models or generation from different snapshots of the same provider.
      value = mergeKeys(previous === MISSING ? {} : previous, desired, current);
    } else {
      value = mergeValue(previous, desired, current);
    }
    if (value !== MISSING) entries.push([key, value]);
  }
  // Object.fromEntries defines own keys safely, including a literal '__proto__'.
  return Object.fromEntries(entries);
}

function assertCatalogProgress(current, next) {
  for (const [provider, previous] of Object.entries(current.catalogs ?? {})) {
    const updated = next.catalogs && ownValue(next.catalogs, provider);
    if (updated === MISSING || updated === undefined) continue; // explicit deletion
    if (!isRecord(previous) || !isRecord(updated)) throw invalidState();
    if (previous.scope !== updated.scope) continue;
    // A new generation may reset the baseline only for a genuinely new scope.
    if (previous.generation !== updated.generation) throw stateConflict();
    for (const key of ['serial', 'seenSerial']) {
      if (Number.isSafeInteger(previous[key]) && (!Number.isSafeInteger(updated[key]) || updated[key] < previous[key])) throw stateConflict();
    }
    if (previous.seenSerial === updated.seenSerial && Array.isArray(previous.seenIds)
      && !isDeepStrictEqual(previous.seenIds, updated.seenIds)) throw stateConflict();
    if (previous.serial === updated.serial && Array.isArray(previous.ids)
      && !isDeepStrictEqual(previous.ids, updated.ids)) throw stateConflict();
    if (previous.firstViewedAt != null && updated.firstViewedAt !== previous.firstViewedAt) throw stateConflict();
  }
}

export class SyncState {
  #snapshot;
  constructor(dir = pluginDir()) {
    if (typeof dir !== 'string' || !dir.length) throw invalidState();
    this.dir = resolve(dir);
    this.file = join(this.dir, 'state.json');
    this.modelsDevFile = join(this.dir, 'models.dev.json');
    this.backupDir = join(this.dir, 'backups');
    withStateLock(this.file, (lock) => {
      const loaded = readStateFile(this.file);
      const initial = normalizeState(loaded);
      initial.scopeSalt ??= randomBytes(32).toString('hex');
      validateState(initial);
      // Persist the salt before exposing catalogScope(), even before first save.
      if (!isDeepStrictEqual(loaded, initial)) {
        writeJsonAtomic(this.file, initial, lock.assertHeld);
        lock.committed = true;
      }
      this.#adopt(initial);
    });
  }

  #adopt(data) {
    this.#snapshot = structuredClone(data);
    this.data = structuredClone(data);
  }

  /** A salted fingerprint detects account/key changes without persisting keys. */
  catalogScope(configScope, credential) {
    return createHmac('sha256', this.data.scopeSalt).update(JSON.stringify([configScope, credential ?? null])).digest('hex');
  }

  commitCatalog(provider, scope, configScope, models, options) {
    const record = updateCatalog(this.data.catalogs[provider], scope, models, options);
    record.configScope = configScope;
    this.data.catalogs[provider] = record;
    return catalogSummary(record);
  }

  catalog(provider, configScope) {
    const record = this.data.catalogs[provider];
    return record && (configScope === undefined || record.configScope === configScope) ? record : undefined;
  }

  acknowledgeCatalog(provider, revision) {
    const result = acknowledgeCatalog(this.data.catalogs[provider], revision);
    if (result.acknowledged) this.save();
    return result;
  }

  /** The global system-proxy switch; only an explicit `false` turns it off. */
  proxyEnabled() {
    return this.data.proxyEnabled !== false;
  }

  setProxyEnabled(enabled) {
    this.data.proxyEnabled = enabled === true;
    this.save();
  }

  save() {
    let committed = false;
    try {
      const local = jsonSnapshot(this.data);
      if (local.scopeSalt !== this.#snapshot.scopeSalt) throw stateConflict();
      withStateLock(this.file, (lock) => {
        const loaded = readStateFile(this.file);
        // A removed/replaced state file must not resurrect this stale snapshot.
        if (loaded === undefined) throw stateConflict();
        const current = normalizeState(loaded);
        validateState(current);
        try {
          if (current.scopeSalt !== this.#snapshot.scopeSalt) throw stateConflict();
          const merged = mergeKeys(this.#snapshot, local, current, true);
          validateState(merged);
          assertCatalogProgress(current, merged);
          if (!isDeepStrictEqual(current, merged)) {
            writeJsonAtomic(this.file, merged, lock.assertHeld);
            committed = lock.committed = true;
          }
          this.#adopt(merged);
        } catch (error) {
          // Conflicts are all-or-nothing and leave a usable, fresh in-memory view.
          // The caller must retry the operation, not re-save a rejected snapshot.
          if (!committed) this.#adopt(current);
          throw error;
        }
      });
    } catch (error) {
      if (!committed) this.data = structuredClone(this.#snapshot);
      if (error instanceof StateError) throw error;
      throw new StateError('STATE_IO_FAILED', '模型状态读写失败；本次修改未保存。');
    }
  }

  managedOverride(provider) {
    const value = this.data.managed?.[provider];
    return value === true ? true : value === false ? false : undefined;
  }

  selectionHabit(provider) {
    return this.data.selectionHabits?.[provider] === true;
  }

  setSelectionHabit(provider, enabled) {
    if (!this.data.selectionHabits || typeof this.data.selectionHabits !== 'object') this.data.selectionHabits = {};
    this.data.selectionHabits[provider] = enabled === true;
    this.save();
  }

  markOpened(now = Date.now()) {
    const previous = Number.isFinite(this.data.lastOpenedAt) ? this.data.lastOpenedAt : 0;
    this.data.lastOpenedAt = now;
    this.save();
    return previous;
  }

  ownsModel(provider, modelId) {
    const list = this.data.ownedModels?.[provider];
    return Array.isArray(list) && list.includes(modelId);
  }

  rememberOwned(provider, modelIds) {
    if (!this.data.ownedModels || typeof this.data.ownedModels !== 'object') this.data.ownedModels = {};
    const list = Array.isArray(this.data.ownedModels[provider]) ? this.data.ownedModels[provider] : [];
    for (const id of modelIds) if (!list.includes(id)) list.push(id);
    if (list.length > 0) this.data.ownedModels[provider] = list;
  }

  forgetOwned(provider, modelIds) {
    const list = this.data.ownedModels?.[provider];
    if (!Array.isArray(list)) return;
    const drop = new Set(modelIds);
    const next = list.filter((id) => !drop.has(id));
    if (next.length === 0) delete this.data.ownedModels[provider];
    else this.data.ownedModels[provider] = next;
  }

  knownSiblings(provider) {
    const list = this.data.siblings?.[provider];
    return Array.isArray(list) ? list : [];
  }

  rememberSiblings(provider, names) {
    if (!this.data.siblings || typeof this.data.siblings !== 'object') this.data.siblings = {};
    if (names.length === 0) delete this.data.siblings[provider];
    else this.data.siblings[provider] = [...names];
    this.save();
  }

  readModelsDevCache(maxAgeMs) {
    const cached = readJson(this.modelsDevFile, undefined);
    if (cached === undefined || typeof cached.at !== 'number' || cached.data === undefined) return undefined;
    if (maxAgeMs !== undefined && Date.now() - cached.at > maxAgeMs) return { ...cached, stale: true };
    return cached;
  }

  writeModelsDevCache(data) {
    writeJsonAtomic(this.modelsDevFile, { at: Date.now(), data });
  }

  backupSettingsFile(settingsFile) {
    if (!existsSync(settingsFile)) return undefined;
    mkdirSync(this.backupDir, { recursive: true });
    // The timestamp is descriptive; exclusive creation must never replace a snapshot.
    const target = join(this.backupDir, `settings-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(16).toString('hex')}.yaml`);
    writeFileSync(target, readFileSync(settingsFile), { flag: 'wx', mode: 0o600 });
    try {
      const indexFile = join(this.backupDir, 'index.txt');
      const entries = readFileSync(indexFile, 'utf8').split('\n').filter(Boolean);
      entries.push(target);
      while (entries.length > 20) entries.shift();
      writeFileSync(indexFile, `${entries.join('\n')}\n`);
    } catch {
      writeFileSync(join(this.backupDir, 'index.txt'), `${target}\n`);
    }
    return target;
  }
}
