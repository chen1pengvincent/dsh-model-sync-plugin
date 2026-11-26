#!/usr/bin/env node
/**
 * Prove the browser half will be mounted, without restarting the app.
 *
 * The panel arrives through `window.__ModuleLoader__`, and the host only feeds
 * that table from packages whose manifest declares `dsh.client` with
 * `platform: "web"` and whose `exports` has a `./client` bundle. If either is
 * wrong the host does not complain -- the settings section simply never exists,
 * and the failure looks exactly like "the plugin is not installed".
 *
 * So this runs the host's own resolution code (the real
 * `@deepseek-ai/dsh-client-modules` `resolveMeta`, driven by a real cordis
 * loader) against the installed package and prints what the boot graph will
 * contain. Read-only: nothing is imported from the plugin, no port is opened.
 *
 * Usage:
 *   node scripts/boot-graph.mjs [--profile desktop] [--assets <dir>]
 *
 * `--assets` defaults to the extracted `app.asar` payload (see scripts/asar.mjs:
 * `$DSH_ASAR_DIR`, else `.asar/` beside the source tree).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asarModules } from './asar.mjs'

const PACKAGE = 'dsh-model-sync'

/** @param {string} name */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`用法: node scripts/boot-graph.mjs [--profile <名字>] [--assets <node_modules 目录>]

用宿主自己的 dsh-client-modules 解析一遍「重启后浏览器会加载哪些 plugin bundle」，
因此可以在不重启的情况下确认面板确实有一个座位。只读，不加载插件、不开端口。

--assets 默认: 已解包的 app.asar（$DSH_ASAR_DIR，否则 <本仓库>/.asar/dsh/node_modules）
`)
  process.exit(0)
}

const profileName = arg('profile', 'desktop')
const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileName)
const assets = resolve(arg('assets', asarModules()))

if (existsSync(join(profileDir, 'package.json')) !== true) {
  console.error(`找不到 profile：${profileDir}`)
  process.exit(2)
}
const registryManifest = join(assets, '@deepseek-ai', 'dsh-client-modules', 'package.json')
if (!existsSync(registryManifest)) {
  console.error(`找不到宿主的客户端模块系统：${join(assets, '@deepseek-ai', 'dsh-client-modules')}`)
  console.error('先把 app.asar 解包到 <本仓库>/.asar/（或设 DSH_ASAR_DIR 指向解包目录），再用 --assets 指定 dsh/node_modules。')
  process.exit(2)
}

const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
const host = createRequire(registryManifest)
const loadHost = (name) => import(pathToFileURL(host.resolve(`@deepseek-ai/${name}`)).href)
const [cordis, loaderPackage, { ClientModuleRegistry }] = await Promise.all([
  loadHost('cordis'), loadHost('cordis-plugin-loader'), loadHost('dsh-client-modules'),
])

// A loader rooted in a scratch directory: this check must not read or write the
// plugin table of any real profile.
const scratch = await mkdtemp(join(tmpdir(), 'boot-graph-'))
const ctx = new cordis.Context()
ctx.baseUrl = pathToFileURL(scratch + '/').href
await ctx.plugin(loaderPackage.default ?? loaderPackage)
for (let attempt = 0; attempt < 100 && ctx.get('loader') === undefined; attempt += 1) {
  await new Promise((done) => setTimeout(done, 10))
}
if (ctx.get('loader') === undefined) {
  console.error('宿主 loader 没有起来；这个检查没法继续（真机不会遇到这种情况）。')
  await rm(scratch, { recursive: true, force: true })
  process.exit(2)
}

const registry = new ClientModuleRegistry(ctx)
const baseUrl = pathToFileURL(profileDir + '/').href
let failed = !bundles.includes(PACKAGE)
console.log(`profile: ${profileDir}`)
console.log(`bundles: ${bundles.length === 0 ? '(空)' : bundles.join(', ')}`)
console.log('')
if (failed) console.log(`❌ ${PACKAGE}: 未在此 profile 的 bundles 中登记`)
for (const name of new Set(bundles)) {
  let meta
  try {
    meta = registry.resolveMeta(name, baseUrl)
  } catch (error) {
    console.log(`❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
    failed = failed || name === PACKAGE
    continue
  }
  if (meta === null) {
    console.log(`·  ${name}: 没有浏览器半边（只有宿主插件）`)
    if (name === PACKAGE) failed = true
    continue
  }
  const marker = name === PACKAGE ? '→' : '·'
  console.log(`${marker}  ${name}: ${meta.meta.clientPath}`)
  if (name === PACKAGE) {
    console.log(`   inject=${JSON.stringify(meta.meta.inject ?? [])} external=${JSON.stringify(meta.meta.external)} immediately=${meta.meta.immediately}`)
    if (existsSync(meta.meta.clientPath) !== true) {
      console.log('   ❌ 这个 bundle 文件不存在：重启后设置里不会出现这一节')
      failed = true
    }
  }
}

console.log('')
console.log(failed ? '❌ 宿主不会挂载本插件的浏览器半边：面板重启后不会出现。' : '✅ 宿主会挂载本插件的浏览器半边：重启后设置里应该出现「模型管理」。')

await rm(scratch, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
