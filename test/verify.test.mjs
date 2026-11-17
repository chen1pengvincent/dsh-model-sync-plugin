import assert from 'node:assert/strict'
import test from 'node:test'

import { format, inspectFiles, inspectView, merge } from '../lib/verify.js'

/** A view shaped like `controller.view()` on a healthy install. */
function healthyView() {
  return {
    proxy: { enabled: true, available: true, url: 'http://127.0.0.1:7897', source: 'system' },
    bili: {
      enabled: true,
      status: 'applied',
      written: 1,
      found: true,
      origin: 'http://127.0.0.1:18787',
      globalMode: 'direct',
      hosts: ['generativelanguage.googleapis.com'],
      rows: [{ host: 'generativelanguage.googleapis.com', key: 'https://generativelanguage.googleapis.com', proxy: 'http://127.0.0.1:7897', present: true }],
    },
    gateway: {
      enabled: true,
      running: true,
      url: 'http://127.0.0.1:41234',
      port: 41234,
      stats: { requests: 0 },
      exit: { available: true, url: 'http://127.0.0.1:7897', source: 'system' },
      entries: [{ provider: 'opencode-go', inbound: 'openai-completions', addedAfterRouting: 1, models: 30 }],
    },
    legacy: [],
    schedule: { enabled: true, hour: 9 },
    summary: { at: Date.now() - 60_000, providers: 2, ok: 2, additions: 0 },
    lastCheckAt: new Date(Date.now() - 60_000).toISOString(),
    providers: [{ provider: 'opencode-go' }, { provider: 'google' }],
    problems: [],
  }
}

test('a healthy view has nothing to report', () => {
  const verdict = inspectView(healthyView())
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures))
  assert.deepEqual(verdict.failures, [])
  assert.equal(verdict.warnings.length, 0)
})

test('a gateway switch that is on with no listener is a failure, not a warning', () => {
  const view = healthyView()
  view.gateway.running = false
  const verdict = inspectView(view)
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures[0].message, /监听器没在跑/u)
})

test('binding the lane port is called out', () => {
  const view = healthyView()
  view.gateway.port = 18787
  const verdict = inspectView(view)
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures[0].message, /bili 车道的端口/u)
})

test('an archived ledger is a failure the panel would otherwise only hint at', () => {
  const view = healthyView()
  view.problems = [{ provider: 'state', reason: 'archived as state.json.rejected-x' }]
  const verdict = inspectView(view)
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures[0].message, /账本没有被读入/u)
})

test('proxy keys with no bili lane behind them are a failure', () => {
  const view = healthyView()
  view.bili.found = false
  const verdict = inspectView(view)
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures[0].message, /找不到 bili 车道/u)
})

test('warning-only states keep ok true', () => {
  const view = healthyView()
  view.legacy = [{ provider: 'opencode-chat' }]
  view.schedule = { enabled: false, hour: 9 }
  const verdict = inspectView(view)
  assert.equal(verdict.ok, true)
  const messages = verdict.warnings.map((row) => row.message).join('\n')
  assert.match(messages, /合成供应商/u)
  assert.match(messages, /定时检查是关的/u)
  // One warning about not having checked yet would only repeat the timer one.
  assert.doesNotMatch(messages, /还没检查过/u)
})

test('files: a healthy profile passes', () => {
  const verdict = inspectFiles({
    manifest: {
      dependencies: { 'dsh-model-sync': 'link:/work/dsh-model-gateway' },
      pnpm: { overrides: { 'dsh-model-sync': 'link:/work/dsh-model-gateway' } },
      dsh: { profile: { bundles: ['dsh-model-sync'] }, desktop: { generationProjection: { plugins: { 'dsh-model-sync': { generationId: 'dsh-model-sync+1.0.0+abc' } } } } },
    },
    state: { version: 1, notices: [], snapshots: [{}] },
    lane: { providers: { 'https://generativelanguage.googleapis.com': { proxy: 'http://127.0.0.1:7897' } } },
    source: '/work/dsh-model-gateway',
    packageName: 'dsh-model-sync',
  })
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures))
})

