/**
 * The state file is the one thing that survives a restart, so it is also the one
 * thing an upgrade can hand the plugin in a shape it does not understand.
 *
 * 0.12.x wrote `{version: 3, catalogs, siblings, ownedModels, ...}` into the same
 * path. Reading half of that would invent a ledger this plugin never wrote, and
 * silently ignoring it would look like "the ledger is empty" with no explanation.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Store } from '../lib/state.js'

async function dir() {
  return await mkdtemp(join(tmpdir(), 'model-sync-state-'))
}

test('a fresh directory loads as an empty ledger', async () => {
  const path = await dir()
  try {
    const store = new Store(path)
    const data = await store.load()
    assert.equal(data.version, 1)
    assert.deepEqual(data.checks, {})
    assert.equal(store.rejected, undefined)
    // A missing file is a first run. Reporting it as a rejected state file put
    // a red problem row in front of every new install.
    assert.equal(data.notices, undefined)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})

test("this version's own file round-trips", async () => {
  const path = await dir()
  try {
    const first = new Store(path)
    await first.load()
    first.data.schedule = { enabled: false, hour: 21 }
    await first.save()

    const second = new Store(path)
    const data = await second.load()
    assert.deepEqual(data.schedule, { enabled: false, hour: 21 })
    assert.equal(second.rejected, undefined)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})

test('a state file from another version is archived, not half-read', async () => {
  const path = await dir()
  try {
    const legacy = {
      version: 3,
      catalogs: { cfg_abc: { ids: ['x'], models: {} } },
      siblings: { opencode: ['opencode-chat'] },
      ownedModels: { google: ['gemini-4-carbon'] },
      proxyEnabled: true,
    }
    await writeFile(join(path, 'state.json'), JSON.stringify(legacy), 'utf8')

    const store = new Store(path)
    const data = await store.load()

    // Nothing of the old ledger leaks in.
    assert.deepEqual(data.checks, {})
    assert.deepEqual(data.ownedModels ?? {}, {})
    assert.equal(store.rejected?.endsWith('.rejected-'), false)
    assert.match(String(store.rejected), /state\.json\.rejected-.*\.json$/)

    // The old bytes are still on disk, and the panel is told where they went.
    const archived = JSON.parse(await readFile(String(store.rejected), 'utf8'))
    assert.equal(archived.version, 3)
    assert.equal(data.notices?.[0]?.kind, 'state-version')
    assert.match(String(data.notices?.[0]?.detail), /archived as/)

    // state.json itself is gone until the next save writes a fresh one.
    const names = await readdir(path)
    assert.equal(names.includes('state.json'), false)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})

test('a corrupt state file is archived rather than silently overwritten', async () => {
  const path = await dir()
  try {
    const corrupt = '{ this is not json'
    await writeFile(join(path, 'state.json'), corrupt, 'utf8')
    const store = new Store(path)
    const data = await store.load()
    assert.equal(data.version, 1)
    assert.deepEqual(data.checks, {})
    // Unreadable bytes are still bytes someone might want back, so they are moved
    // aside like a foreign version instead of being replaced by the next save.
    assert.match(String(store.rejected), /state\.json\.rejected-.*\.json$/)
    assert.equal(await readFile(String(store.rejected), 'utf8'), corrupt)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})
