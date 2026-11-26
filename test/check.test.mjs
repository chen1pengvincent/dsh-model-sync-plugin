/**
 * The check path, offline: what a check records, what it proposes, and what it
 * does when the upstream is unreachable.
 *
 * A check is the only place this plugin talks to the network, so it is also the
 * only place a proxy decision is observable. The listing function is injected,
 * which is what makes these assertions deterministic.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Controller } from '../lib/controller.js'

const PIAI = 'llm-pi-ai'

/** A controller whose listing is scripted by the caller. */
async function controllerWith(script, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-check-'))
  const document = {
    [PIAI]: {
      providers: {
        google: { apiKeyEnv: 'GOOGLE_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
        ...(options.providers ?? {}),
      },
    },
  }
  const revision = () => 7
  const ctx = {
    get(name) {
      if (name === 'settings') {
        return {
          describe: () => Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: revision() })),
          mutate: async () => {},
        }
      }
      if (name === 'llm') {
        return {
          listConfigurableProviders: () => [
            { provider: 'google', settingsNs: PIAI, settingsPath: ['providers', 'google'], displayName: 'Google', defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta', nativeAuth: { env: ['GOOGLE_API_KEY'] } },
            ...Object.keys(options.providers ?? {}).map((provider) => ({
              provider,
              settingsNs: PIAI,
              settingsPath: ['providers', provider],
              displayName: provider,
              defaultBaseURL: options.providers[provider].baseURL,
            })),
          ],
          listModels: async (provider) => (options.served?.[provider] ?? [{ id: 'gemini-4-argon' }]),
          resolveModelInfo: options.resolveModelInfo,
        }
      }
      if (name === 'credentials') return { resolve: async () => ({ value: 'k' }) }
      if (name === 'profileContext') return { dir }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
  }
  const controller = new Controller(ctx, { dir, logger: ctx.logger, list: script, egress: { dir }, bili: { locate: () => undefined } })
  await controller.store.load()
  return { controller, document, dir }
}

