/**
 * The rollback has to be surgical and it has to be *reversible*.
 *
 * Two failure modes are worth locking down here, both found by reading a dry
 * run instead of trusting the code:
 *
 *  1. Restoring the manifest wholesale would delete every plugin installed
 *     after the backup. So the plan touches three references and nothing else.
 *  2. The backup's override is `link:../.generations/live/<old>`. Removing the
 *     symlink without recreating it — or deleting the old generation because it
 *     matched the package name — leaves the profile unable to load anything.
 *
 * Run: node --test test/rollback.test.mjs
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  PACKAGE,
  generationDirs,
  generationsReferencedBy,
  isBackupName,
  looksLikeThisInstall,
  pickBackup,
  planRevert,
  readRefs,
  stateDirs,
} from '../lib/rollback.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'rollback.mjs')

const OLD_GENERATION = `${PACKAGE}+0.12.5+7d1b4f7c7895`
const NEW_GENERATION = `${PACKAGE}+1.0.0+0ccf72b04dc5`

/** The profile as this plugin's installer left it. */
function installed() {
  return {
    name: 'desktop',
    dependencies: { 'billion-context': '^0.1.215', [PACKAGE]: 'link:/work/dsh-model-gateway' },
    pnpm: { overrides: { 'billion-context': 'link:../.generations/live/billion-context+0.1.215', [PACKAGE]: 'link:/work/dsh-model-gateway' } },
    dsh: {
      profile: { bundles: ['billion-context', PACKAGE] },
      desktop: {
        generationProjection: {
          plugins: {
            'billion-context': { generationId: 'billion-context+0.1.215', visibleVersion: '0.1.215' },
            [PACKAGE]: { generationId: NEW_GENERATION, visibleVersion: '1.0.0', previousOverride: { present: false } },
          },
        },
      },
    },
  }
}

/** The same profile before this plugin existed. */
function previous() {
  return {
    name: 'desktop',
    dependencies: { 'billion-context': '^0.1.215', [PACKAGE]: '0.12.5' },
    pnpm: {
      overrides: {
        'billion-context': 'link:../.generations/live/billion-context+0.1.215',
        [PACKAGE]: `link:../.generations/live/${OLD_GENERATION}/node_modules/${PACKAGE}`,
      },
    },
    dsh: {
      profile: { bundles: ['billion-context', PACKAGE] },
      desktop: {
        generationProjection: {
          plugins: {
            'billion-context': { generationId: 'billion-context+0.1.215', visibleVersion: '0.1.215' },
            [PACKAGE]: { generationId: OLD_GENERATION, visibleVersion: '0.12.5', previousOverride: { present: false } },
          },
        },
      },
    },
  }
}

test('the revert restores the three references and leaves other plugins alone', () => {
  const { next, changes } = planRevert({ manifest: installed(), backup: previous() })
  assert.equal(next.dependencies[PACKAGE], '0.12.5')
  assert.match(next.pnpm.overrides[PACKAGE], /0\.12\.5/)
  assert.equal(next.dsh.desktop.generationProjection.plugins[PACKAGE].generationId, OLD_GENERATION)
  // The neighbour must be byte-identical: the whole reason this is surgical.
  assert.equal(next.dependencies['billion-context'], '^0.1.215')
  assert.deepEqual(next.pnpm.overrides['billion-context'], previous().pnpm.overrides['billion-context'])
  assert.deepEqual(next.dsh.desktop.generationProjection.plugins['billion-context'], previous().dsh.desktop.generationProjection.plugins['billion-context'])
  assert.equal(changes.length >= 3, true)
})

test('without a backup every reference is removed, and the plan says so', () => {
  const { next, warnings } = planRevert({ manifest: installed(), backup: undefined })
  assert.equal(next.dependencies[PACKAGE], undefined)
  assert.equal(next.pnpm?.overrides?.[PACKAGE], undefined)
  assert.equal(next.dsh.desktop.generationProjection?.plugins?.[PACKAGE], undefined)
  // Other keys survive even in this mode.
  assert.equal(next.dependencies['billion-context'], '^0.1.215')
  assert.deepEqual(next.dsh.profile.bundles, ['billion-context'])
  assert.equal(warnings.some((line) => /no backup/.test(line)), true)
})

