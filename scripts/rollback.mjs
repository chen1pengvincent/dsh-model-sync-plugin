#!/usr/bin/env node
/**
 * Undo this plugin's install in a profile.
 *
 *   node scripts/rollback.mjs                       # dry run: prints exactly what would change
 *   node scripts/rollback.mjs --apply               # does it (needs a DSH restart afterwards)
 *   node scripts/rollback.mjs --restore-state       # also puts the previous release's state dir back
 *   node scripts/rollback.mjs --backup <file>       # use a specific manifest backup
 *
 * The install is three references in the profile's `package.json` plus one
 * symlink, so the rollback puts those three back the way the backup has them
 * and removes the symlink. It does **not** restore the backup wholesale: this
 * profile has other plugins installed after that backup was taken, and a
 * wholesale restore would quietly delete them.
 *
 * What it cannot undo: the `models` arrays this plugin wrote through the
 * settings service (they live in the profile's configuration, not here). Use
 * the panel's 「恢复适配器默认目录」 per route, or the snapshots under
 * `model-sync/snapshots/`. The script prints that reminder instead of
 * pretending a rollback is complete.
 *
 * Nothing here restarts DSH: the host half is an in-process module, so the old
 * code is still running until the next start.
 */

import { copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { PACKAGE, generationDirs, generationsReferencedBy, isBackupName, pickBackup, planRevert, readRefs, stateDirs } from '../lib/rollback.js'


function parseArgs(argv) {
  const options = { profile: 'desktop', apply: false, restoreState: false, backup: undefined, stateFrom: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.apply = false
    else if (arg === '--restore-state') options.restoreState = true
    else if (arg === '--profile') options.profile = argv[++index]
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--backup') options.backup = argv[++index]
    else if (arg.startsWith('--backup=')) options.backup = arg.slice('--backup='.length)
    else if (arg === '--state-from') options.stateFrom = argv[++index]
    else if (arg.startsWith('--state-from=')) options.stateFrom = arg.slice('--state-from='.length)
    else throw new Error(`unknown argument "${arg}"`)
  }
  return options
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Manifest backups, newest first. Both naming schemes appear in this profile. */
async function backupsIn(profileDir) {
  const names = await readdir(profileDir).catch(() => [])
  const candidates = []
  for (const name of names) {
    if (!isBackupName(name)) continue
    const path = join(profileDir, name)
    const info = await lstat(path).catch(() => undefined)
    if (info?.isFile() !== true) continue
    // Parse now: a backup that does not parse cannot be a revert target, and
    // failing here beats writing a half-restored manifest later.
    const manifest = await readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)
    if (manifest === undefined) continue
    candidates.push({ path, name, mtime: info.mtimeMs, manifest })
  }
  return candidates.sort((left, right) => right.mtime - left.mtime)
}

/**
 * Where `node_modules/<package>` should point after the revert.
 *
 * Before this plugin was installed the override was already a `link:` into the
 * old generation, so the previous state had a symlink there. Removing ours and
 * leaving nothing would mean the app cannot load anything until a reinstall —
 * the rollback has to put the old link back, not just delete.
 */
function wantedLink(manifest, profileDir) {
  const spec = manifest?.pnpm?.overrides?.[PACKAGE] ?? manifest?.dependencies?.[PACKAGE]
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return undefined
  return resolve(profileDir, spec.slice('link:'.length))
}

/**
 * What sits at `node_modules/<package>`, if anything.
 *
 * `lstat`, not `stat`: a symlink whose source tree has been deleted still has
 * to be recognised as a symlink. Following it would report "absent" and leave
 * a dead link behind the rollback.
 */
async function linkTarget(linkPath) {
  const info = await lstat(linkPath).catch(() => undefined)
  if (info === undefined) return undefined
  if (info.isSymbolicLink()) return (await readlink(linkPath).catch(() => undefined)) ?? '(an unreadable symlink)'
  return info.isDirectory() ? '(a real directory, not a symlink)' : '(a file)'
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(dshHome(), 'profiles', options.profile)
  const manifestPath = join(profileDir, 'package.json')

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const refs = readRefs(manifest)
  const backups = await backupsIn(profileDir)
  const { chosen, warning } = pickBackup(backups, refs)
  const backupPath = options.backup ?? chosen?.path
  const backup = options.backup === undefined
    ? chosen?.manifest
    : await readFile(options.backup, 'utf8').then(JSON.parse).catch(() => undefined)

  const linkPath = join(profileDir, 'node_modules', PACKAGE)
  const target = await linkTarget(linkPath)

  const generationsRoot = join(dshHome(), 'profiles', '.generations', 'live')
  const { next, changes, warnings } = planRevert({ manifest, backup })
  // Only generations the *reverted* manifest no longer points at may go: the
  // backup's override is `link:../.generations/live/<old>`, and deleting the
  // old directory would leave that link dangling.
  const generations = generationDirs(
    await readdir(generationsRoot).catch(() => []),
    [...generationsReferencedBy(next)],
  )
  const states = stateDirs(await readdir(profileDir).catch(() => []))

  console.log(`profile      ${profileDir}`)
  console.log(`backup       ${backupPath ?? '(none found)'}`)
  for (const entry of backups) {
    if (entry.path === backupPath) continue
    console.log(`also there   ${entry.name}  ${JSON.stringify(readRefs(entry.manifest))}`)
  }
  if (warning !== undefined) console.log(`!            ${warning}`)
  console.log('current      ' + JSON.stringify(refs))
  console.log(`symlink      node_modules/${PACKAGE} -> ${target ?? '(absent)'}`)
  if (generations.length > 0) console.log(`generations  ${generations.join(', ')}`)
  if (states.legacy.length > 0) console.log(`old state    ${states.legacy.join(', ')}`)

  console.log('\nplanned changes:')
  const lines = [...changes]
  const linkWanted = wantedLink(next, profileDir)
  if (target !== undefined && linkWanted === undefined) lines.push(`node_modules/${PACKAGE}: symlink removed (a registry install will recreate it)`)
  else if (target !== undefined) lines.push(`node_modules/${PACKAGE}: → ${linkWanted}`)
  for (const name of generations) lines.push(`.generations/live/${name}: removed`)
  if (options.restoreState) {
    const from = options.stateFrom ?? states.legacy[0]?.replace(/^/, '')
    if (states.live.length > 0) lines.push(`model-sync → model-sync.v2-<stamp> (archived, not deleted)`)
    lines.push(from === undefined ? 'no previous state directory found: nothing restored' : `${from} → model-sync`)
  }
  if (lines.length === 0) lines.push('(nothing to do: this profile does not reference the package)')
  for (const line of lines) console.log(`  · ${line}`)
  for (const warning of warnings) console.log(`  ! ${warning}`)

  if (!options.apply) {
    console.log('\nNothing was changed. Re-run with --apply to perform these steps.')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // 1. Keep the manifest as it is now, so this rollback is itself reversible.
  const beforePath = join(profileDir, `.package.json.pre-rollback-${stamp}.bak`)
  await copyFile(manifestPath, beforePath)
  console.log(`\nmanifest backed up → ${beforePath}`)

  // 2. Write the reverted manifest.
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log('manifest reverted')

  // 3. Drop the symlink and the generation the installer created for us.
  if (target !== undefined) {
    await unlink(linkPath).catch(() => rm(linkPath, { recursive: true, force: true }))
    console.log(`removed node_modules/${PACKAGE}`)
  }
  if (linkWanted !== undefined) {
    await mkdir(dirname(linkPath), { recursive: true })
    await symlink(linkWanted, linkPath, 'dir')
    console.log(`relinked node_modules/${PACKAGE} -> ${linkWanted}`)
  }
  for (const name of generations) {
    const path = join(generationsRoot, name)
    // Belt and braces: only ever remove a path this script computed from the
    // package name, never one handed in by a caller.
    if (dirname(path) !== generationsRoot) continue
    await rm(path, { recursive: true, force: true })
    console.log(`removed .generations/live/${name}`)
  }

  // 4. Optionally put the previous release's state directory back.
  if (options.restoreState) {
    const live = join(profileDir, 'model-sync')
    if (states.live.length > 0) {
      const archived = join(profileDir, `model-sync.v2-${stamp}`)
      await rename(live, archived)
      console.log(`archived v2 state → ${archived}`)
    }
    const from = options.stateFrom ?? states.legacy[0]
    if (from === undefined) {
      console.log('no previous state directory found: nothing restored')
    } else {
      await rename(join(profileDir, from), live)
      console.log(`restored state      ${from} → model-sync`)
    }
  }

  // 5. Verify: the file must parse, and our references must be gone.
  const after = JSON.parse(await readFile(manifestPath, 'utf8'))
  const afterRefs = readRefs(after)
  const stillThere = Object.entries(afterRefs)
    .filter(([key, value]) => key !== 'bundled' && value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  console.log('\nafter        ' + JSON.stringify(afterRefs))

  if (JSON.stringify(afterRefs) !== JSON.stringify(readRefs(backup ?? {}))) {
    console.log('\n! the manifest does not match the backup for every reference — compare by hand:')
    console.log(`  backup: ${backupPath ?? '(none)'}`)
  } else {
    console.log('\nreverted. Restart DSH so the old (or no) plugin loads.')
  }
  if (stillThere.length > 0) {
    console.log('! these references are still present (the backup lists them too):')
    for (const row of stillThere) console.log(`  ${row}`)
  }
  console.log('\nmodel lists this plugin wrote are configuration, not manifest: to undo them')
  console.log('open Settings → 模型更新 and use 「恢复适配器默认目录」 per route, or restore a')
  console.log(`snapshot from ${join(profileDir, 'model-sync', 'snapshots')}`)
  console.log(`this rollback is itself reversible: ${beforePath} → ${manifestPath}`)
}

main().catch((error) => {
  console.error(`\nrollback failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
