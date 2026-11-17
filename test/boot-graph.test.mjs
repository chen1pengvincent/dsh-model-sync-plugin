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
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { asarModules } from '../scripts/asar.mjs'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', 'scripts', 'boot-graph.mjs')
const ASSETS = asarModules()
const AVAILABLE = existsSync(join(ASSETS, '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'))

test('the browser half is mounted by the host loader', { skip: AVAILABLE !== true ? 'no extracted app.asar payload here' : false }, async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, '--assets', ASSETS], { timeout: 60_000 })
  // The arrow line is the one that matters: it is our package, and its target
  // has to be a file that exists (the script checks that itself and would have
  // exited non-zero otherwise).
  const line = stdout.split('\n').find((row) => row.startsWith('→  dsh-model-sync:'))
  assert.ok(line !== undefined, `no resolved bundle for this package:\n${stdout}`)
  assert.match(line, /lib\/client\.js$/)
  assert.match(stdout, /✅ 宿主会挂载本插件的浏览器半边/)
  assert.match(stdout, /inject=\[\] external=\[\] immediately=false/)
})
