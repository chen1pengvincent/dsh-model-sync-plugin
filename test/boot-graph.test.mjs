/**
 * `scripts/boot-graph.mjs` is the only pre-restart proof that the panel will
 * actually be mounted: it drives the host's own `resolveMeta` with a real
 * cordis loader and reports which bundle the browser will be handed.
 *
 * The script needs the host's own packages (`dsh-client-modules`, `cordis`,
 * `cordis-plugin-loader`), which live inside the shipped `app.asar`. This test
 * runs it against the extracted copy when that copy is present, and skips
 * otherwise -- a checkout without the payload is still a valid checkout.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { asarAvailable, asarModules } from '../scripts/asar.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'scripts', 'boot-graph.mjs')
const explicitRoot = process.env.DSH_ASAR_DIR?.trim()
const ASSETS = explicitRoot ? resolve(explicitRoot, 'dsh', 'node_modules') : asarModules()
const skip = !explicitRoot && !asarAvailable() ? 'no extracted app.asar payload here' : false

test('the host loader resolves the registered checkout in an isolated profile', { skip }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'model-sync-boot-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profile = join(home, 'profiles', 'desktop')
  const modules = join(profile, 'node_modules')
  const link = join(modules, 'dsh-model-sync')
  const checkout = resolve(HERE, '..')
  await mkdir(modules, { recursive: true })
  await symlink(checkout, link, 'dir')
  const setBundles = (bundles) => writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
  const probe = () => run(process.execPath, [SCRIPT, '--assets', ASSETS], { env: { ...process.env, DSH_HOME: home }, timeout: 60_000 })
  await setBundles(['dsh-model-sync'])
  const { stdout } = await probe()
  // The arrow line is the one that matters: it is our package, and its target
  // has to be a file that exists (the script checks that itself and would have
  // exited non-zero otherwise).
  const line = stdout.split('\n').find((row) => row.startsWith('→  dsh-model-sync:'))
  assert.ok(line !== undefined, `no resolved bundle for this package:\n${stdout}`)
  assert.equal(await realpath(line.slice('→  dsh-model-sync: '.length)), await realpath(join(checkout, 'lib', 'client.js')))
  assert.match(stdout, /✅ 宿主会挂载本插件的浏览器半边/)
  assert.match(stdout, /inject=\[\] external=\[\] immediately=false/)
  await setBundles([])
  await assert.rejects(probe, (error) => error.code === 1 && error.stdout.includes('未在此 profile 的 bundles 中登记'))
  await setBundles(['dsh-model-sync'])
  await unlink(link)
  await assert.rejects(probe, (error) => error.code === 1)
})