test('a bundle row the backup never had is dropped, one it had is kept', () => {
  const withRow = planRevert({ manifest: installed(), backup: { ...previous(), dsh: { profile: { bundles: ['billion-context'] } } } })
  assert.deepEqual(withRow.next.dsh.profile.bundles, ['billion-context'])

  const keepRow = planRevert({ manifest: installed(), backup: previous() })
  assert.deepEqual(keepRow.next.dsh.profile.bundles, ['billion-context', PACKAGE])
})

test('generations the reverted manifest still points at are never removed', () => {
  const names = [NEW_GENERATION, OLD_GENERATION, 'billion-context+0.1.215']
  assert.deepEqual(generationDirs(names), [NEW_GENERATION, OLD_GENERATION])
  // This is the load-bearing case: the restored override links into the old
  // generation, so deleting it would break the install the rollback restores.
  assert.deepEqual(generationDirs(names, [OLD_GENERATION]), [NEW_GENERATION])
  assert.deepEqual(generationDirs(names, [OLD_GENERATION, NEW_GENERATION]), [])
})

test('both reference shapes are recognised when deciding what to keep', () => {
  const found = generationsReferencedBy(previous())
  assert.equal(found.has(OLD_GENERATION), true)
  // `link:/work/dsh-model-gateway` is a path, not a generation, and must not match.
  assert.equal([...found].some((name) => name.endsWith('/dsh-model-gateway')), false)
  assert.equal(generationsReferencedBy({}).size, 0)
})

test('state directories are classified, not guessed', () => {
  const dirs = stateDirs(['model-sync', 'model-sync.legacy-2026-11-15T16-22-21-737Z', 'model-sync.v2-2026-11-16', 'other'])
  assert.deepEqual(dirs.live, ['model-sync'])
  assert.deepEqual(dirs.legacy, ['model-sync.legacy-2026-11-15T16-22-21-737Z'])
  assert.deepEqual(dirs.archived, ['model-sync.v2-2026-11-16'])
})

test('both backup naming schemes count, and near-misses do not', () => {
  assert.equal(isBackupName('.package.json.2026-11-15T16-22-21-739Z.bak'), true)
  assert.equal(isBackupName('package.json.bak-20261116T071315'), true)
  assert.equal(isBackupName('package.json'), false)
  assert.equal(isBackupName('package.jsonx.bak'), false)
  assert.equal(isBackupName('.package.json.bak'), true)
})

test('a backup taken mid-install is never the revert target', () => {
  // The 07:13 backup on this machine: dependencies already points at the
  // checkout, override and projection still name 0.12.5. Reverting to it would
  // recreate the mixed-reference state — the bug, not the fix.
  const partial = {
    name: 'package.json.bak-20261116T071315',
    manifest: {
      ...previous(),
      dependencies: { 'billion-context': '^0.1.215', [PACKAGE]: 'link:/work/dsh-model-gateway' },
      pnpm: { overrides: previous().pnpm.overrides },
    },
  }
  const clean = { name: '.package.json.2026-11-15T16-22-21-739Z.bak', manifest: previous() }
  assert.equal(looksLikeThisInstall(readRefs(partial.manifest)), true)
  assert.equal(looksLikeThisInstall(readRefs(clean.manifest)), false)

  // Newest first, as the CLI lists them.
  const { chosen, warning } = pickBackup([partial, clean], readRefs(installed()))
  assert.equal(chosen, clean)
  assert.match(warning, /mid-install/)

  // With nothing else available, refuse rather than hand back a partial state.
  const only = pickBackup([partial], readRefs(installed()))
  assert.equal(only.chosen, undefined)
  assert.match(only.warning, /mid-install/)
})

test('a backup identical to the current references is reported as a no-op', () => {
  const current = installed()
  const { chosen, warning } = pickBackup([{ name: 'x', manifest: current }], readRefs(current))
  assert.equal(chosen.name, 'x')
  assert.match(warning, /change nothing/)
})


