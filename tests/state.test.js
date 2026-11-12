import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { SyncState } from '../lib/state.js';

function temporary(t) {
  const scope = { dir: mkdtempSync(join(tmpdir(), 'dsh-model-sync-state-')), cleanup: [] };
  t.after(async () => {
    for (const cleanup of [...scope.cleanup].reverse()) await cleanup();
    // This suite removes only the exact temporary directory it created.
    const target = resolve(scope.dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('dsh-model-sync-state-'));
    rmSync(target, { recursive: true, force: true });
  });
  return scope;
}

const file = dir => join(dir, 'state.json');
const persisted = dir => JSON.parse(readFileSync(file(dir), 'utf8'));
const bytes = dir => readFileSync(file(dir), 'utf8');
const models = (...ids) => ids.map(id => ({ id, selectable: true }));

function safeError(code) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.safe, true);
    assert.equal(error.publicMessage, error.message);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('dsh-model-sync-state-'));
    return true;
  };
}

function removeOwnState(dir) {
  const target = resolve(file(dir));
  assert.equal(dirname(target), resolve(dir));
  assert.equal(basename(target), 'state.json');
  unlinkSync(target);
}

function seedCatalog(dir, ids = ['model-a']) {
  const state = new SyncState(dir);
  const summary = state.commitCatalog('provider', 'account-scope', 'config-scope', models(...ids), { base: 'https://example.invalid/v1', at: 1 });
  state.save();
  return { state, summary };
}

test('initial salt is persisted before first save and stable across instances', t => {
  const { dir } = temporary(t);
  const first = new SyncState(dir);
  const second = new SyncState(dir);
  assert.match(first.data.scopeSalt, /^[a-f0-9]{64}$/u);
  assert.equal(first.data.scopeSalt, second.data.scopeSalt);
  assert.equal(persisted(dir).scopeSalt, first.data.scopeSalt);
  assert.equal(first.catalogScope('scope', 'stub-key'), second.catalogScope('scope', 'stub-key'));
  assert.equal(statSync(file(dir)).mode & 0o777, 0o600);
  assert.equal(existsSync(`${file(dir)}.lock`), false);
});

test('separate profile directories keep independent salts and state', t => {
  const one = temporary(t);
  const two = temporary(t);
  const first = new SyncState(one.dir);
  const second = new SyncState(two.dir);
  first.data.managed.provider = false;
  first.save();
  assert.notEqual(first.data.scopeSalt, second.data.scopeSalt);
  assert.deepEqual(persisted(two.dir).managed, {});
});

test('two stale Stores merge different provider keys and retain explicit false', t => {
  const { dir } = temporary(t);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.data.managed['instance-a'] = true;
  b.data.managed['instance-b'] = false;
  a.save();
  assert.equal(b.save(), undefined); // synchronous API remains unchanged
  assert.deepEqual(persisted(dir).managed, { 'instance-a': true, 'instance-b': false });
  assert.deepEqual(b.data.managed, persisted(dir).managed);
  a.data.selectionHabits['instance-a'] = false;
  a.save();
  assert.deepEqual(a.data.managed, { 'instance-a': true, 'instance-b': false });
});

test('a locally untouched key retains the remote latest value and additions', t => {
  const { dir } = temporary(t);
  const seed = new SyncState(dir);
  seed.data.managed.existing = false;
  seed.save();
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.data.managed.existing = true;
  a.data.managed.added = false;
  a.save();
  b.data.lastCheck = { at: 2, results: [] };
  b.save();
  assert.deepEqual(persisted(dir).managed, { existing: true, added: false });
  assert.deepEqual(persisted(dir).lastCheck, { at: 2, results: [] });
});

for (const key of ['managed', 'selectionHabits', 'siblings', 'ownedModels', 'providerUpdates']) {
  test(`independent ${key} entries merge without replacing the map`, t => {
    const { dir } = temporary(t);
    const a = new SyncState(dir);
    const b = new SyncState(dir);
    const value = key === 'siblings' || key === 'ownedModels' ? ['model-a'] : key === 'providerUpdates' ? { at: 1 } : false;
    a.data[key].a = value;
    b.data[key].b = value;
    a.save();
    b.save();
    assert.deepEqual(persisted(dir)[key], { a: value, b: value });
  });
}

