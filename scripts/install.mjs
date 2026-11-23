#!/usr/bin/env node
/**
 * Install this plugin into a DSH profile, replacing whatever version is there.
 *
 * Prepare the new generation before switching the profile references. The
 * pending directory holds the old link and manifest until verification.
 *
 * Two modes:
 *   node scripts/install.mjs --profile desktop            # dry run, prints the plan
 *   node scripts/install.mjs --profile desktop --apply    # performs it
 *
 * Nothing here restarts DSH: the host half only changes on the next start, and
 * a restart cannot be done from inside the process it would kill.
 */

import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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
  if (!/^[a-zA-Z0-9][\w-]*$/.test(options.profile)) throw new Error('invalid profile')
  if (options.generation !== undefined && !/^dsh-model-sync\+[\w.+-]+$/.test(options.generation)) {
    throw new Error('invalid generation name')
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
    const info = await readFile(join(generationsRoot, name, 'generation.json'), 'utf8').then(JSON.parse).catch(() => undefined)
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

async function entryAt(path) {
  return lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
}

async function pointsTo(path, source) {
  return (await entryAt(path))?.isSymbolicLink() === true &&
    resolve(dirname(path), await readlink(path)) === source
}

async function prepareGeneration(root, generation, source, version, create) {
  const directory = join(root, generation)
  if (create && !await entryAt(directory)) {
    await mkdir(root, { recursive: true })
    const staged = await mkdtemp(join(root, '.model-sync-generation-'))
    try {
      for (const file of generationFiles({ source, version })) await writeFile(join(staged, file.path), file.body)
      await mkdir(join(staged, 'node_modules'))
      await symlink(source, join(staged, 'node_modules', PACKAGE), 'dir')
      await rename(staged, directory).catch((error) => {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      })
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  }
  const info = JSON.parse(await readFile(join(directory, 'generation.json'), 'utf8'))
  const link = join(directory, 'node_modules', PACKAGE)
  if (info.pluginName !== PACKAGE || info.sourceSpec !== source || info.version !== version || !await pointsTo(link, source)) {
    throw new Error('generation does not match the requested source and version')
  }
}

async function finishTransaction(pending) {
  const completed = `${pending}-${process.pid}-${Date.now()}`
  await rename(pending, completed)
  await rm(completed, { recursive: true, force: true }).catch(() => undefined)
}

async function recoverTransaction(pending, profileDir, plan) {
  if (await entryAt(join(pending, 'committed'))) {
    await finishTransaction(pending)
    return
  }
  const manifest = join(profileDir, 'package.json')
  const oldManifest = await readFile(join(pending, 'old-manifest'))
  const newManifest = await readFile(join(pending, 'new-manifest'))
  const current = await readFile(manifest)
  const replaced = !await entryAt(join(pending, 'replacement-manifest'))
  if (replaced && !current.equals(oldManifest) && !current.equals(newManifest)) {
    throw new Error(`profile manifest changed during installation; review the backup in ${pending}`)
  }

  const backupLink = join(pending, 'old-link')
  const liveLink = join(profileDir, 'node_modules', PACKAGE)
  if (await entryAt(backupLink)) {
    if (await entryAt(liveLink)) {
      if (!await pointsTo(liveLink, plan.source)) throw new Error('profile module link changed during installation')
      await unlink(liveLink)
    }
    await rename(backupLink, liveLink)
  } else if (!plan.hadLink && !await entryAt(join(pending, 'new-link')) && await entryAt(liveLink)) {
    if (!await pointsTo(liveLink, plan.source)) throw new Error('profile module link changed during installation')
    await unlink(liveLink)
  }

  if (plan.archive) {
    const archive = join(profileDir, plan.archive)
    if (await entryAt(archive)) {
      if (await entryAt(join(profileDir, 'model-sync'))) throw new Error('profile state changed during installation')
      await rename(archive, join(profileDir, 'model-sync'))
    }
  }

  if (replaced && !current.equals(oldManifest)) {
    const restore = join(pending, 'restore-manifest')
    await copyFile(join(pending, 'old-manifest'), restore)
    if (!(await readFile(manifest)).equals(current)) throw new Error('profile manifest changed during recovery')
    await rename(restore, manifest)
  }
  await finishTransaction(pending)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(dshHome(), 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')
  const pending = join(profileDir, '.model-sync-install-pending')
  if (await entryAt(pending)) {
    if (options.dryRun) {
      console.log('An unfinished install exists. Applying the install will recover it before making any changes.')
      return
    }
    const previous = JSON.parse(await readFile(join(pending, 'plan.json'), 'utf8'))
    let running = true
    try {
      process.kill(previous.pid, 0)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      running = false
    }
    if (running) throw new Error('another install is still running for this profile')
    await recoverTransaction(pending, profileDir, previous)
    console.log('recovered the unfinished install')
  }
  const source = await realpath(resolve(here, '..'))
  const own = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const version = `${own.version ?? '0.0.0'}`

  const originalManifest = await readFile(manifestPath)
  const manifest = JSON.parse(originalManifest)
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
  const stateVersion = await readFile(join(stateDir, 'state.json'), 'utf8').then(JSON.parse).then((state) => state?.version).catch((error) => {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  })
  const archiveState = stateVersion !== 1 && await entryAt(stateDir) !== undefined
  const steps = [
    {
      label:
        stateVersion === 1
          ? 'keep the state directory (it already belongs to this version)'
          : archiveState
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

  if (own.name !== PACKAGE) throw new Error('the source manifest does not describe dsh-model-sync')
  if (stateVersion === 1) console.log('state directory already belongs to this version; left in place')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const manifestBackup = join(profileDir, `.package.json.${stamp}.bak`)
  const linkPath = join(profileDir, 'node_modules', PACKAGE)
  await mkdir(dirname(linkPath), { recursive: true })
  await prepareGeneration(generationsRoot, generation, source, version, needsGeneration)

  const plan = {
    pid: process.pid, source, hadLink: await entryAt(linkPath) !== undefined,
    archive: archiveState ? `model-sync.legacy-${stamp}` : undefined,
  }
  const newManifest = changes.length ? Buffer.from(`${JSON.stringify(next, null, 2)}\n`) : originalManifest
  const staged = await mkdtemp(join(profileDir, '.model-sync-install-stage-'))
  const mode = (await lstat(manifestPath)).mode & 0o777
  try {
    await writeFile(join(staged, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
    await writeFile(join(staged, 'old-manifest'), originalManifest, { mode })
    await writeFile(join(staged, 'new-manifest'), newManifest, { mode })
    await writeFile(join(staged, 'replacement-manifest'), newManifest, { mode })
    await symlink(source, join(staged, 'new-link'), 'dir')
    await rename(staged, pending)
  } finally {
    await rm(staged, { recursive: true, force: true })
  }

  let interrupted = false
  const interrupt = () => { interrupted = true }
  const checkInterrupted = () => { if (interrupted) throw new Error('installation interrupted') }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    checkInterrupted()
    if (!(await readFile(manifestPath)).equals(originalManifest)) throw new Error('profile manifest changed; run the install again')
    await copyFile(join(pending, 'old-manifest'), manifestBackup)
    console.log(`manifest backed up → ${manifestBackup}`)
    if (plan.archive) await rename(stateDir, join(profileDir, plan.archive))
    checkInterrupted()
    if (plan.hadLink) await rename(linkPath, join(pending, 'old-link'))
    await rename(join(pending, 'new-link'), linkPath)
    checkInterrupted()
    if (!(await readFile(manifestPath)).equals(originalManifest)) throw new Error('profile manifest changed; run the install again')
    if (changes.length) await rename(join(pending, 'replacement-manifest'), manifestPath)

    const after = JSON.parse(await readFile(manifestPath, 'utf8'))
    const linked = `link:${source}`
    const projection = after.dsh?.desktop?.generationProjection?.plugins?.[PACKAGE]
    const resolved = JSON.parse(await readFile(join(linkPath, 'package.json'), 'utf8'))
    const checks = [
      ['dependencies', after.dependencies?.[PACKAGE] === linked],
      ['pnpm.overrides', options.override === false || after.pnpm?.overrides?.[PACKAGE] === linked],
      ['profile.bundles', (after.dsh?.profile?.bundles ?? []).includes(PACKAGE)],
      ['generationProjection', projection?.generationId === generation && projection.visibleVersion === version],
      ['module resolves', resolved.name === PACKAGE && resolved.version === version && await pointsTo(linkPath, source)],
    ]
    for (const [label, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${label}`)
    if (checks.some(([, ok]) => !ok)) throw new Error('the new profile references did not verify')
    checkInterrupted()
    await writeFile(join(pending, 'committed'), '')
  } catch (error) {
    try {
      await recoverTransaction(pending, profileDir, plan)
    } catch (restoreError) {
      throw new Error(`${error.message}; could not complete recovery: ${restoreError.message} (${pending})`)
    }
    throw error
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
  await finishTransaction(pending)
  console.log('\ninstalled. Restart DSH to load the host half; the panel appears under Settings → 模型管理.')
  console.log(`undo: node scripts/rollback.mjs            (dry run first, then --apply)`)
}

main().catch((error) => {
  console.error(`\ninstall failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
