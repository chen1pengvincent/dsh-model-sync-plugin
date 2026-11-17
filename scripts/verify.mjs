#!/usr/bin/env node
/**
 * One command that answers "is this installation working?".
 *
 * Without `--url` it judges what is on disk: the four manifest references, the
 * plugin's ledger, and whether the proxy keys it promised bili are still there.
 * With `--url <http://127.0.0.1:port>` it also asks the running host what it
 * sees, which is the only way to check the panel's own data path.
 *
 * Exit codes: 0 clean, 1 problems found, 2 could not inspect (missing profile).
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { locate, readConfigFile } from '../lib/bili.js'
import { requestJson } from '../lib/http.js'
import { format, inspectFiles, inspectView, merge } from '../lib/verify.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(HERE, '..')
const PACKAGE = 'dsh-model-sync'

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') args['json'] = true
    else if (token === '--help' || token === '-h') args['help'] = true
    else if (token.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`)
      args[token.slice(2)] = value
      index += 1
    } else {
      throw new Error(`unexpected argument ${token}`)
    }
  }
  return args
}

/**
 * Read a JSON file, or `undefined` when it is not there.
 * @param {string} path
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** @param {string} path */
function exists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

const USAGE = `用法: node scripts/verify.mjs [--url http://127.0.0.1:PORT] [--profile desktop] [--json]

  不带 --url 时只检查磁盘上的安装（四处引用、账本、bili 里的代理键）。
  带 --url 时再去问运行中的宿主，检查面板看到的数据是否自洽。`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args['help'] === true) {
    console.log(USAGE)
    return 0
  }

  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const profileName = typeof args['profile'] === 'string' ? args['profile'] : 'desktop'
  const profileDir = join(home, 'profiles', profileName)
  const manifestPath = join(profileDir, 'package.json')
  if (exists(manifestPath) !== true) {
    console.error(`找不到 profile：${manifestPath}`)
    return 2
  }

  const manifest = readJson(manifestPath)
  const statePath = join(profileDir, 'model-sync', 'state.json')
  const state = readJson(statePath)
  /** @type {any} */
  let lane
  /** @type {string | undefined} */
  let lanePath
  try {
    const where = locate()
    if (where !== undefined) {
      lanePath = where.configPath
      lane = await readConfigFile(where.configPath)
    }
  } catch {
    lane = undefined
  }

  let activationError
  try {
    activationError = await readFile(join(profileDir, 'model-sync', 'activation-error.txt'), 'utf8')
  } catch {
    activationError = undefined
  }
  let verdict = inspectFiles({ manifest, state, lane, source: SOURCE, packageName: PACKAGE, activationError })

  const url = typeof args['url'] === 'string' ? args['url'].replace(/\/+$/, '') : undefined
  if (url !== undefined) {
    try {
      const reply = await requestJson({ url: `${url}/model-sync/api/view`, timeoutMs: 8000, proxy: undefined })
      if (reply.status === 404) {
        verdict = merge(verdict, {
          ok: false,
          failures: [{
            area: 'install',
            message: '这个地址上没有插件的 API（404）：要么 DSH 还没重启，要么地址不是正在运行的那个实例',
          }],
          warnings: [],
          notes: [],
        })
      } else if (reply.status !== 200) {
        verdict = merge(verdict, {
          ok: false,
          failures: [{ area: 'install', message: `插件 API 回答 ${String(reply.status)}：${reply.text.slice(0, 160)}` }],
          warnings: [],
          notes: [],
        })
      } else {
        verdict = merge(verdict, inspectView(reply.json?.view))
      }
    } catch (error) {
      verdict = merge(verdict, {
        ok: false,
        failures: [{
          area: 'install',
          message: `连不上 ${url}：${error instanceof Error ? error.message : String(error)}（DSH 在跑吗？端口对吗？）`,
        }],
        warnings: [],
        notes: [],
      })
    }
  }

  if (args['json'] === true) {
    const body = {
      ok: verdict.ok,
      failures: verdict.failures,
      warnings: verdict.warnings,
      notes: verdict.notes,
      inspected: { profileDir, statePath: exists(statePath) ? statePath : undefined, lanePath, url },
    }
    console.log(JSON.stringify(body, null, 2))
  } else {
    console.log(`检查目录: ${profileDir}`)
    console.log(`插件源码: ${SOURCE}`)
    if (url !== undefined) console.log(`运行实例: ${url}`)
    else console.log('运行实例: 未检查（加 --url http://127.0.0.1:<端口> 可检查正在运行的宿主）')
    console.log('')
    console.log(format(verdict))
  }
  return verdict.ok ? 0 : 1
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
