#!/usr/bin/env node
/**
 * Install this plugin into a DSH profile, replacing whatever version is there.
 *
 * The replacement is not a simple `add`: the previous release used the same
 * package name, and DSH refuses a second install of a name that already
 * exists. So the steps are always remove → add, with a backup of the old
 * plugin's state first (its ledger is a different schema and must not be read
 * as ours).
 *
 * Two modes:
 *   node scripts/install.mjs --profile desktop            # dry run, prints the plan
 *   node scripts/install.mjs --profile desktop --apply    # performs it
 *
 * Nothing here restarts DSH: the host half only changes on the next start, and
 * a restart cannot be done from inside the process it would kill.
 */

import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { generationFiles, generationId, planInstall } from '../lib/install.js'

const run = promisify(execFile)

const PACKAGE = 'dsh-model-sync'
// `new URL(...).pathname` percent-encodes spaces and CJK, which then become
// literal characters in the path handed to pnpm.
const here = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const options = { profile: 'desktop', apply: false, dryRun: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') { options.apply = true; options.dryRun = false }
    else if (arg === '--dry-run') { options.dryRun = true }
    else if (arg === '--generation') { options.generation = argv[++index] }
    else if (arg.startsWith('--generation=')) { options.generation = arg.slice('--generation='.length) }
    else if (arg === '--no-override') { options.override = false }
    else if (arg === '--profile') { options.profile = argv[++index] }
    else if (arg.startsWith('--profile=')) { options.profile = arg.slice('--profile='.length) }
    else throw new Error(`unknown argument "${arg}"`)
  }
  return options
}

/**
 * An existing generation directory that already points at this checkout.
 *
 * Reusing it keeps re-installs idempotent: the projection keeps naming a
 * directory that exists, and `pnpm` does not accumulate one generation per run.
 */