test('files: an override left behind is the rollback bomb', () => {
  const verdict = inspectFiles({
    manifest: {
      dependencies: { 'dsh-model-sync': 'link:/work/dsh-model-gateway' },
      pnpm: { overrides: { 'dsh-model-sync': 'link:/work/.generations/live/dsh-model-sync+0.12.5+abc' } },
      dsh: { profile: { bundles: ['dsh-model-sync'] } },
    },
    source: '/work/dsh-model-gateway',
    packageName: 'dsh-model-sync',
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.map((row) => row.message).join('\n'), /pnpm\.overrides/u)
})

test('files: proxy keys the ledger promised but the lane lost', () => {
  const verdict = inspectFiles({
    manifest: {
      dependencies: { 'dsh-model-sync': 'link:/work/dsh-model-gateway' },
      dsh: { profile: { bundles: ['dsh-model-sync'] } },
    },
    state: { version: 1, bili: { written: [{ key: 'https://api.openai.com', proxy: 'http://127.0.0.1:7897' }] } },
    lane: { providers: {} },
    source: '/work/dsh-model-gateway',
    packageName: 'dsh-model-sync',
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures[0].message, /没有 https:\/\/api\.openai\.com 的代理条目/u)
})

test('files: a missing profile dependency and bundle row are both named', () => {
  const verdict = inspectFiles({ manifest: { dsh: { profile: { bundles: [] } } }, source: '/work/x', packageName: 'dsh-model-sync' })
  const text = verdict.failures.map((row) => row.message).join('\n')
  assert.match(text, /dependencies 里没有/u)
  assert.match(text, /bundles 里没有/u)
})

test('the stored boot verdict is the proof the host actually loaded this code', () => {
  const passing = inspectFiles({
    manifest: { dependencies: { 'dsh-model-sync': 'link:/work/dsh-model-gateway' }, dsh: { profile: { bundles: ['dsh-model-sync'] } } },
    state: { version: 1, snapshots: [], selfCheck: { at: '2026-11-16T02:28:00.000Z', ok: true, failures: [], warnings: [], text: '✅ 没有发现会拦住你的问题' } },
    source: '/work/dsh-model-gateway',
    packageName: 'dsh-model-sync',
  })
  assert.equal(passing.ok, true)
  assert.match(passing.notes.join('\n'), /上次启动自检：✅ 通过/u)

  const failing = inspectFiles({
    manifest: { dependencies: { 'dsh-model-sync': 'link:/work/dsh-model-gateway' }, dsh: { profile: { bundles: ['dsh-model-sync'] } } },
    state: { version: 1, selfCheck: { at: 'nope', ok: false, failures: [{ area: 'gateway', message: '网关开关开着但没监听器' }] } },
    source: '/work/dsh-model-gateway',
    packageName: 'dsh-model-sync',
  })
  assert.equal(failing.ok, false)
  assert.match(failing.failures.map((row) => row.message).join('\n'), /没监听器/u)
})

test('merge keeps every finding and recomputes ok', () => {
  const merged = merge(
    { ok: true, failures: [], warnings: [{ area: 'install', message: 'a' }], notes: ['n1'] },
    { ok: false, failures: [{ area: 'bili', message: 'b' }], warnings: [], notes: ['n2'] },
  )
  assert.equal(merged.ok, false)
  assert.equal(merged.warnings.length, 1)
  assert.equal(merged.notes.length, 2)
})

test('the printed verdict leads with failures and ends with a one-line answer', () => {
  const text = format(merge(
    { ok: false, failures: [{ area: 'gateway', message: '网关开关是开的，但监听器没在跑' }], warnings: [{ area: 'schedule', message: '还没检查过' }], notes: ['2 个已配置供应商'] },
  ), { width: 20 })
  const lines = text.split('\n')
  assert.match(lines[0], /^❌ \[网关\]/u)
  assert.match(text, /⚠️ {2}\[定时\]/u)
  assert.match(lines.at(-1) ?? '', /1 个问题需要处理/u)
})
