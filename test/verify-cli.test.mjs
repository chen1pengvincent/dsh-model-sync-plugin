/**
 * The terminal half of the self-check, run the way the user runs it.
 *
 * `lib/verify.js` is covered by pure-function tests, but the script is what the
 * acceptance list tells the user to run — and the first thing they run is on a
 * machine whose profile already has the four references written by
 * `scripts/install.mjs`. A criterion that only passes because of this author's
 * own home directory would be worthless, so this test builds a throwaway
 * `DSH_HOME` whose manifest points at *this* checkout and asserts both the
 * clean and the broken outcome.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = 'dsh-model-sync'
const GENERATION = 'dsh-model-sync+1.0.0+0ccf72b04dc5'

/** A profile shaped exactly like the one `scripts/install.mjs --apply` leaves. */
function manifest(options = {}) {
  return {
    name: 'dsh-profile-desktop',
    dependencies: { [PACKAGE]: `link:${ROOT}` },
    pnpm: { overrides: { [PACKAGE]: `link:${ROOT}` } },
    dsh: {
      profile: { bundles: options.bundles === false ? [] : [PACKAGE] },
      desktop: { generationProjection: { plugins: { [PACKAGE]: { generationId: GENERATION, visibleVersion: '1.0.0', previousOverride: { present: false } } } } },
    },
  }
}

/** @param {object} [options] */
async function home(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-verify-'))
  const profile = join(dir, 'profiles', 'desktop')
  await mkdir(join(profile, 'model-sync'), { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest(options), undefined, 2)}\n`, 'utf8')
  if (options.state !== false) {
    await writeFile(join(profile, 'model-sync', 'state.json'), `${JSON.stringify({
      version: 1,
      proxy: { enabled: true },
      schedule: { enabled: true, hour: 9 },
      bili: { enabled: true, written: [] },
      gateway: { enabled: false, entries: {} },
      selfCheck: { at: '2026-11-16T10:50:00.000Z', ok: true, failures: [], warnings: [] },
    }, undefined, 2)}\n`, 'utf8')
  }
  return dir
}

/** @param {string} dir @param {object} [extra] */
async function verify(dir, extra = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(ROOT, 'scripts', 'verify.mjs'), '--profile', 'desktop'], {
      env: { ...process.env, DSH_HOME: dir, ...extra },
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (error) {
    return { code: /** @type {any} */ (error).code ?? 1, out: `${/** @type {any} */ (error).stdout ?? ''}${/** @type {any} */ (error).stderr ?? ''}` }
  }
}

test('an installed profile passes, and the verdict names the generation it found', async () => {
  const dir = await home()
  try {
    const result = await verify(dir)
    assert.equal(result.code, 0, result.out)
    assert.ok(result.out.includes('✅'), result.out)
    assert.ok(result.out.includes(GENERATION), 'the verdict has to say which generation is installed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a bundle list that lost the package fails with the reference named', async () => {
  const dir = await home({ bundles: false })
  try {
    const result = await verify(dir)
    assert.equal(result.code, 1, result.out)
    assert.ok(result.out.includes('❌'), result.out)
    assert.ok(result.out.includes('bundles'), result.out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a profile that was never booted says so instead of failing', async () => {
  // This is the state the machine is in between `--apply` and the first restart:
  // the install is complete and the ledger does not exist yet. It is a note, not
  // a problem — telling the user their install is broken here would send them
  // hunting for a fault that is just "not restarted yet".
  const dir = await home({ state: false })
  try {
    const result = await verify(dir)
    assert.equal(result.code, 0, result.out)
    assert.ok(result.out.includes('还没有 state.json'), result.out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing profile is an inspection failure, not a clean bill of health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-verify-empty-'))
  try {
    const result = await verify(dir)
    assert.equal(result.code, 2, result.out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
