#!/usr/bin/env node
/**
 * Prove the document shape this plugin writes is a shape pi-ai accepts.
 *
 * The plugin's own rehearsal uses a fake host, and a fake host cannot tell you
 * whether `resolveProfiles` would have thrown — that logic lives inside
 * `@deepseek-ai/dsh-llm-pi-ai`. This script loads the **compiled** bundle from
 * the extracted app.asar, appends one export line to a temporary copy, and runs
 * `resolveRouteModels` in `strict` mode on the three shapes that matter:
 *
 *   1. a catalog-external id on a route with no `api`  → must throw ("needs an api")
 *   2. the same id after narrowing, without sizes      → must throw ("contextWindow")
 *   3. the same id after narrowing, with sizes         → must be accepted
 *
 * Nothing here touches the network, the profile, or the plugin's state.
 *
 * Usage: node scripts/pi-validate.mjs
 */
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { asarRoot } from './asar.mjs'

const asar = join(asarRoot(), 'dsh')
const pkg = join(asar, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')
const bundle = join(pkg, 'lib', 'index.js')

if (existsSync(bundle) === false) {
  console.log(`跳过：没有找到提取出来的 pi-ai（${bundle}）`)
  console.log('先解包 app.asar 到 <本仓库>/.asar/（或设 DSH_ASAR_DIR），再重跑。')
  process.exit(0)
}

const probe = join(pkg, 'lib', '__pi-validate.js')
let failures = 0
const check = (label, run, expected) => {
  let actual
  try {
    const out = run()
    actual = out.models.map((model) => `${model.id}[${model.api}] cw=${model.contextWindow} mt=${model.maxTokens}`).join(' | ')
    if (expected !== 'ok') {
      failures += 1
      console.log(`  ✖ ${label}: 居然通过了（期望被拒）`)
      return
    }
    console.log(`  ✅ ${label}: ${actual}`)
  } catch (error) {
    if (expected === 'ok') {
      failures += 1
      console.log(`  ✖ ${label}: 被拒了 —— ${error.message}`)
      return
    }
    const hit = error.message.includes(expected)
    if (hit === false) failures += 1
    console.log(`  ${hit ? '✅' : '✖'} ${label}: ${error.message}`)
  }
}

try {
  const source = await readFile(bundle, 'utf8')
  await writeFile(probe, `${source}\nexport { resolveRouteModels };\n`)
  const { resolveRouteModels } = await import(pathToFileURL(probe).href)

  const route = (extra = {}) => ({
    provider: 'opencode-go',
    apiKeyEnv: 'OPENCODE_GO_APIKEY',
    baseURL: 'https://opencode.ai/zen/go/v1',
    defaultInput: ['text', 'image'],
    models: [{ id: 'deepseek-v4.1-flash' }, { id: 'grok-9-imaginary' }],
    ...extra,
  })
  const sizes = { id: 'grok-9-imaginary', contextWindow: 256_000, maxTokens: 64_000 }

  console.log('pi-ai 严格校验（真实 Compiled bundle）:')
  check('无 api + 目录外 id', () => resolveRouteModels(route(), 'strict'), 'needs an api')
  check('收拢后但没给尺寸', () => resolveRouteModels(route({ api: 'openai-completions' }), 'strict'), 'contextWindow')
  check('收拢后给了尺寸', () => resolveRouteModels(route({
    api: 'openai-completions',
    models: [{ id: 'deepseek-v4.1-flash' }, sizes],
  }), 'strict'), 'ok')
} finally {
  await rm(probe, { force: true })
}

console.log(failures === 0 ? '\n结论: 插件写出的形状会被宿主接受 ✅' : `\n结论: ${failures} 个形状不对 ❌`)
process.exit(failures === 0 ? 0 : 1)
