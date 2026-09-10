/**
 * dsh-model-sync — on-disk state (v2).
 *
 * Everything the plugin persists lives under `<DSH_HOME>/model-sync/`:
 *   state.json       last check / last apply / sibling ledger / repair marker
 *   models.dev.json  cached models.dev api.json (metadata + protocol mapping)
 *   backups/         settings.yaml snapshots taken before each write
 *
 * The plugin never stores credentials.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

const DEFAULT_STATE = {
  version: 2,
  managed: {},
  siblings: {},
  repairedAt: null,
  lastCheck: null,
  lastApply: null,
};

export class SyncState {
  constructor(dir = pluginDir()) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
    this.modelsDevFile = join(dir, 'models.dev.json');
    this.backupDir = join(dir, 'backups');
    const loaded = readJson(this.file, undefined);
    if (loaded !== undefined && loaded.version === 2) {
      this.data = loaded;
    } else {
      // v1 migration: keep the managed overrides, drop strict-mirror history.
      this.data = { ...structuredClone(DEFAULT_STATE) };
      if (loaded !== undefined && typeof loaded.managed === 'object') this.data.managed = loaded.managed;
      if (loaded !== undefined && typeof loaded.siblings === 'object') this.data.siblings = loaded.siblings;
    }
    for (const key of Object.keys(DEFAULT_STATE)) {
      if (this.data[key] === undefined) this.data[key] = structuredClone(DEFAULT_STATE[key]);
    }
  }

  save() {
    writeJsonAtomic(this.file, this.data);
  }

  managedOverride(provider) {
    const value = this.data.managed?.[provider];
    return value === true ? true : value === false ? false : undefined;
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
    const target = join(this.backupDir, `settings-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`);
    writeFileSync(target, readFileSync(settingsFile));
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