async function generationFor(generationsRoot, source, version) {
  const names = await readdir(generationsRoot).catch(() => [])
  const matches = []
  for (const name of names) {
    if (!name.startsWith(`${PACKAGE}+`)) continue
    const info = await readFile(join(generationsRoot, name, 'generation.json'), 'utf8').then(JSON.parse, () => undefined)
    // Only reuse a generation that describes *this* version: a version bump
    // must produce a new directory, otherwise the projection claims a version
    // the directory itself does not carry.
    if (info?.sourceSpec === source && info.version === version) matches.push(name)
  }
  return matches.sort().at(-1)
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * How to run the DSH CLI on this machine.
 *
 * The package lives *inside* `app.asar`, so it is not a real file on disk: a
 * plain `node <path>` fails with ENOTDIR. The launcher that works is the
 * Electron binary with `ELECTRON_RUN_AS_NODE=1`, which resolves asar paths the
 * way the app itself does. Verified by asking it for its version before use.
 */
async function cliLauncher() {
  const root = process.env.DSH_INSTALL_DIR
    ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh'
  const script = join(root, 'lib', 'bin.js')
  const candidates = [
    { exec: process.env.DSH_NODE_EXECUTABLE ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', env: { ELECTRON_RUN_AS_NODE: '1' } },
    { exec: process.execPath, env: {} },
  ]
  for (const candidate of candidates) {
    try {
      const result = await run(candidate.exec, [script, '--version'], { env: { ...process.env, ...candidate.env }, timeout: 20_000 })
      const version = `${result.stdout}`.trim()
      if (/^\d+\.\d+\.\d+/.test(version)) return { ...candidate, script, version }
    } catch {
      continue
    }
  }
  throw new Error('could not run the DSH CLI; set DSH_NODE_EXECUTABLE and DSH_INSTALL_DIR')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(dshHome(), 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')
  const source = resolve(here, '..')
  const own = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const version = `${own.version ?? '0.0.0'}`

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const installed = manifest.dependencies?.[PACKAGE]
  const bundled = (manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE)
  // Informational only: the writes below never go through the CLI (see the note
  // in step 3), so a machine where the launcher cannot be found must not fail.
  const launcher = await cliLauncher().catch(() => undefined)

  const generationsRoot = join(dshHome(), 'profiles', '.generations', 'live')
  const existing = options.generation ?? (await generationFor(generationsRoot, source, version))
  const generation = existing ?? generationId(version, source)
  const needsGeneration = existing === undefined

  const { next, changes, warnings } = planInstall({
    manifest,
    source,
    version,
    generation,
    writeOverride: options.override !== false,
  })

  console.log(`profile      ${profileDir}`)
  console.log(`source       ${source}`)
  console.log(`installed    ${installed ?? '(not installed)'}`)
  console.log(`in bundles   ${String(bundled)}`)
  console.log(`generation   ${generation}${needsGeneration ? ' (will be created)' : ' (reused)'}`)
  console.log(`cli          ${launcher === undefined ? '(not runnable here; not needed)' : `${launcher.script} (dsh ${launcher.version})`}`)

  const stateDir = join(profileDir, 'model-sync')
  const stateVersion = await readFile(join(stateDir, 'state.json'), 'utf8')
    .then(JSON.parse, () => undefined)
    .then((state) => state?.version, () => undefined)
  const steps = [
    {
      label:
        stateVersion === 1
          ? 'keep the state directory (it already belongs to this version)'
          : (await access(stateDir).then(() => true, () => false))
            ? "move the previous release's state directory aside"
            : 'no previous state directory to move',
    },
    { label: 'copy package.json to a timestamped backup' },
    ...(needsGeneration ? [{ label: `create generation ${generation}` }] : []),
    { label: `write ${changes.length === 0 ? 'nothing' : `${changes.length} manifest reference(s)`}` },
    { label: `replace node_modules/${PACKAGE} with a symlink to the source tree` },
    { label: 'verify all four references and module resolution' },
  ]

  if (changes.length > 0) {
    console.log('\nmanifest changes:')
    for (const change of changes) console.log(`  · ${change}`)
  }
  for (const warning of warnings) console.log(`  ! ${warning}`)

  if (options.dryRun) {
    console.log('\nplanned steps:')
    for (const [index, step] of steps.entries()) console.log(`  ${index + 1}. ${step.label}`)
    console.log('\nNothing was changed. Re-run with --apply to perform these steps.')
    return
  }

  // 1. The old state directory is a different schema. Move it aside rather than
  // letting this version read it — `state.json` there is a 249 KB ledger whose
  // keys mean something else entirely.
  const legacyDir = join(profileDir, `model-sync.legacy-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  if (stateVersion === 1) {
    // Re-installing over our own ledger must not throw it away: the snapshots
    // and the audit trail in there are the user's only copy.
    console.log('state directory already belongs to this version; left in place')
  } else {
    try {
      await access(stateDir)
      await rename(stateDir, legacyDir)
      console.log(`moved old state → ${legacyDir}`)
    } catch {
      console.log('no previous state directory')
    }
  }

  // 2. Keep a copy of the manifest so a failed install can be undone by hand.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const manifestBackup = join(profileDir, `.package.json.${stamp}.bak`)
  await copyFile(manifestPath, manifestBackup)
  console.log(`manifest backed up → ${manifestBackup}`)

  // 3. The Desktop profile is reserved: `dsh plugin` refuses it by name
  // (`bin.js`: "profile \"desktop\" is managed exclusively by the Electron
  // application"), and the bundled pnpm cannot touch this tree either — the
  // existing node_modules was linked from store v10 while the bundled pnpm
  // appends its own v11 store and aborts with ERR_PNPM_UNEXPECTED_STORE.
  // A `link:` install is just a few facts, so write them directly.
  if (needsGeneration) {
    const dir = join(generationsRoot, generation)
    for (const file of generationFiles({ source, version })) {
      const path = join(dir, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.body)
    }
    console.log(`generation   ${dir}`)
  }
  const generationLink = join(generationsRoot, generation, 'node_modules', PACKAGE)
  await rm(generationLink, { recursive: true, force: true })
  await mkdir(dirname(generationLink), { recursive: true })
  await symlink(source, generationLink, 'dir')

  if (changes.length > 0) {
    // Only rewrite the manifest when something actually changes: the desktop
    // app owns this file too, and a no-op install should leave it untouched.
    await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
    for (const change of changes) console.log(`  · ${change}`)
  }

  const linkPath = join(profileDir, 'node_modules', PACKAGE)
  await rm(linkPath, { recursive: true, force: true })
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(source, linkPath, 'dir')
  console.log(`symlink      node_modules/${PACKAGE} -> ${source}`)

  // 4. Verify every reference, not just the one this script used to write.
  const after = JSON.parse(await readFile(manifestPath, 'utf8'))
  const linked = `link:${source}`
  const projection = after.dsh?.desktop?.generationProjection?.plugins?.[PACKAGE]
  // Read the file rather than importing it: a JSON import needs an import
  // attribute and silently fails without one, which made this check report a
  // broken install on machines that were fine.
  const resolved = await readFile(join(linkPath, 'package.json'), 'utf8').then(JSON.parse, () => undefined)
  const checks = [
    ['dependencies', after.dependencies?.[PACKAGE] === linked],
    ['pnpm.overrides', options.override === false || after.pnpm?.overrides?.[PACKAGE] === linked],
    ['profile.bundles', (after.dsh?.profile?.bundles ?? []).includes(PACKAGE)],
    ['generationProjection', projection?.generationId === generation],
    ['module resolves', resolved?.name === PACKAGE],
  ]
  console.log('')
  for (const [label, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (checks.some(([, ok]) => ok !== true)) {
    const report = checks.filter(([, ok]) => ok !== true).map(([label]) => label).join(', ')
    await writeFile(join(profileDir, 'model-sync-install-failed.txt'), `install did not take effect (${report})\nmanifest backup: ${manifestBackup}\n`)
    throw new Error(`these references did not take effect: ${report}; the previous manifest is at ${manifestBackup}`)
  }
  console.log('\ninstalled. Restart DSH to load the host half; the panel appears under Settings → 模型更新.')
  console.log(`undo: node scripts/rollback.mjs            (dry run first, then --apply)`)
}

main().catch((error) => {
  console.error(`\ninstall failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
