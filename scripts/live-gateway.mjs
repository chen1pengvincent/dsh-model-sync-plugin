/**
 * One real request through the local protocol gateway, against a real upstream.
 *
 * Everything else about the gateway is verified against fake servers; this is
 * the only check that the translation layer survives contact with a provider:
 * it probes a mixed-protocol route, opens the gateway, and asks for a model
 * whose wire protocol is *different* from the one it calls in on.
 *
 * Run: node scripts/live-gateway.mjs [--route opencode-go] [--mode reverse]
 *        [--base <url>] [--upstream-api <protocol>] [--models id,id] [--keep]
 */

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createGateway } from '../lib/gateway/server.js'
import { randomUUID } from 'node:crypto'
import { listAll } from '../lib/discovery.js'
import { detectSystemProxy } from '../lib/proxy.js'
import { request } from '../lib/http.js'
import { asarModules } from './asar.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
const ASAR_MODULES = asarModules()

const ROUTES = {
  'opencode-go': { baseURL: 'https://opencode.ai/zen/go/v1', ref: 'OPENCODE_GO_API_KEY', api: 'openai-completions' },
  'opencode': { baseURL: 'https://opencode.ai/zen/v1', ref: 'OPENCODE_API_KEY', api: 'openai-completions' },
  // A route whose *every* model speaks Anthropic: the narrowed surface is
  // completions, so the only thing this can prove is the reverse translation.
  'kimi-coding': { baseURL: 'https://api.kimi.com/coding', ref: 'KIMI_CODING_API_KEY', api: 'anthropic-messages' },
  // Gemini speaks its own wire: with `--mode reverse` this proves the gateway can
  // serve a Gemini model on a route DSH has been told is completions-only.
  'google': { baseURL: 'https://generativelanguage.googleapis.com/v1beta', ref: 'GOOGLE_API_KEY', api: 'google-generative-ai' },
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

/** The model ids the profile actually enables for a route. */
async function readProfileModels(routeId) {
  const yaml = createRequire(join(ASAR_MODULES, 'noop.js'))('yaml')
  const text = await readFile(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8')
  const parsed = yaml.parse(text)
  const entry = parsed.find((row) => row?.id === 'llm-pi-ai')
  const profile = entry?.config?.providers?.[routeId]
  const ids = Array.isArray(profile?.models) ? profile.models.map((model) => String(model.id ?? model)) : []
  return { ids, api: typeof profile?.api === 'string' ? profile.api : undefined, baseURL: typeof profile?.baseURL === 'string' ? profile.baseURL : undefined }
}

async function readRefs() {
  const text = await readFile(join(DSH_HOME, '.credentials.yaml'), 'utf8')
  const yaml = createRequire(join(ASAR_MODULES, 'noop.js'))('yaml')
  const parsed = yaml.parse(text)
  const refs = /** @type {Record<string, unknown>} */ (parsed?.refs ?? {})
  const out = {}
  for (const [name, value] of Object.entries(refs)) {
    out[name] = typeof value === 'string' ? value : value?.secret ?? value?.value
  }
  return out
}

/** POST through the gateway and return the raw SSE text. */
async function post(port, path, body) {
  const reply = await request({
    url: `http://127.0.0.1:${port}${path}`,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    proxy: undefined,
    timeoutMs: 45_000,
  })
  return reply
}

/**
 * Routes whose Gemini models live on a different base path than their chat
 * surface, or routes the profile enables no models on, need to be pointed at
 * explicitly — see `--base`, `--upstream-api` and `--models` below.
 */
async function main() {
  const routeId = arg('route', 'opencode-go')
  const base = ROUTES[routeId]
  if (base === undefined) throw new Error(`unknown route "${routeId}"; try one of ${Object.keys(ROUTES).join(', ')}`)
  const route = {
    ...base,
    baseURL: arg('base', base.baseURL),
    api: arg('upstream-api', base.api),
  }
  const refs = await readRefs()
  const apiKey = refs[route.ref]
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error(`${route.ref} is not in ~/.dsh/.credentials.yaml`)

  const proxy = (await detectSystemProxy()).url
  console.log(`route ${routeId}: ${route.baseURL}  (proxy ${proxy ?? 'none'})`)

  const profile = await readProfileModels(routeId)
  const reverseOnly = arg('mode') === 'reverse'
  const probe = reverseOnly === true ? undefined : await listAll({
    baseURL: profile.baseURL ?? route.baseURL,
    candidates: ['anthropic-messages', 'openai-completions', 'openai-responses'],
    apiKey,
    prefer: [route.api],
    proxy,
    timeoutMs: 20_000,
  })
  // Reverse mode trusts the route's declared protocol: there is no mixed surface
  // to probe, and probing a single-protocol route only repeats its own answer.
  const forced = arg('models')
  const ids = forced === undefined ? profile.ids : forced.split(',').map((id) => id.trim()).filter(Boolean)
  const models = reverseOnly === true
    ? new Map(ids.map((id) => [id, route.api]))
    : new Map(probe.attribution)
  const counts = {}
  for (const api of models.values()) counts[api] = (counts[api] ?? 0) + 1
  console.log(`  probe: ${models.size} models ${JSON.stringify(counts)}`)

  // Only models the profile enables are usable: the rest answer 403 "model
  // access is disabled", which says nothing about the translator.
  const usable = ids.length > 0 ? ids.filter((id) => models.has(id)) : [...models.keys()]
  const wanted = arg('translate-model')
  const translated = reverseOnly === true
    ? [wanted ?? usable[0], route.api]
    : usable.map((id) => [id, models.get(id)]).find(([id, api]) => api === 'anthropic-messages' && (wanted === undefined || id === wanted))
  const passed = reverseOnly === true
    ? undefined
    : usable.map((id) => [id, models.get(id)]).find(([, api]) => api !== 'anthropic-messages')
  if (translated === undefined || (reverseOnly !== true && passed === undefined)) {
    throw new Error(`need one usable model of each kind; profile enables ${JSON.stringify(ids)}, probe knows ${JSON.stringify(counts)}`)
  }
  console.log(`  usable: ${usable.length} — translated=${translated[0]} (${translated[1]})${passed === undefined ? '' : `, passthrough=${passed[0]}`}`)

  // Reverse mode deliberately narrows the surface: DSH is told the route speaks
  // completions while the upstream speaks Anthropic.
  const tap = reverseOnly === true ? 'openai-completions' : route.api

  const gateway = createGateway({
    routes: () => new Map([[routeId, {
      tap,
      upstreamBaseURL: route.baseURL,
      apiKey,
      models,
      // Exactly what `Controller.authHeadersFor` + the session quirk produce:
      // the route, not the protocol encoder, decides how to authenticate.
      // Mirrors `Controller.authHeadersFor`: Gemini wants its own header and
      // treats a bearer token as a broken OAuth attempt (401).
      authHeaders: routeId.startsWith('opencode')
        ? { 'x-opencode-session': `gw-${randomUUID()}`, authorization: `Bearer ${apiKey}` }
        : routeId === 'google'
          ? {}
          : { authorization: `Bearer ${apiKey}` },
    }]]),
    proxyFor: () => proxy,
    hostNeedsProxy: () => proxy !== undefined,
    logger: { warn: (m) => console.log('  · warn:', m), error: (m) => console.log('  · error:', m) },
  })
  const port = await gateway.start(0, [18787])
  console.log(`  gateway: http://127.0.0.1:${port}/g/${routeId}/`)

  try {
    const call = async (label, tail, payload, model) => {
      const reply = await post(port, `/g/${routeId}/${tail}`, payload)
      const text = reply.text ?? ''
      const frames = text.split('\n\n').filter((chunk) => chunk.trim().length > 0)
      const data = frames.map((frame) => /^data: (.*)$/m.exec(frame)?.[1]).filter((line) => line !== undefined && line !== '[DONE]')
      const parsed = data.map((line) => { try { return JSON.parse(line) } catch { return undefined } })
      const delta = parsed.flatMap((json) => json?.choices?.map((choice) => choice?.delta?.content ?? '') ?? [])
      const textDelta = parsed.flatMap((json) => json?.delta?.text ?? json?.content_block?.text ?? [])
      const body = (delta.join('') || textDelta.join('')).trim()
      console.log(`\n== ${label}: ${model} ==`)
      console.log(`  status ${reply.status}  frames ${frames.length}  text ${JSON.stringify(body.slice(0, 60))}`)
      if (reply.status !== 200) console.log(`  body: ${text.slice(0, 300)}`)
      if (process.argv.includes('--raw')) console.log(text.slice(0, 1200))
      return reply.status === 200 && body.length > 0
    }

    const passedOK = reverseOnly === true ? false : await call('passthrough (openai-completions → openai-completions)', 'chat/completions', {
      model: passed[0], max_tokens: 32, stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    }, passed[0])

    // The same model, asked for over the *other* wire: the gateway must accept an
    // Anthropic-shaped request, translate it to completions, and translate the
    // stream back into Anthropic frames.
    const translatedOK = reverseOnly === true ? false : await call('translated (anthropic-messages → openai-completions)', 'v1/messages', {
      model: passed[0], max_tokens: 32, stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] }],
      system: 'You answer in one word.',
    }, passed[0])

    // The direction a narrowed route depends on: DSH is told the whole route
    // speaks completions, so an Anthropic-protocol model must be translated the
    // other way through the same codec pair.
    const reverseOK = await call(`translated (openai-completions → ${route.api})`, 'chat/completions', {
      model: translated[0], max_tokens: 32, stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    }, translated[0])

    if (reverseOnly === true) {
      console.log(`\nresult: reverse=${reverseOK ? 'ok' : 'FAILED'}`)
    } else {
      console.log(`\nresult: passthrough=${passedOK ? 'ok' : 'FAILED'} translation=${translatedOK ? 'ok' : 'FAILED'} reverse=${reverseOK ? 'ok' : 'FAILED'}`)
    }
    console.log(`\nstats: ${JSON.stringify(gateway.stats())}`)
  } finally {
    if (process.argv.includes('--keep') !== true) await gateway.stop()
  }
}

await main()
