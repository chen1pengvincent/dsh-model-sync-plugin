/**
 * Live check of `lib/discovery.js` against the endpoints this profile actually
 * talks to. Run it before trusting the plugin with a schedule:
 *
 *   node test/live-discovery.mjs [--direct] [--proxy http://127.0.0.1:7897]
 *
 * Keys are read from `~/.dsh/.credentials.yaml` (`refs:` block) and never
 * printed. Nothing here writes configuration; it only lists.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listModels, protocolLadder } from '../lib/discovery.js'
import { parseProxy } from '../lib/http.js'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Read the `refs:` map out of the credentials file without printing values. */
function readRefs() {
  const path = join(HOME, '.credentials.yaml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (start === -1) return {}
  /** @type {Record<string, string>} */
  const refs = {}
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const match = /^\s{2}([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    refs[match[1]] = match[2].replace(/^["']|["']$/g, '').replace(/,$/, '')
  }
  return refs
}

const args = process.argv.slice(2)
const direct = args.includes('--direct')
const proxyArg = args.includes('--proxy') ? args[args.indexOf('--proxy') + 1] : 'http://127.0.0.1:7897'
const proxy = direct ? undefined : parseProxy(process.env.HTTPS_PROXY ?? proxyArg)

const refs = readRefs()

/** The routes this profile configures, with the protocol each is believed to speak. */
const CASES = [
  { name: 'google', baseURL: 'https://generativelanguage.googleapis.com', key: 'GOOGLE_API_KEY', preferred: ['google-generative-ai'] },
  { name: 'deepseek-official', baseURL: 'https://api.deepseek.com', key: 'DEEPSEEK_API_KEY', preferred: ['openai-completions'] },
  { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1', key: 'OPENCODE_GO_API_KEY', preferred: ['openai-completions'] },
  { name: 'opencode', baseURL: 'https://opencode.ai/zen/v1', key: 'OPENCODE_API_KEY', preferred: ['openai-completions'] },
  { name: 'kimi-coding', baseURL: 'https://api.kimi.com/coding', key: 'KIMI_CODING_API_KEY', preferred: ['anthropic-messages'] },
  { name: 'openai', baseURL: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', preferred: ['openai-completions'] },
]

console.log(`exit: ${proxy === undefined ? 'direct' : `${proxy.host}:${String(proxy.port)}`}`)
let failures = 0
for (const testCase of CASES) {
  const apiKey = refs[testCase.key]
  const started = Date.now()
  try {
    const result = await listModels({
      baseURL: testCase.baseURL,
      candidates: protocolLadder({ hints: testCase.preferred }),
      apiKey,
      proxy,
      timeoutMs: 12_000,
    })
    const sample = result.models.slice(0, 6).map((model) => model.id).join(', ')
    console.log(`OK   ${testCase.name.padEnd(18)} ${String(result.models.length).padStart(3)} models  via ${result.api} (${result.via}) ${String(Date.now() - started)}ms  e.g. ${sample}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${testCase.name.padEnd(18)} ${String(Date.now() - started)}ms  ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exitCode = failures === 0 ? 0 : 1
