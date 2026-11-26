import assert from 'node:assert/strict'
import test from 'node:test'

import { configuredProxyHosts, configuredTargets } from '../lib/targets.js'

function harness() {
  const providers = {
    custom: { baseURL: 'https://custom.example/v1' },
    local: { baseURL: 'http://localhost:7999' },
    broken: {},
    empty: {},
    env: {},
    opencode: {},
    duplicate: {},
    invalid: { baseURL: 'bad-address' },
  }
  const listed = []
  const credentials = []
  const services = {
    settings: { describe: () => [{ ns: 'adapter', value: { providers }, revision: 7 }] },
    llm: {
      listConfigurableProviders: () => [...Object.keys(providers), 'unconfigured'].map((provider) => ({
        provider, settingsNs: 'adapter', settingsPath: ['providers', provider],
        nativeAuth: { env: [provider] },
        defaultBaseURL: provider === 'opencode' ? undefined : 'https://retry.example',
        baseURLEnv: provider === 'env' ? ['DSH_MODEL_SYNC_TEST_TARGET_URL'] : undefined,
      })),
      async listModels(provider) {
        listed.push(provider)
        if (provider === 'broken') throw new Error('unavailable')
        if (provider === 'empty') return []
        return [{ id: provider }]
      },
    },
    credentials: { resolve(key) {
      credentials.push(key)
      return 'fixture'
    } },
  }
  return { ctx: { get: (name) => services[name] }, listed, credentials, providers }
}

test('scoped enumeration matches the full target with no unrelated model or credential reads', async () => {
  const { ctx, listed, credentials } = harness()
  const full = await configuredTargets(ctx)
  assert.deepEqual(full.problems.map((row) => row.provider), ['broken'])
  listed.length = credentials.length = 0
  const scoped = await configuredTargets(ctx, 'custom')
  assert.deepEqual(scoped, { targets: full.targets.filter((row) => row.provider === 'custom'), problems: [] })
  assert.deepEqual(await configuredTargets(ctx, 'unconfigured'), { targets: [], problems: [] })
  assert.deepEqual(listed, ['custom'])
  assert.deepEqual(credentials, ['custom'])
})

test('egress checks only eligible managed routes, preserves host order and never resolves credentials', async (t) => {
  const { ctx, listed, credentials, providers } = harness()
  const saved = process.env.DSH_MODEL_SYNC_TEST_TARGET_URL
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_MODEL_SYNC_TEST_TARGET_URL
    else process.env.DSH_MODEL_SYNC_TEST_TARGET_URL = saved
  })
  process.env.DSH_MODEL_SYNC_TEST_TARGET_URL = 'https://env.example'
  const hosts = ['OpenCode.ai', 'absent.example', 'env.example', 'retry.example', 'custom.example']
  assert.deepEqual(await configuredProxyHosts(ctx, hosts), ['OpenCode.ai', 'env.example', 'retry.example', 'custom.example'])
  assert.deepEqual(listed, ['custom', 'broken', 'empty', 'env', 'opencode', 'duplicate'])
  assert.deepEqual(credentials, [])
  delete providers.duplicate
  listed.length = 0
  assert.deepEqual(await configuredProxyHosts(ctx, ['retry.example']), [])
  assert.deepEqual(listed, ['broken', 'empty'])
})