test('explicit deletion affects only a key present in the local base', t => {
  const { dir } = temporary(t);
  const seed = new SyncState(dir);
  seed.data.managed.remove = true;
  seed.data.custom = { local: true };
  seed.save();
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  delete a.data.managed.remove;
  delete a.data.custom;
  b.data.managed.remoteAdded = false;
  b.data.remoteExtra = { kept: true };
  b.save();
  a.save();
  assert.deepEqual(persisted(dir).managed, { remoteAdded: false });
  assert.equal(Object.hasOwn(persisted(dir), 'custom'), false);
  assert.deepEqual(persisted(dir).remoteExtra, { kept: true });
});

test('remote deletion is not resurrected by an untouched stale Store', t => {
  const { dir } = temporary(t);
  const seed = new SyncState(dir);
  seed.data.ownedModels.provider = ['model-a'];
  seed.save();
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.forgetOwned('provider', ['model-a']);
  a.save();
  b.data.managed.other = false;
  b.save();
  assert.deepEqual(persisted(dir).ownedModels, {});
});

test('same-key divergent writes reject the complete transaction and refresh data', t => {
  const { dir } = temporary(t);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.data.managed.provider = true;
  b.data.managed.provider = false;
  b.data.selectionHabits.unrelatedPending = true;
  a.save();
  const before = bytes(dir);
  assert.throws(() => b.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.deepEqual(b.data, persisted(dir));
  assert.equal(Object.hasOwn(b.data.selectionHabits, 'unrelatedPending'), false);
  assert.equal(existsSync(`${file(dir)}.lock`), false);
  b.data.managed.provider = false; // explicitly retry against the refreshed state
  b.save();
  assert.equal(persisted(dir).managed.provider, false);
});

test('same-key identical concurrent writes are idempotent', t => {
  const { dir } = temporary(t);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.data.managed.provider = false;
  b.data.managed.provider = false;
  a.save();
  b.save();
  assert.equal(persisted(dir).managed.provider, false);
});

test('delete versus edit conflicts rather than guessing', t => {
  const { dir } = temporary(t);
  const seed = new SyncState(dir);
  seed.data.ownedModels.provider = ['a'];
  seed.save();
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  delete a.data.ownedModels.provider;
  b.rememberOwned('provider', ['b']);
  b.save();
  const before = bytes(dir);
  assert.throws(() => a.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.deepEqual(a.data.ownedModels.provider, ['a', 'b']);
});

test('top-level transaction records are atomic, not field-spliced', t => {
  const { dir } = temporary(t);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.data.lastCheck = { at: 1, results: ['a'] };
  b.data.lastCheck = { at: 2, results: ['b'] };
  a.save();
  const before = bytes(dir);
  assert.throws(() => b.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
});

test('different provider catalogs merge and commitCatalog still returns a summary', t => {
  const { dir } = temporary(t);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  const summary = a.commitCatalog('a', 'scope-a', 'config-a', models('model-a'), { at: 1 });
  b.commitCatalog('b', 'scope-b', 'config-b', models('model-b'), { at: 1 });
  assert.equal(typeof summary.revision, 'string');
  assert.equal(summary.total, 1);
  a.save();
  b.save();
  assert.deepEqual(Object.keys(persisted(dir).catalogs).sort(), ['a', 'b']);
  assert.equal(b.catalog('a', 'config-a').scope, 'scope-a');
  assert.equal(b.catalog('a', 'different'), undefined);
});

test('conflicting same-provider catalogs never splice models, scope or generation', t => {
  const { dir } = temporary(t);
  seedCatalog(dir);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.commitCatalog('provider', 'new-account', 'new-config', models('new-model'), { at: 2 });
  b.commitCatalog('provider', 'account-scope', 'config-scope', models('model-a', 'old-model'), { at: 3 });
  a.save();
  const before = bytes(dir);
  assert.throws(() => b.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.equal(b.catalog('provider').scope, 'new-account');
  assert.deepEqual(b.catalog('provider').ids, ['new-model']);
});

test('stale acknowledgement cannot replace a newer catalog revision', t => {
  const { dir } = temporary(t);
  const { summary } = seedCatalog(dir);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.commitCatalog('provider', 'account-scope', 'config-scope', models('model-a', 'model-b'), { at: 2 });
  a.save();
  const before = bytes(dir);
  assert.throws(() => b.acknowledgeCatalog('provider', summary.revision), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.equal(b.catalog('provider').serial, 2);
  assert.equal(b.catalog('provider').seenSerial, 1);
});

test('a discovery based on an old seen baseline cannot undo a newer acknowledgement', t => {
  const { dir } = temporary(t);
  const { state: seed } = seedCatalog(dir);
  const r2 = seed.commitCatalog('provider', 'account-scope', 'config-scope', models('model-a', 'model-b'), { at: 2 });
  seed.save();
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.acknowledgeCatalog('provider', r2.revision);
  b.commitCatalog('provider', 'account-scope', 'config-scope', models('model-a', 'model-b', 'model-c'), { at: 3 });
  const before = bytes(dir);
  assert.throws(() => b.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.equal(b.catalog('provider').seenSerial, 2);
  b.commitCatalog('provider', 'account-scope', 'config-scope', models('model-a', 'model-b', 'model-c'), { at: 3 });
  b.save();
  assert.equal(persisted(dir).catalogs.provider.serial, 3);
  assert.equal(persisted(dir).catalogs.provider.seenSerial, 2);
});

test('even uncontended writes cannot regress a same-generation seen baseline', t => {
  const { dir } = temporary(t);
  const { state } = seedCatalog(dir);
  const r2 = state.commitCatalog('provider', 'account-scope', 'config-scope', models('model-a', 'model-b'), { at: 2 });
  state.save();
  state.acknowledgeCatalog('provider', r2.revision);
  const before = bytes(dir);
  state.data.catalogs.provider.seenSerial = 1;
  state.data.catalogs.provider.seenIds = ['model-a'];
  assert.throws(() => state.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.equal(state.catalog('provider').seenSerial, 2);
});

test('unchanged stale saves adopt remote catalog receipts instead of rolling them back', t => {
  const { dir } = temporary(t);
  const { summary } = seedCatalog(dir);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.acknowledgeCatalog('provider', summary.revision);
  const before = bytes(dir);
  b.save();
  assert.equal(bytes(dir), before);
  assert.equal(b.catalog('provider').firstViewedAt, a.catalog('provider').firstViewedAt);
});

test('scopeSalt cannot be changed by a stale or direct save', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const before = bytes(dir);
  state.data.scopeSalt = 'changed';
  assert.throws(() => state.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.equal(state.data.scopeSalt, persisted(dir).scopeSalt);
});

test('a removed state file is not resurrected by an old Store', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  state.data.managed.old = true;
  removeOwnState(dir);
  assert.throws(() => state.save(), safeError('STATE_CONFLICT'));
  assert.equal(existsSync(file(dir)), false);
  const fresh = new SyncState(dir);
  state.data.managed.old = true;
  assert.throws(() => state.save(), safeError('STATE_CONFLICT'));
  assert.equal(state.data.scopeSalt, fresh.data.scopeSalt);
  assert.deepEqual(persisted(dir).managed, {});
});

test('malformed persisted state is preserved without a destructive fallback', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const malformed = '{"private-marker":"not-an-error-message",';
  writeFileSync(file(dir), malformed);
  state.data.managed.pending = true;
  assert.throws(() => state.save(), safeError('STATE_INVALID'));
  assert.equal(bytes(dir), malformed);
  assert.throws(() => new SyncState(dir), safeError('STATE_INVALID'));
  assert.equal(bytes(dir), malformed);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('future versions are refused rather than downgraded', t => {
  const { dir } = temporary(t);
  const original = JSON.stringify({ version: 99, managed: { keep: false } });
  writeFileSync(file(dir), original);
  assert.throws(() => new SyncState(dir), safeError('STATE_VERSION_UNSUPPORTED'));
  assert.equal(bytes(dir), original);
});

test('v2 migration preserves state and initializes a single persisted salt', t => {
  const { dir } = temporary(t);
  writeFileSync(file(dir), JSON.stringify({ version: 2, managed: { keep: false }, siblings: { keep: ['sibling'] } }));
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  assert.equal(a.data.version, 3);
  assert.deepEqual(a.data.managed, { keep: false });
  assert.deepEqual(a.data.siblings, { keep: ['sibling'] });
  assert.equal(a.data.scopeSalt, b.data.scopeSalt);
  assert.equal(persisted(dir).scopeSalt, a.data.scopeSalt);
});

test('invalid local JSON rolls back memory and leaves disk intact', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const before = bytes(dir);
  state.data.loop = state.data;
  assert.throws(() => state.save(), safeError('STATE_INVALID'));
  assert.equal(bytes(dir), before);
  assert.deepEqual(state.data, persisted(dir));
});

test('literal special map keys remain own data without prototype mutation', t => {
  const { dir } = temporary(t);
  const a = new SyncState(dir);
  const b = new SyncState(dir);
  a.data.managed = JSON.parse('{"__proto__":false}');
  b.data.managed.constructor = false;
  a.save();
  b.save();
  assert.equal(Object.getPrototypeOf(b.data.managed), Object.prototype);
  assert.equal(Object.hasOwn(b.data.managed, '__proto__'), true);
  assert.equal(b.data.managed.__proto__, false);
  assert.equal(b.data.managed.constructor, false);
});

test('busy or stale lock has a bounded wait and is never stolen or deleted', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const before = bytes(dir);
  const lock = `${file(dir)}.lock`;
  const marker = '{"pid":2147483647,"createdAt":1}';
  writeFileSync(lock, marker);
  state.data.managed.pending = true;
  const start = performance.now();
  assert.throws(() => state.save(), safeError('STATE_BUSY'));
  assert.ok(performance.now() - start < 2000);
  assert.equal(readFileSync(lock, 'utf8'), marker);
  assert.equal(bytes(dir), before);
  assert.deepEqual(state.data, persisted(dir));
});

test('pre-existing lock directory or symlink is not recursively removed', t => {
  for (const type of ['directory', 'symlink']) {
    const { dir } = temporary(t);
    const lock = `${file(dir)}.lock`;
    if (type === 'directory') mkdirSync(lock);
    else {
      const target = join(dir, 'lock-target');
      writeFileSync(target, 'keep');
      symlinkSync(target, lock);
    }
    assert.throws(() => new SyncState(dir), safeError('STATE_BUSY'));
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(file(dir)), false);
  }
});

test('same-scope generation changes cannot reset the seen baseline', t => {
  const { dir } = temporary(t);
  const { state } = seedCatalog(dir);
  const before = bytes(dir);
  state.data.catalogs.provider.generation = 'reset-generation';
  state.data.catalogs.provider.serial = 0;
  state.data.catalogs.provider.seenSerial = 0;
  assert.throws(() => state.save(), safeError('STATE_CONFLICT'));
  assert.equal(bytes(dir), before);
  assert.deepEqual(state.data, persisted(dir));
});

test('atomic rename failure preserves the original and cleans only owned temporary files', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const before = bytes(dir);
  const unrelated = join(dir, 'unrelated.tmp');
  writeFileSync(unrelated, 'keep');
  const rename = fs.renameSync;
  let observedLock = false;
  fs.renameSync = (source, destination) => {
    if (destination === file(dir)) {
      observedLock = existsSync(`${file(dir)}.lock`);
      throw Object.assign(new Error('private-fixture-detail'), { code: 'EACCES' });
    }
    return rename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    state.data.managed.pending = true;
    assert.throws(() => state.save(), safeError('STATE_IO_FAILED'));
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(observedLock, true);
  assert.equal(bytes(dir), before);
  assert.deepEqual(state.data, persisted(dir));
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
  assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'unrelated.tmp']);
});

test('lock release failure after commit reports committed state truthfully', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = target => {
    if (target === `${file(dir)}.lock`) throw Object.assign(new Error('private-fixture-detail'), { code: 'EACCES' });
    return unlink(target);
  };
  syncBuiltinESMExports();
  try {
    state.data.managed.committed = false;
    assert.throws(() => state.save(), error => {
      safeError('STATE_LOCK_RELEASE_FAILED')(error);
      assert.equal(error.committed, true);
      assert.match(error.message, /已保存/u);
      return true;
    });
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
  }
  assert.equal(persisted(dir).managed.committed, false);
  assert.deepEqual(state.data, persisted(dir));
  assert.equal(existsSync(`${file(dir)}.lock`), true);
});

test('backups at the same timestamp are unique private snapshots, not a deletion queue', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const settingsFile = join(dir, 'fixture-settings.yaml');
  const snapshots = [];
  const toISOString = Date.prototype.toISOString;
  Date.prototype.toISOString = () => '2026-01-02T03:04:05.006Z';
  try {
    for (let i = 0; i < 25; i++) {
      const contents = `fixture: ${i}\n`;
      writeFileSync(settingsFile, contents);
      snapshots.push({ path: state.backupSettingsFile(settingsFile), contents });
    }
  } finally {
    Date.prototype.toISOString = toISOString;
  }
  assert.equal(new Set(snapshots.map(snapshot => snapshot.path)).size, 25);
  for (const snapshot of snapshots) {
    assert.match(basename(snapshot.path), /^settings-2026-01-02T03-04-05-006Z-[a-f0-9]{32}\.yaml$/u);
    assert.equal(readFileSync(snapshot.path, 'utf8'), snapshot.contents);
    assert.equal(statSync(snapshot.path).mode & 0o777, 0o600);
  }
  const index = readFileSync(join(state.backupDir, 'index.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(index, snapshots.slice(-20).map(snapshot => snapshot.path));
  assert.equal(readdirSync(state.backupDir).filter(name => name.endsWith('.yaml')).length, 25);
});

test('an existing backup target is never overwritten, even on a nonce collision', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const settingsFile = join(dir, 'fixture-settings.yaml');
  writeFileSync(settingsFile, 'new settings');
  const write = fs.writeFileSync;
  let collisionTarget;
  fs.writeFileSync = (target, contents, options) => {
    if (typeof target === 'string' && dirname(target) === state.backupDir && target.endsWith('.yaml')) {
      // Simulate another writer winning the exclusive creation race.
      collisionTarget = target;
      write(target, 'existing backup', { flag: 'wx', mode: 0o600 });
    }
    return write(target, contents, options);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => state.backupSettingsFile(settingsFile), error => {
      assert.equal(error.code, 'EEXIST');
      assert.equal(error.path, collisionTarget);
      return true;
    });
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(collisionTarget, 'utf8'), 'existing backup');
  assert.equal(readFileSync(settingsFile, 'utf8'), 'new settings');
  assert.equal(existsSync(join(state.backupDir, 'index.txt')), false);
});