test('--restore-state archives the v2 ledger instead of deleting it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-sync-state-'))
  const profile = join(home, 'profiles', 'desktop')
  const generations = join(home, 'profiles', '.generations', 'live')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(join(profile, 'model-sync'), { recursive: true })
  await writeFile(join(profile, 'model-sync', 'state.json'), '{"version":1,"v2":true}\n')
  const legacy = 'model-sync.legacy-2026-11-15T16-22-21-737Z'
  await mkdir(join(profile, legacy), { recursive: true })
  await writeFile(join(profile, legacy, 'state.json'), '{"version":3,"v1":true}\n')
  await mkdir(generations, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(installed(), null, 2)}\n`)
  await writeFile(join(profile, 'package.json.bak-20261116T071315.test'), `${JSON.stringify(previous(), null, 2)}\n`)

  const env = { ...process.env, DSH_HOME: home }
  try {
    await run(process.execPath, [script, '--profile', 'desktop', '--apply', '--restore-state'], { env })
    // The old ledger is back in place...
    const restored = await readFile(join(profile, 'model-sync', 'state.json'), 'utf8')
    assert.match(restored, /"v1":true/)
    // ...and the v2 one was archived rather than dropped, so it can be read later.
    const archived = (await readdir(profile)).filter((name) => name.startsWith('model-sync.v2-'))
    assert.equal(archived.length, 1)
    assert.match(await readFile(join(profile, archived[0], 'state.json'), 'utf8'), /"v2":true/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the CLI really reverts a profile tree, and keeps what it must keep', async () => {
  // A whole fake DSH home: the script only follows DSH_HOME, so this exercises
  // the real file operations without touching the machine's profile.
  const home = await mkdtemp(join(tmpdir(), 'model-sync-rollback-'))
  const profile = join(home, 'profiles', 'desktop')
  const generations = join(home, 'profiles', '.generations', 'live')
  const oldGeneration = join(generations, OLD_GENERATION, 'node_modules', PACKAGE)
  const ourGeneration = join(generations, NEW_GENERATION)
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(oldGeneration, { recursive: true })
  await mkdir(ourGeneration, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(installed(), null, 2)}\n`)
  await symlink('/work/dsh-model-gateway', join(profile, 'node_modules', PACKAGE), 'dir')
  // `previous()` is the backup the installer left behind.
  await writeFile(join(profile, '.package.json.2026-11-15T16-22-21-739Z.bak'), `${JSON.stringify(previous(), null, 2)}\n`)

  const env = { ...process.env, DSH_HOME: home }
  try {
    const dry = await run(process.execPath, [script, '--profile', 'desktop'], { env })
    assert.match(dry.stdout, /Nothing was changed/)
    assert.equal(dry.stdout.includes(`${NEW_GENERATION}: removed`), true)
    assert.equal(dry.stdout.includes(`${OLD_GENERATION}: removed`), false)

    await run(process.execPath, [script, '--profile', 'desktop', '--apply'], { env })

    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies[PACKAGE], '0.12.5')
    assert.equal(manifest.dsh.desktop.generationProjection.plugins[PACKAGE].generationId, OLD_GENERATION)

    // The old link is back, pointing where the restored override says.
    const link = await readlink(join(profile, 'node_modules', PACKAGE))
    assert.equal(link, oldGeneration)

    // Ours is gone; the one the override needs is not.
    assert.equal(await stat(ourGeneration).then(() => 'present', () => 'gone'), 'gone')
    assert.equal(await stat(oldGeneration).then(() => 'present', () => 'gone'), 'present')

    // The rollback is itself reversible: the manifest as it was is on disk.
    const names = await readdir(profile)
    const preRollback = names.find((name) => name.startsWith('.package.json.pre-rollback-'))
    assert.notEqual(preRollback, undefined, 'the rollback must leave its own undo file')
    const saved = await readFile(join(profile, preRollback), 'utf8')
    assert.match(saved, /dsh-model-gateway/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
