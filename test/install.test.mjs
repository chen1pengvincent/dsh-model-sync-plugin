/**
 * The installer has to write **four** references, not two.
 *
 * The failure this locks down is the one that actually happened here: the
 * manifest's `dependencies` was pointed at this checkout while
 * `pnpm.overrides` still named the previous release, and because overrides win,
 * the next `pnpm install` (triggered by installing any other plugin) would have
 * quietly restored the old plugin. The generation projection and the bundle
 * list have the same shape of failure.
 *
 * The last test runs the real script against a fake DSH home, so it also covers
 * the file operations: generation directory, both symlinks, and the promise
 * that re-running over our own ledger does not archive it.
 *
 * Run: node --test test/install.test.mjs
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PACKAGE, generationFiles, generationId, planInstall } from '../lib/install.js'
import { readRefs } from '../lib/rollback.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'install.mjs')
const source = '/work/dsh-model-gateway'

/** A profile that still has the previous release installed the old way. */
function withOldRelease() {
  return {
    name: 'desktop',
    dependencies: { 'billion-context': '^0.1.215', [PACKAGE]: '0.12.5' },
    pnpm: {
      overrides: {
        'billion-context': 'link:../.generations/live/billion-context+0.1.215',
        [PACKAGE]: `link:../.generations/live/${PACKAGE}+0.12.5+7d1b4f7c7895/node_modules/${PACKAGE}`,
      },
    },
    dsh: {
      profile: { bundles: ['billion-context', PACKAGE] },
      desktop: {
        generationProjection: {
          plugins: { [PACKAGE]: { generationId: `${PACKAGE}+0.12.5+7d1b4f7c7895`, visibleVersion: '0.12.5', previousOverride: { present: false } } },
        },
      },
    },
  }
}

test('the plan writes every reference the desktop reads', () => {
  const generation = generationId('1.0.0', source)
  const { next, changes } = planInstall({ manifest: withOldRelease(), source, version: '1.0.0', generation })
  const refs = readRefs(next)
  assert.equal(refs.dependency, `link:${source}`)
  assert.equal(refs.override, `link:${source}`)
  assert.equal(refs.bundled, true)
  assert.equal(refs.projection.generationId, generation)
  assert.equal(refs.projection.visibleVersion, '1.0.0')
  // A previous entry existed, so the desktop must remember that.
  assert.deepEqual(refs.projection.previousOverride, { present: true })
  assert.equal(changes.length >= 3, true)
  // The neighbour plugin is untouched: this is not a wholesale rewrite.
  assert.equal(next.dependencies['billion-context'], '^0.1.215')
  assert.deepEqual(next.pnpm.overrides['billion-context'], withOldRelease().pnpm.overrides['billion-context'])
})

test('a second run is a no-op, including the override flag inside the projection', () => {
  const generation = generationId('1.0.0', source)
  const first = planInstall({ manifest: withOldRelease(), source, version: '1.0.0', generation })
  const second = planInstall({ manifest: first.next, source, version: '1.0.0', generation })
  assert.deepEqual(second.changes, [])
  assert.deepEqual(second.next, first.next)
})

test('without a generation the projection is left alone, and that is a warning', () => {
  const { next, warnings } = planInstall({ manifest: withOldRelease(), source, version: '1.0.0', generation: undefined })
  assert.equal(readRefs(next).projection.generationId, `${PACKAGE}+0.12.5+7d1b4f7c7895`)
  assert.equal(warnings.some((line) => /generation/.test(line)), true)
})

test('the generation id is deterministic and namespaced', () => {
  assert.equal(generationId('1.0.0', source), generationId('1.0.0', source))
  assert.notEqual(generationId('1.0.0', source), generationId('1.0.1', source))
  assert.notEqual(generationId('1.0.0', source), generationId('1.0.0', '/elsewhere'))
  assert.match(generationId('1.0.0', source), /^dsh-model-sync\+1\.0\.0\+[0-9a-f]{12}$/)
})

test('the generation files describe the checkout, not a tarball', () => {
  const files = generationFiles({ source, version: '1.0.0' })
  const byPath = new Map(files.map((file) => [file.path, file.body]))
  const generation = JSON.parse(byPath.get('generation.json'))
  assert.deepEqual(generation, { pluginName: PACKAGE, version: '1.0.0', sourceSpec: source })
  const manifest = JSON.parse(byPath.get('package.json'))
  assert.equal(manifest.dependencies[PACKAGE], `file:${source}`)
})

test('the script installs over an old profile and leaves its ledger alone on a second run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-sync-install-'))
  const profile = join(home, 'profiles', 'desktop')
  const generations = join(home, 'profiles', '.generations', 'live')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(join(profile, 'model-sync'), { recursive: true })
  await writeFile(join(profile, 'model-sync', 'models.dev.json'), '{}\n')
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(withOldRelease(), null, 2)}\n`)
  // Point the script at this checkout: it reads the version from package.json.
  const checkout = join(here, '..')
  await symlink(checkout, join(profile, 'node_modules', PACKAGE), 'dir')

  const env = { ...process.env, DSH_HOME: home, DSH_NODE_EXECUTABLE: '/nonexistent', DSH_INSTALL_DIR: '/nonexistent' }
  try {
    const dry = await run(process.execPath, [script, '--profile', 'desktop'], { env })
    assert.match(dry.stdout, /Nothing was changed/)
    // The CLI is informational: a machine that cannot run it must still install.
    assert.match(dry.stdout, /not runnable here; not needed/)

    await run(process.execPath, [script, '--profile', 'desktop', '--apply'], { env })

    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    const refs = readRefs(manifest)
    assert.equal(refs.dependency, `link:${checkout}`)
    assert.equal(refs.override, `link:${checkout}`)
    assert.equal(refs.bundled, true)
    assert.match(refs.projection.generationId, new RegExp(`^${PACKAGE}\\+`))

    // The generation exists, carries both files, and points back at the checkout.
    const generation = join(generations, refs.projection.generationId)
    const info = JSON.parse(await readFile(join(generation, 'generation.json'), 'utf8'))
    assert.equal(info.sourceSpec, checkout)
    assert.equal(await readlink(join(generation, 'node_modules', PACKAGE)), checkout)
    assert.equal(await readlink(join(profile, 'node_modules', PACKAGE)), checkout)

    // The previous release's cache was moved aside rather than read.
    const names = await readdir(profile)
    assert.equal(names.some((name) => name.startsWith('model-sync.legacy-')), true)

    // Our own ledger, once it exists, must survive a re-install.
    await mkdir(join(profile, 'model-sync'), { recursive: true })
    await writeFile(join(profile, 'model-sync', 'state.json'), '{"version":1,"snapshots":3}\n')
    const again = await run(process.execPath, [script, '--profile', 'desktop', '--apply'], { env })
    assert.match(again.stdout, /state directory already belongs to this version; left in place/)
    assert.match(await readFile(join(profile, 'model-sync', 'state.json'), 'utf8'), /"snapshots":3/)

    // Re-running must not accumulate generation directories.
    const generationsAfter = (await readdir(generations)).filter((name) => name.startsWith(`${PACKAGE}+`))
    assert.equal(generationsAfter.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