test('backup creation failures still propagate the original error without an index entry', t => {
  const { dir } = temporary(t);
  const state = new SyncState(dir);
  const settingsFile = join(dir, 'fixture-settings.yaml');
  writeFileSync(settingsFile, 'keep settings');
  const failure = Object.assign(new Error('fixture write failure'), { code: 'EIO' });
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, contents, options) => {
    if (typeof target === 'string' && dirname(target) === state.backupDir && target.endsWith('.yaml')) throw failure;
    return write(target, contents, options);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => state.backupSettingsFile(settingsFile), error => error === failure);
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(settingsFile, 'utf8'), 'keep settings');
  assert.deepEqual(readdirSync(state.backupDir), []);
});

// Two-phase IPC barriers ensure both independent OS processes have loaded the
// same starting snapshot before either writes. Only temporary fixtures are used.
function worker(scope, change) {
  const source = new URL('../lib/state.js', import.meta.url).href;
  const code = `
    import { SyncState } from ${JSON.stringify(source)};
    let state;
    process.send({ event: 'boot' });
    process.on('message', message => {
      try {
        if (message === 'init') {
          state = new SyncState(${JSON.stringify(scope.dir)});
          process.send({ event: 'ready', ok: true, salt: state.data.scopeSalt });
        } else if (message === 'go') {
          const change = ${JSON.stringify(change)};
          if (change.backup) {
            Date.prototype.toISOString = () => change.timestamp;
            const target = state.backupSettingsFile(change.settingsFile);
            process.send({ event: 'result', ok: true, target }, () => process.disconnect());
          } else {
            state.data.managed[change.key] = change.value;
            state.save();
            process.send({ event: 'result', ok: true, managed: state.data.managed }, () => process.disconnect());
          }
        }
      } catch (error) {
        process.send({ event: message === 'init' ? 'ready' : 'result', ok: false,
          error: { code: error.code, safe: error.safe, message: error.publicMessage } }, () => process.disconnect());
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: scope.dir, env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const queued = [];
  const waiting = [];
  let failure;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('message', message => {
    const waiter = waiting.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message); }
    else queued.push(message);
  });
  const exited = new Promise(resolveExit => {
    const finish = error => {
      failure = error;
      for (const waiter of waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
      resolveExit();
    };
    child.on('error', finish);
    child.on('exit', (status, signal) => finish(new Error(`fixture exited ${status ?? signal}: ${stderr}`)));
  });
  scope.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return {
    send(message) { child.send(message); },
    take() {
      if (queued.length) return Promise.resolve(queued.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolveMessage, reject) => {
        const waiter = { resolve: resolveMessage, reject };
        waiter.timer = setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error('state fixture IPC deadline exceeded'));
        }, 5000);
        waiting.push(waiter);
      });
    },
    exited,
  };
}

async function initializeWorkers(workers) {
  for (const event of await Promise.all(workers.map(child => child.take()))) assert.equal(event.event, 'boot');
  for (const child of workers) child.send('init');
  const ready = await Promise.all(workers.map(child => child.take()));
  for (const event of ready) { assert.equal(event.event, 'ready'); assert.equal(event.ok, true); }
  assert.equal(ready[0].salt, ready[1].salt);
}

test('independent processes initialize one salt and merge concurrent cross-key writes', async t => {
  const scope = temporary(t);
  const workers = [worker(scope, { key: 'one', value: true }), worker(scope, { key: 'two', value: false })];
  await initializeWorkers(workers);
  for (const child of workers) child.send('go');
  const results = await Promise.all(workers.map(child => child.take()));
  for (const result of results) { assert.equal(result.event, 'result'); assert.equal(result.ok, true); }
  await Promise.all(workers.map(child => child.exited));
  assert.deepEqual(persisted(scope.dir).managed, { one: true, two: false });
  assert.equal(existsSync(`${file(scope.dir)}.lock`), false);
  assert.deepEqual(readdirSync(scope.dir), ['state.json']);
});

test('independent processes reject same-key stale conflicts without changing disk', async t => {
  const scope = temporary(t);
  const workers = [worker(scope, { key: 'same', value: true }), worker(scope, { key: 'same', value: false })];
  await initializeWorkers(workers);
  workers[0].send('go');
  assert.equal((await workers[0].take()).ok, true);
  const before = bytes(scope.dir);
  workers[1].send('go');
  const rejected = await workers[1].take();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'STATE_CONFLICT');
  assert.equal(rejected.error.safe, true);
  await Promise.all(workers.map(child => child.exited));
  assert.equal(bytes(scope.dir), before);
  assert.deepEqual(persisted(scope.dir).managed, { same: true });
});

test('independent processes backing up at the same timestamp cannot replace each other', async t => {
  const scope = temporary(t);
  const inputs = ['first', 'second'].map(name => {
    const path = join(scope.dir, `${name}-fixture-settings.yaml`);
    const contents = `${name}: keep this snapshot\n`;
    writeFileSync(path, contents);
    return { path, contents };
  });
  const workers = inputs.map(input => worker(scope, {
    backup: true,
    settingsFile: input.path,
    timestamp: '2026-01-02T03:04:05.006Z',
  }));
  await initializeWorkers(workers);
  for (const child of workers) child.send('go');
  const results = await Promise.all(workers.map(child => child.take()));
  for (const result of results) { assert.equal(result.event, 'result'); assert.equal(result.ok, true); }
  await Promise.all(workers.map(child => child.exited));
  assert.equal(new Set(results.map(result => result.target)).size, 2);
  for (const [index, result] of results.entries()) {
    assert.match(basename(result.target), /^settings-2026-01-02T03-04-05-006Z-[a-f0-9]{32}\.yaml$/u);
    assert.equal(readFileSync(result.target, 'utf8'), inputs[index].contents);
    assert.equal(statSync(result.target).mode & 0o777, 0o600);
    assert.equal(readFileSync(inputs[index].path, 'utf8'), inputs[index].contents);
  }
});