test('a check records the protocol, the exit, and only the ids that are new', async () => {
  const calls = []
  const script = async (input) => {
    calls.push(input)
    return { api: 'google-generative-ai', via: 'proxy', models: [{ id: 'gemini-4-argon' }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }] }
  }
  const { controller, dir } = await controllerWith(script)
  // The panel switch is on and the machine offers a proxy.
  controller.proxyState = async () => ({ enabled: true, available: true, url: 'http://127.0.0.1:7897', source: 'system' })

  const result = await controller.check({ reason: 'manual' })
  assert.equal(result.results.length, 1)
  const row = result.results[0]
  assert.equal(row.status, 'ok')
  assert.equal(row.protocol, 'google-generative-ai')
  assert.equal(row.via, 'proxy')
  assert.equal(row.upstreamCount, 2)
  assert.deepEqual(row.added, [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', blocked: '待确认模型调用协议' }])
  assert.deepEqual(row.gone, [])
  assert.ok(calls[0].proxy !== undefined, 'the check must be handed the proxy it should use')
  assert.equal(calls[0].apiKey, 'k')
  assert.deepEqual(controller.store.data.ladder, { google: 'google-generative-ai' })

  await rm(dir, { recursive: true, force: true })
})

test('a check with the switch off goes direct', async () => {
  const calls = []
  const { controller, dir } = await controllerWith(async (input) => {
    calls.push(input)
    return { api: 'openai-completions', via: 'direct', models: [{ id: 'gemini-4-argon' }] }
  })
  controller.proxyState = async () => ({ enabled: false, available: true, url: 'http://127.0.0.1:7897', source: 'system' })
  await controller.check({})
  assert.equal(calls[0].proxy, undefined)

  await rm(dir, { recursive: true, force: true })
})

test('a check shares one native lookup across candidates and compares only upstream input changes', async (t) => {
  const ids = Array.from({ length: 100 }, (_, index) => `new-${index}`)
  let officialInput
  const { controller, dir } = await controllerWith(async () => ({
    api: 'google-generative-ai', via: 'direct',
    models: ids.map((id) => id === ids[0] && officialInput ? { id, input: officialInput } : { id }),
  }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  controller.proxyState = async () => ({ enabled: false })
  let reads = 0
  controller.nativeCatalog = async () => {
    reads++
    return [{ id: ids[0], api: 'google-generative-ai', input: ['text'] }]
  }
  const check = async () => (await controller.check({ provider: 'google' })).results[0]
  const first = await check()
  assert.equal(reads, 1)
  assert.deepEqual(first.catalog[0].input, ['text'])
  assert.equal(first.reviewFacts[ids[0]], undefined)
  assert.equal(first.added[0].blocked, undefined)
  assert.match(first.added[1].blocked, /上下文窗口/)
  assert.deepEqual((await check()).upstreamChanged, [])
  officialInput = ['text']
  assert.deepEqual((await check()).upstreamChanged, [ids[0]])
  officialInput = undefined
  assert.deepEqual((await check()).upstreamChanged, [ids[0]])
  assert.equal(reads, 4)
  controller.nativeCatalog = async () => []
  await assert.rejects(
    () => controller.apply({ provider: 'google', ids: [ids[0]], removeIds: [] }),
    /待确认模型调用协议/,
  )
})

test('an unavailable native catalog does not veto an effective or live-resolvable model', async (t) => {
  const models = [{ id: 'gemini-4-argon' }]
  const { controller, dir } = await controllerWith(async () => ({
    api: 'google-generative-ai', via: 'direct', models,
  }), { resolveModelInfo: async (_provider, id) => ({ id }) })
  t.after(() => rm(dir, { recursive: true, force: true }))
  controller.proxyState = async () => ({ enabled: false })
  let reads = 0
  controller.nativeCatalog = async () => {
    reads++
    throw new Error('host catalog unavailable')
  }
  const check = async () => (await controller.check({ provider: 'google' })).results[0]
  const alreadyEffective = await check()
  assert.equal(alreadyEffective.status, 'ok')
  assert.deepEqual(alreadyEffective.added, [])
  models.push({ id: 'live-resolvable' })
  const withCandidate = await check()
  assert.equal(withCandidate.status, 'ok')
  assert.deepEqual(withCandidate.added, [{ id: 'live-resolvable' }])
  assert.equal(reads, 2)
})

test('a failed optional catalog read is retried for candidate validation; persistent failure is reported', async (t) => {
  const { controller, dir } = await controllerWith(async () => ({
    api: 'google-generative-ai', via: 'direct', models: [{ id: 'new-a' }, { id: 'new-b' }],
  }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  controller.proxyState = async () => ({ enabled: false })
  let reads = 0
  controller.nativeCatalog = async () => {
    if (++reads !== 2) throw new Error('host catalog unavailable')
    return [{ id: 'new-a' }]
  }
  const check = async () => (await controller.check({ provider: 'google' })).results[0]
  const first = await check()
  assert.equal(reads, 2)
  assert.equal(first.status, 'ok')
  const failed = await check()
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /host catalog unavailable/)
  assert.deepEqual(failed.added, first.added)
})

test('catalog checks retain an unsupported proxy so the transport can refuse it', async (t) => {
  const url = 'socks5://localhost:1080'
  const { controller, dir } = await controllerWith(async (input) => {
    assert.equal(input.proxy, url)
    throw new Error('unsupported proxy')
  })
  t.after(() => rm(dir, { recursive: true, force: true }))
  controller.proxyState = async () => ({ enabled: true, available: true, url })
  const { results } = await controller.check({ provider: 'google' })
  assert.equal(results[0].status, 'error')
  assert.equal(results[0].error, 'unsupported proxy')
})

test('a loopback baseURL is never tunnelled, even with the switch on', async () => {
  const calls = []
  const { controller, dir } = await controllerWith(async (input) => {
    calls.push(input)
    return { api: 'openai-completions', via: 'direct', models: [{ id: 'local-model' }] }
  }, { providers: { 'local-gw': { baseURL: 'http://127.0.0.1:9419/v1' } }, served: { 'local-gw': [{ id: 'local-model' }] } })
  controller.proxyState = async () => ({ enabled: true, available: true, url: 'http://127.0.0.1:7897', source: 'system' })
  await controller.check({ provider: 'local-gw' })
  assert.equal(calls[0].proxy, undefined)

  await rm(dir, { recursive: true, force: true })
})

test('an unreachable upstream is recorded, not thrown', async () => {
  const { controller, dir } = await controllerWith(async () => {
    throw new Error('connect-timeout api.example:443')
  })
  controller.proxyState = async () => ({ enabled: false, available: false })
  const result = await controller.check({})
  assert.equal(result.results[0].status, 'error')
  assert.match(result.results[0].error, /connect-timeout/)
  assert.equal(controller.store.data.summary.additions, 0)

  await rm(dir, { recursive: true, force: true })
})

test('ignored ids are not proposed again', async () => {
  const { controller, dir } = await controllerWith(async () => ({
    api: 'google-generative-ai', via: 'direct', models: [{ id: 'gemini-4-argon' }, { id: 'new-a' }, { id: 'new-b' }],
  }))
  controller.proxyState = async () => ({ enabled: false, available: false })
  controller.store.data.ignored = { google: ['new-a'] }
  const result = await controller.check({})
  assert.deepEqual(result.results[0].added.map((model) => model.id), ['new-b'])

  await rm(dir, { recursive: true, force: true })
})

test('a route nothing knows how to reach is reported instead of requested', async () => {
  // This used to be a red error. The route itself may be perfectly usable --
  // the catalog simply keeps no address for it -- so blaming the user for it is
  // wrong; say the address is unknown and ask nothing.
  const { controller, dir } = await controllerWith(async () => {
    throw new Error('should not be called')
  }, { providers: { bare: { baseURL: undefined } } })
  controller.proxyState = async () => ({ enabled: false, available: false })
  const result = await controller.check({ provider: 'bare' })
  assert.equal(result.results[0].status, 'no-endpoint')
  assert.equal(result.results[0].error, undefined)

  await rm(dir, { recursive: true, force: true })
})

test('a second check while one is running is refused with 409', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { controller, dir } = await controllerWith(async () => {
    await gate
    return { api: 'openai-completions', via: 'direct', models: [{ id: 'gemini-4-argon' }] }
  })
  controller.proxyState = async () => ({ enabled: false, available: false })
  const first = controller.check({})
  await assert.rejects(() => controller.check({}), (error) => error.status === 409)
  release()
  await first

  await rm(dir, { recursive: true, force: true })
})
