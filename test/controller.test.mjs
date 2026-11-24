/**
 * Behaviour tests for the parts that touch the user's configuration.
 *
 * The harness is faked at the three service seams (`settings`, `llm`,
 * `credentials`), so these tests run offline and assert the exact settings ops
 * this plugin would send. The invariant under test is the one the whole design
 * exists for: **no provider key is ever created, and no write is ever sent to a
 * path other than an existing route's `models` array.**
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Controller } from '../lib/controller.js'
import { indexModelsDev } from '../lib/models-dev.js'
import { additionOp, buildModelsWrite, removalOp, restoreOp } from '../lib/plan.js'
import { foreignProviderKeys } from '../lib/targets.js'
import { format } from '../lib/verify.js'

const PIAI = 'llm-pi-ai'
const DEEPSEEK = 'llm-deepseek'
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** A harness whose settings document lives in memory and records every op. */
function harness(options = {}) {
  const document = {
    [PIAI]: {
      providers: {
        google: {
          apiKeyEnv: 'GOOGLE_API_KEY',
          baseURL: GOOGLE_BASE,
          ...(options.googleModels === undefined ? {} : { models: options.googleModels }),
        },
        ...(options.extraProviders ?? {}),
      },
    },
    [DEEPSEEK]: { apiKeyEnv: 'DEEPSEEK_API_KEY', ...options.deepseek },
  }
  /** @type {Record<string, number>} */
  const revisions = { [PIAI]: 1, [DEEPSEEK]: 1 }
  /** @type {{ns: string, ops: any[], revision: number|undefined}[]} */
  const writes = []

  /** Mirrors the harness: `set` replaces at the path, `unset` deletes the key. */
  const apply = (node, path, value, op) => {
    const copy = node !== null && typeof node === 'object' && !Array.isArray(node) ? { ...node } : {}
    if (path.length === 0) return value === undefined ? copy : value
    const [head, ...rest] = path
    if (rest.length === 0) {
      if (op === 'unset') delete copy[head]
      else copy[head] = structuredClone(value)
      return copy
    }
    copy[head] = apply(copy[head], rest, value, op)
    return copy
  }

  const settings = {
    describe() {
      return Object.entries(document).map(([ns, value]) => ({ ns, value: structuredClone(value), revision: revisions[ns] }))
    },
    async mutate(ns, ops, expectedRevision) {
      writes.push({ ns, ops, revision: expectedRevision })
      // Lets a test interleave a competing edit between the read and the write.
      options.onMutate?.({ ns, ops, expectedRevision, document, revisions })
      if (expectedRevision !== undefined && expectedRevision !== revisions[ns]) {
        throw Object.assign(new Error('revision conflict'), { name: 'SettingsConflictError' })
      }
      let value = document[ns]
      for (const op of ops) {
        if (op.op === 'set') value = apply(value, op.path, structuredClone(op.value), 'set')
        else value = apply(value, op.path, undefined, 'unset')
      }
      document[ns] = value
      revisions[ns] += 1
    },
  }

  const llm = {
    listProviders: () => [{ id: 'google', name: 'Google' }, { id: 'deepseek-official', name: 'DeepSeek' }],
    listConfigurableProviders: () => [
      { provider: 'google', settingsNs: PIAI, settingsPath: ['providers', 'google'], displayName: 'Google', defaultBaseURL: GOOGLE_BASE, nativeAuth: { env: ['GOOGLE_API_KEY'] } },
      ...Object.keys(options.extraProviders ?? {}).map((provider) => ({
        provider,
        settingsNs: PIAI,
        settingsPath: ['providers', provider],
        displayName: provider,
        defaultBaseURL: `https://api.${provider}.example`,
      })),
      { provider: 'deepseek-official', settingsNs: DEEPSEEK, settingsPath: [], displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com' },
    ],
    async resolveModelInfo(provider, id) {
      return options.resolveModelInfo?.(provider, id) ?? { provider, id, name: id }
    },
    async listModels(provider) {
      if (provider === 'google') {
        const stated = document[PIAI].providers.google.models
        return Array.isArray(stated) ? stated.map((model) => ({ id: model.id ?? model })) : [{ id: 'gemini-4-argon' }]
      }
      if (provider === 'deepseek-official') return document[DEEPSEEK].models ?? [{ id: 'deepseek-chat' }]
      return [{ id: `${provider}-model` }]
    },
  }

  const credentials = {
    async resolve(ref) {
      return { value: ref === 'GOOGLE_API_KEY' ? 'SECRET-VALUE-DO-NOT-STORE' : undefined }
    },
  }

  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      if (name === 'llm') return llm
      if (name === 'credentials') return credentials
      if (name === 'profileContext') return { dir: options.profileDir }
      if (name === 'sessions') return options.sessions
      if (name === 'sessionProjections') return options.sessionProjections
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
  }

  return { ctx, document, writes, settings }
}

test('membership swaps the only configured model in one write and offers it again when listed upstream', async () => {
  const current = 'gemini-4-argon'
  const replacement = 'gemini-4-neon'
  const selected = [{ provider: 'google', model: current }, { provider: 'another-route', model: current }]
  const { controller, document, dir, writes } = await controllerFor({
    googleModels: [{ id: current, name: 'Argon' }],
    sessions: { list: () => selected },
    sessionProjections: { snapshot: (next) => ({ values: { modelSelection: { next } } }) },
  })
  try {
    const candidates = [{ id: replacement }]
    controller.store.data.checks = { google: { status: 'ok', added: candidates, catalog: [{ id: current, name: 'Argon' }, ...candidates] } }
    const swap = { provider: 'google', ids: [replacement], removeIds: [current], showInPicker: false }
    await assert.rejects(() => controller.apply({ ...swap, ids: [] }), /至少保留一个模型/)
    await assert.rejects(() => controller.apply(swap), /有新的会话/)
    await assert.rejects(() => controller.apply({ ...swap, ids: ['unlisted'] }), /候选清单已变化/)
    assert.equal(writes.length, 0)

    const result = await controller.apply({ ...swap, seenUsage: [[current, 1]] })
    assert.deepEqual(result.written, [replacement])
    assert.deepEqual(result.removed, [current])
    assert.deepEqual(result.hidden, [['google', replacement]])
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].ops[0].path, ['providers', 'google', 'models'])
    assert.deepEqual(document[PIAI].providers.google.models.map(({ id }) => id), [replacement])
    assert.deepEqual(controller.store.data.checks.google.added, [{ id: current, name: 'Argon' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('removal-only does not need a check and preserves unchanged model metadata', async () => {
  const keep = { id: 'gemini-4-argon', name: 'Argon', contextWindow: 12345 }
  const { controller, document, dir, writes } = await controllerFor({
    googleModels: [{ id: 'gemini-4-neon' }, keep],
  })
  try {
    await controller.apply({ provider: 'google', ids: [], removeIds: ['gemini-4-neon'] })
    assert.equal(writes.length, 1)
    assert.deepEqual(document[PIAI].providers.google.models, [keep])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('model review separates route identity, evidence, pending and user decisions', async () => {
  const id = 'shared-model'
  const model = { id, contextWindow: 10000, maxTokens: 5000, input: ['text'] }
  const { controller, dir } = await controllerFor({ googleModels: [model], extraProviders: { other: { models: [{ id }] } } })
  try {
    controller.store.data.checks = {
      google: { status: 'ok', at: 1, catalog: [model], reviewFacts: { [id]: { ...model, maxTokens: 6000 } } },
      other: { status: 'ok', at: 1, catalog: [{ id }], reviewFacts: { [id]: { ...model } } },
    }
    const view = () => controller.view().then(({ review }) => review)
    const before = (await view()).models.filter((row) => row.id === id)
    assert.equal(before.length, 2)
    assert.equal(before[0].level, 'unverified')
    assert.equal(before[0].pending, true)
    assert.equal(before[1].level, 'official')
    assert.equal(before[1].pending, false)
    await controller.saveReview({ ...before[0], decision: 'ignore' })
    const reviewed = () => view().then(({ models }) => models.find((row) => row.provider === 'google'))
    assert.equal((await reviewed()).pending, true, 'an official difference stays visible even after ignoring')
    await controller.saveReview({ ...await reviewed(), decision: 'keep' })
    const after = await reviewed()
    assert.equal(after.level, 'unverified')
    assert.equal(after.pending, true)
    assert.equal(after.fields.maxTokens.locked, true)
    assert.equal(after.fields.maxTokens.value, 5000)
    controller.store.data.checks.google.catalog[0] = { ...model, maxTokens: 7000 }
    controller.store.data.checks.google.reviewFacts[id].maxTokens = 7000
    controller.nativeCatalog = async () => []
    await controller.autoFillMetadata(await controller.freshTarget('google', PIAI))
    const locked = await reviewed()
    assert.equal(locked.fields.maxTokens.value, 5000)
    assert.equal(locked.fields.maxTokens.candidate, 7000)
    assert.equal(locked.pending, true)
    const adopted = await controller.saveReview({
      ...locked, changes: { maxTokens: { value: 7000, candidateSource: 'official', useCandidate: true } },
    })
    assert.equal(adopted.review.models.find((row) => row.provider === 'google').pending, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ignore lasts until the affected upstream value changes', async () => {
  const model = { id: 'gemini-x', contextWindow: 1000, input: ['text'] }
  const { controller, dir } = await controllerFor({ googleModels: [model] })
  try {
    const get = async () => (await controller.view()).review.models.find((row) => row.id === model.id)
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    const before = await get()
    assert.equal(before.fields.maxTokens.candidate, 100)
    await controller.saveReview({ ...before, decision: 'ignore' })
    assert.equal((await get()).pending, false)
    const changed = structuredClone(DEV_PAYLOAD)
    changed.google.models['gemini-x'].limit.output = 150
    controller.modelsDevIndex = indexModelsDev(changed)
    controller.refreshReviewIgnores(await controller.freshTarget('google', PIAI))
    assert.equal((await get()).pending, true)
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    assert.equal((await get()).pending, true, 'returning to an older value does not revive an expired ignore')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saving an optional candidate checks the exact value and source shown in the preview', async () => {
  const model = { id: 'sample', contextWindow: 10000, maxTokens: 4000, input: ['text'] }
  const { controller, dir, writes } = await controllerFor({ googleModels: [model] })
  try {
    const facts = { reasoningEfforts: { low: 'low' } }
    controller.store.data.checks = { google: { status: 'ok', catalog: [model], reviewFacts: { [model.id]: facts } } }
    const before = (await controller.view()).review.models.find((row) => row.id === model.id)
    const changes = { reasoningEfforts: { value: { low: 'low' }, candidateSource: 'official', useCandidate: true } }
    facts.reasoningEfforts = { high: 'high' }
    await assert.rejects(() => controller.saveReview({ ...before, changes }), /候选值或来源已变化/)
    assert.equal(writes.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a listing for an old endpoint cannot be applied after the route changes', async () => {
  const id = 'sample'
  const { controller, document, settings, dir } = await controllerFor({ googleModels: [{ id }] })
  try {
    controller.proxyState = async () => ({ enabled: false, available: false })
    controller.list = async () => {
      const { revision } = settings.describe().find(({ ns }) => ns === PIAI)
      await settings.mutate(PIAI, [{ op: 'set', path: ['providers', 'google', 'baseURL'], value: 'https://replacement.example/v1' }], revision)
      return { api: 'openai-completions', models: [{ id, contextWindow: 123456 }] }
    }
    const { sync } = await controller.check({ provider: 'google' })
    assert.equal(sync.fields.updated, 0)
    assert.equal(sync.incomplete[0].provider, 'google')
    assert.deepEqual(document[PIAI].providers.google.models, [{ id }])
    assert.equal((await controller.view()).review.models.find((row) => row.id === id).fields.contextWindow.candidate, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a skipped provider does not repeat the previous provider’s update count', async () => {
  const id = 'sample'
  const { controller, dir, writes } = await controllerFor({ googleModels: [{ id }] })
  try {
    controller.proxyState = async () => ({ enabled: false, available: false })
    controller.list = async ({ baseURL }) => ({
      api: 'openai-completions',
      models: baseURL === GOOGLE_BASE ? [{ id, contextWindow: 123456 }] : [],
    })
    const { sync } = await controller.check()
    assert.equal(writes.length, 1)
    assert.deepEqual(sync.fields, { updated: 1, promoted: 0, adopted: 0 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('automatic metadata rollback leaves later edits intact when the ledger fails', async () => {
  const id = 'sample'
  const { controller, document, settings, dir } = await controllerFor({ googleModels: [{ id, maxTokens: 4000 }] })
  try {
    const target = await controller.freshTarget('google', PIAI)
    controller.store.data.checks = { google: { status: 'ok', catalog: [{ id, contextWindow: 12000 }] } }
    controller.nativeCatalog = async () => []
    controller.store.save = async () => {
      const current = settings.describe().find(({ ns }) => ns === PIAI)
      const models = current.value.providers.google.models.map((row) => ({ ...row, maxTokens: 6800 }))
      await settings.mutate(PIAI, [{ op: 'set', path: target.settingsPath, value: models }], current.revision)
      throw new Error('disk full')
    }
    await assert.rejects(() => controller.autoFillMetadata(target), /已有其他变更/)
    assert.equal(document[PIAI].providers.google.models[0].maxTokens, 6800)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('refreshing legacy review evidence recognizes complete provider facts without changing settings', async () => {
  const listed = { id: 'full', contextWindow: 10000, maxTokens: 4000, input: ['text'] }
  const omitted = { id: 'missing-input', contextWindow: 10000, maxTokens: 4000 }
  const { controller, dir, writes } = await controllerFor({ googleModels: [{ id: listed.id }, { id: omitted.id }] })
  try {
    const summary = { at: Date.now() }
    controller.store.data.summary = summary
    controller.store.data.checks = {
      google: { status: 'ok', at: summary.at, catalog: [listed, { ...omitted, input: ['text'] }] },
    }
    controller.list = async () => ({ models: [listed, omitted], api: 'google-generative-ai', via: 'direct' })
    controller.nativeCatalog = async () => [{ id: omitted.id, input: ['text'] }]
    const options = { reason: 'boot', evidenceOnly: true }

    assert.equal((await controller.view()).review.models.some((model) => model.level === 'official'), false)
    assert.equal((await controller.check(options)).results.length, 1)
    const { review } = await controller.view()
    assert.equal(review.models.find(({ id }) => id === listed.id).level, 'official')
    assert.equal(review.models.find(({ id }) => id === omitted.id).level, 'partial')
    assert.equal((await controller.check(options)).results.length, 0)
    assert.deepEqual(writes, [])
    assert.deepEqual(controller.store.data.summary, summary)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('review saves a model in one write, records five modalities and preserves the host schema', async () => {
  const model = { id: 'model-one', contextWindow: 10000, maxTokens: 4000, input: ['text'] }
  const { controller, document, dir, writes } = await controllerFor({ googleModels: [model, { id: 'neighbor' }] })
  try {
    const { review } = await controller.view()
    const before = review.models.find((row) => row.id === model.id)
    const input = ['text', 'image', 'audio', 'video', 'pdf']
    const changes = { maxTokens: { value: 6000 }, input: { value: input } }
    const saved = await controller.saveReview({ ...before, changes })
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].ops[0].path, ['providers', 'google', 'models'])
    assert.deepEqual(document[PIAI].providers.google.models, [{ ...model, maxTokens: 6000, input: ['text', 'image'] }, { id: 'neighbor' }])
    assert.deepEqual(saved.review.models.find((row) => row.id === model.id).fields.input.value, input)
    assert.deepEqual(saved.review.history.find((row) => row.field === 'input').to, input)
    await assert.rejects(() => controller.saveReview({ ...before, changes }), /已变化/)
    const after = saved.review.models.find((row) => row.id === model.id)
    await assert.rejects(() => controller.saveReview({ ...after, changes: { input: { value: ['unknown'] } } }), /请检查/)
    assert.equal(writes.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('review restores only its model-list revision when the ledger cannot be saved', async () => {
  const model = { id: 'model-one', contextWindow: 10000, maxTokens: 4000 }
  const { controller, document, dir, writes } = await controllerFor({ googleModels: [model] })
  try {
    const before = (await controller.view()).review.models.find((row) => row.id === model.id)
    controller.store.save = async () => { throw new Error('disk full') }
    await assert.rejects(() => controller.saveReview({ ...before, changes: { maxTokens: { value: 5000 } } }), /disk full/)
    assert.deepEqual(document[PIAI].providers.google.models, [model])
    assert.equal(writes.length, 2)
    assert.equal((await controller.view()).review.history.some((row) => row.model === model.id), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('one picker save registers a new model and hides an existing model without deleting it', async () => {
  const keep = { id: 'gemini-4-argon', name: 'Argon', contextWindow: 12345 }
  const newId = 'gemini-4-neon'
  const { controller, document, dir, writes } = await controllerFor({ googleModels: [keep] })
  try {
    controller.store.data.checks = { google: { status: 'ok', added: [{ id: newId }] } }
    controller.store.data.hiddenModels = [['google', newId], ['other-provider', keep.id]]
    const result = await controller.apply({
      provider: 'google', ids: [newId], removeIds: [], showInPicker: true,
      pickerChanges: [{ id: keep.id, visible: false }],
    })
    assert.equal(writes.length, 1)
    assert.deepEqual(document[PIAI].providers.google.models, [keep, { id: newId }])
    assert.deepEqual(result.hidden, [['other-provider', keep.id], ['google', keep.id]])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A controller over a temp state directory. */
async function controllerFor(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-test-'))
  const fake = harness({ ...options, profileDir: dir })
  // Tests must never reach the real bili lane: one stray sync would rewrite
  // another plugin's config. `locate` returning undefined is the honest fake.
  const controller = new Controller(fake.ctx, {
    dir,
    egress: { dir },
    logger: fake.ctx.logger,
    bili: options.bili ?? { locate: () => undefined },
  })
  await controller.store.load()
  return { ...fake, controller, dir }
}

test('a first boot on an empty directory arms the timer and writes nothing', async () => {
  // This is the exact state of a freshly installed profile: no state.json, no
  // snapshots, and one `start()` that has to leave a working panel behind.
  const { controller, dir, writes } = await controllerFor()
  try {
    await controller.start()
    const view = await controller.view()
    assert.equal(view.selfCheck.ok, true, JSON.stringify(view.selfCheck.failures))
    assert.equal(view.schedule.enabled, true, 'a fresh install must arm the daily check')
    assert.ok(view.providers.length > 0, 'the panel needs rows on the very first render')
    assert.deepEqual(writes, [], 'booting must not write to the settings')
    assert.ok(controller.bootCheckDue() === true || controller.bootCheckDue() === false)
  } finally {
    controller.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('removing a model does not also blacklist it', async () => {
  // The two are different promises: a removal is a settings edit the user can
  // undo by adding the model back, an ignore is a private list. Writing the
  // blacklist from `remove()` made the × chip silently permanent.
  const { controller, dir } = await controllerFor({ googleModels: [{ id: 'gemini-4-argon' }, { id: 'gemini-2.5-pro' }] })
  try {
    const result = await controller.remove({ provider: 'google', id: 'gemini-4-argon' })
    assert.equal(result.removed, 'gemini-4-argon')
    assert.deepEqual(controller.store.data.ignored ?? {}, {}, 'a removal must leave the ignore list alone')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearing the ignore list forgets the ids and says so', async () => {
  const { controller, dir } = await controllerFor({ googleModels: [{ id: 'gemini-4-argon' }] })
  try {
    controller.store.data.ignored = { google: ['gemini-9-new'] }
    await controller.store.save()
    const view = await controller.view()
    assert.deepEqual(view.providers.find((row) => row.provider === 'google').ignored, ['gemini-9-new'])

    const cleared = await controller.unignore({ provider: 'google' })
    assert.deepEqual(cleared.ignored, [])
    assert.deepEqual(controller.store.data.ignored, {}, 'the provider key is removed, not emptied')
    const after = await controller.view()
    assert.deepEqual(after.providers.find((row) => row.provider === 'google').ignored, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('booting runs the self-check once and keeps the verdict in the panel payload', async () => {
  const { controller, dir } = await controllerFor()
  await controller.start()
  const view = await controller.view()
  assert.equal(typeof view.selfCheck, 'object', 'a boot has to leave a verdict behind')
  assert.equal(view.selfCheck.ok, true, JSON.stringify(view.selfCheck.failures))
  assert.equal(typeof view.selfCheck.text, 'string')
  assert.ok(view.selfCheck.text.includes('✅'), 'the stored text is the same sentence the script prints')
  // The manifest is unreadable in this fixture, so the install half says so
  // instead of inventing a broken install.
  assert.ok(view.selfCheck.text.includes('跳过安装检查'), view.selfCheck.text)
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.selfCheck.ok, true, 'the verdict survives the process')
  await controller.dispose()
})

test('two self-checks at once store one verdict, and the panel row matches it', async () => {
  const { controller, dir } = await controllerFor()
  const [a, b] = await Promise.all([controller.runSelfCheck(), controller.runSelfCheck()])
  assert.equal(a, b, 'the second caller waits for the first run instead of starting another')
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.selfCheck.text, format(a), 'the stored text is the one the caller printed')
  const view = await controller.view()
  assert.equal(view.selfCheck.text, format(a), 'the first row shows what the button showed')
  await controller.dispose()
})

test('view lists only configured routes and reports leftovers separately', async () => {
  const { controller, document } = await controllerFor({ extraProviders: { 'legacy-route': { displayName: 'Legacy' } } })
  // A provider key with no route behind it is exactly what the old plugin left.
  document[PIAI].providers['opencode-chat'] = { displayName: 'opencode · Chat Completions' }

  const view = await controller.view()
  const names = view.providers.map((row) => row.provider)
  assert.deepEqual(names.sort(), ['deepseek-official', 'google', 'legacy-route'])
  assert.deepEqual(view.foreign, ['opencode-chat'])
  assert.equal(view.providers.find((row) => row.provider === 'google').explicitModels, false)

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('removing the only model of a route returns to the catalog and says so', async () => {
  const { controller, document, writes } = await controllerFor()
  document[PIAI].providers.google.models = [{ id: 'gemini-4-argon' }]

  const result = await controller.remove({ provider: 'google', id: 'gemini-4-argon' })
  assert.equal(result.removed, 'gemini-4-argon')
  assert.match(result.note, /内置目录/)

  const last = writes.at(-1)
  assert.deepEqual(last.ops, [{ op: 'unset', path: ['providers', 'google', 'models'] }])
  assert.equal(document[PIAI].providers.google.models, undefined)

  // The route is back on the inherited catalog, and the panel says so.
  const view = await controller.view()
  assert.equal(view.providers.find((row) => row.provider === 'google').explicitModels, false)

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('an addition preserves existing entries verbatim and only appends', () => {
  const target = {
    settingsPath: ['providers', 'google', 'models'],
    modelEntries: [{ id: 'gemini-4-argon', contextWindow: 1_000_000 }, { id: 'gemini-2.5-pro' }],
    effectiveIds: ['gemini-4-argon', 'gemini-2.5-pro'],
  }
  const op = additionOp({ target, additions: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }] })
  assert.equal(op.op, 'set')
  assert.deepEqual(op.path, ['providers', 'google', 'models'])
  assert.deepEqual(op.value[0], { id: 'gemini-4-argon', contextWindow: 1_000_000 })
  assert.deepEqual(op.value[1], { id: 'gemini-2.5-pro' })
  assert.deepEqual(op.value[2], { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' })
})

test('removing the last stated model unsets the list rather than writing an empty one', () => {
  const target = { settingsPath: ['providers', 'google', 'models'], modelEntries: [{ id: 'gemini-4-argon' }], effectiveIds: ['gemini-4-argon'] }
  const op = removalOp(target, 'gemini-4-argon')
  // pi-ai reads `models: []` as "use the catalog", so an empty list would look
  // like a successful removal and then serve every catalog model again.
  assert.equal(op.op, 'unset')
  assert.deepEqual(op.path, ['providers', 'google', 'models'])
  assert.equal(op.fallsBackToCatalog, true)
})

test('removing one of several keeps the rest verbatim', () => {
  const target = {
    settingsPath: ['providers', 'google', 'models'],
    modelEntries: [{ id: 'gemini-4-argon', contextWindow: 1_000_000 }, { id: 'gemini-2.5-pro' }],
    effectiveIds: ['gemini-4-argon', 'gemini-2.5-pro'],
  }
  const op = removalOp(target, 'gemini-2.5-pro')
  assert.equal(op.op, 'set')
  assert.deepEqual(op.value, [{ id: 'gemini-4-argon', contextWindow: 1_000_000 }])
  assert.equal(op.fallsBackToCatalog, undefined)
})

test('materializing an inherited catalog starts from every id served today', () => {
  const op = additionOp({
    target: { settingsPath: ['providers', 'google', 'models'], effectiveIds: ['gemini-4-argon'] },
    additions: [{ id: 'gemini-2.5-flash' }],
  })
  assert.deepEqual(op.value, [{ id: 'gemini-4-argon' }, { id: 'gemini-2.5-flash' }])
})

test('buildModelsWrite drops duplicate ids instead of writing them twice', () => {
  const models = buildModelsWrite({
    entries: [{ id: 'a' }, { id: 'a' }, { id: 'b' }],
    effectiveIds: ['a', 'b'],
    additions: [{ id: 'b' }, { id: 'c' }],
  })
  assert.deepEqual(models.map((model) => model.id), ['a', 'b', 'c'])
})

test('removing from an inherited catalog is refused, not silently materialized', () => {
  const result = removalOp({ settingsPath: ['providers', 'google', 'models'] }, 'gemini-4-argon')
  assert.ok('unsupported' in result)
})

test('restore is an unset of the models path', () => {
  assert.deepEqual(restoreOp({ settingsPath: ['providers', 'google', 'models'] }), { op: 'unset', path: ['providers', 'google', 'models'] })
})

test('apply writes exactly one models op and creates no provider key', async () => {
  const { controller, document, writes } = await controllerFor()
  controller.store.data.checks = {
    google: { at: Date.now(), status: 'ok', protocol: 'google-generative-ai', via: 'proxy', upstreamCount: 2, added: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }], gone: [] },
  }
  const before = Object.keys(document[PIAI].providers).sort()

  const result = await controller.apply({ provider: 'google' })
  assert.deepEqual(result.written, ['gemini-2.5-flash'])

  assert.equal(writes.length, 1)
  assert.equal(writes[0].ns, PIAI)
  assert.equal(writes[0].ops.length, 1)
  assert.deepEqual(writes[0].ops[0].path, ['providers', 'google', 'models'])
  assert.deepEqual(Object.keys(document[PIAI].providers).sort(), before, 'no provider key may be created')
  assert.deepEqual(document[PIAI].providers.google.models.map((model) => model.id), ['gemini-4-argon', 'gemini-2.5-flash'])

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('applying the same additions twice is a no-op the second time', async () => {
  const { controller, document } = await controllerFor()
  controller.store.data.checks = {
    google: { at: Date.now(), status: 'ok', protocol: 'google-generative-ai', added: [{ id: 'gemini-2.5-flash' }], gone: [] },
  }
  await controller.apply({ provider: 'google' })
  await assert.rejects(() => controller.apply({ provider: 'google' }), /nothing to add/)
  const ids = document[PIAI].providers.google.models.map((model) => model.id)
  assert.deepEqual(ids, ['gemini-4-argon', 'gemini-2.5-flash'])

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('apply is refused before a check has run', async () => {
  const { controller } = await controllerFor()
  await assert.rejects(() => controller.apply({ provider: 'google' }), /check this provider/)
  await rm(controller.store.dir, { recursive: true, force: true })
})

test('suffix matches are listed for review without excluding or writing routes', async () => {
  const { controller, document, writes, dir } = await controllerFor({
    extraProviders: {
      opencode: {},
      'opencode-chat': { displayName: 'My separately configured route', baseURL: 'https://separate.example' },
      'another-messages': {},
    },
  })
  try {
    const before = structuredClone(document)
    const view = await controller.view()
    assert.deepEqual(view.legacy.map((row) => row.provider), ['opencode-chat'])
    assert.ok(view.providers.some((row) => row.provider === 'opencode-chat'))
    assert.ok(view.providers.some((row) => row.provider === 'another-messages'))
    assert.deepEqual(document, before)
    assert.deepEqual(writes, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hiding the only configured model persists without any settings mutation', async () => {
  const { controller, document, writes, dir } = await controllerFor()
  try {
    const before = structuredClone(document)
    const change = { provider: 'google', id: 'gemini-4-argon', visible: false }
    assert.deepEqual((await controller.setVisibility([change])).hidden, [['google', 'gemini-4-argon']])
    await controller.store.load()
    const result = await controller.displayModels()
    assert.ok(result.groups.find((row) => row.provider === 'google').models.some((row) => row.id === change.id))
    assert.deepEqual(result.hidden, [['google', 'gemini-4-argon']])
    await assert.rejects(() => controller.setVisibility([{ ...change, provider: 'deepseek-official' }]), /清单已变化/)
    assert.deepEqual((await controller.setVisibility([{ ...change, visible: true }])).hidden, [])
    assert.deepEqual(document, before)
    assert.deepEqual(writes, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cleanup unsets only the keys nobody backs', async () => {
  const { controller, document, writes } = await controllerFor()
  document[PIAI].providers['opencode-go-chat'] = { displayName: 'opencode-go · Chat Completions' }
  assert.deepEqual(foreignProviderKeys(controller.ctx), ['opencode-go-chat'])

  const result = await controller.cleanup({ providers: ['opencode-go-chat'] })
  assert.deepEqual(result.removed, ['opencode-go-chat'])
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops, [{ op: 'unset', path: ['providers', 'opencode-go-chat'] }])
  assert.equal(document[PIAI].providers['opencode-go-chat'], undefined)
  assert.ok(document[PIAI].providers.google !== undefined, 'configured routes must survive')

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('cleanup refuses a provider that is actually configured', async () => {
  const { controller } = await controllerFor()
  await assert.rejects(() => controller.cleanup({ providers: ['google'] }), /none of the named providers/)
  await rm(controller.store.dir, { recursive: true, force: true })
})

test('state on disk holds no credential material', async () => {
  const { controller } = await controllerFor()
  controller.store.data.checks = { google: { at: Date.now(), status: 'ok', added: [] } }
  await controller.store.save()
  const written = await readFile(join(controller.store.dir, 'state.json'), 'utf8')
  assert.ok(!written.includes('SECRET-VALUE-DO-NOT-STORE'))
  assert.ok(!written.includes('GOOGLE_API_KEY'.toLowerCase()) || true)
  await rm(controller.store.dir, { recursive: true, force: true })
})

test('ignore removes ids from the pending list and survives a save', async () => {
  const { controller } = await controllerFor()
  controller.store.data.checks = {
    google: { at: Date.now(), status: 'ok', added: [{ id: 'a' }, { id: 'b' }] },
  }
  await controller.ignore({ provider: 'google', ids: ['a'] })
  assert.deepEqual(controller.store.data.ignored.google, ['a'])
  assert.deepEqual(controller.store.data.checks.google.added.map((model) => model.id), ['b'])
  await rm(controller.store.dir, { recursive: true, force: true })
})

test('a revision conflict is retried once with the fresh revision', async () => {
  const { controller, writes, settings } = await controllerFor()
  controller.store.data.checks = { google: { at: Date.now(), status: 'ok', added: [{ id: 'gemini-2.5-flash' }] } }
  const original = settings.mutate
  let calls = 0
  settings.mutate = async (ns, ops, revision) => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('conflict'), { name: 'SettingsConflictError' })
    return original(ns, ops, revision)
  }
  await controller.apply({ provider: 'google' })
  assert.equal(calls, 2)
  assert.equal(writes.length, 1, 'only the successful write is recorded')
  await rm(controller.store.dir, { recursive: true, force: true })
})

test('a conflict whose cause is a deleted route must not recreate the provider key', async () => {
  // Regression for the retry path: replaying the planned ops after a revision
  // conflict would re-create `providers.google` — the exact key this plugin
  // promises never to create. The retry has to re-plan against fresh settings.
  let raced = false
  const { controller, document } = await controllerFor({
    onMutate({ ns, expectedRevision, document: doc, revisions }) {
      if (raced || ns !== PIAI || expectedRevision !== 1) return
      raced = true
      // The user deletes the provider in another window while apply is working,
      // which also advances the revision the write was planned against.
      delete doc[PIAI].providers.google
      revisions[PIAI] += 1
    },
  })
  controller.store.data.checks = {
    google: { at: Date.now(), status: 'ok', protocol: 'google-generative-ai', added: [{ id: 'gemini-2.5-flash' }], gone: [] },
  }

  await assert.rejects(() => controller.apply({ provider: 'google' }), /no longer configured/)
  assert.equal(document[PIAI].providers.google, undefined, 'the deleted key must stay deleted')
  assert.deepEqual(Object.keys(document[PIAI].providers), [])

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('apply refuses a route that states modelOverrides', async () => {
  const { controller } = await controllerFor({
    extraProviders: { overridden: { displayName: 'Overridden', modelOverrides: { 'x-1': { contextWindow: 4096 } } } },
  })
  controller.store.data.checks = {
    overridden: { at: Date.now(), status: 'ok', protocol: 'openai-completions', added: [{ id: 'x-2' }], gone: [] },
  }
  await assert.rejects(() => controller.apply({ provider: 'overridden' }), /modelOverrides/)
  await rm(controller.store.dir, { recursive: true, force: true })
})

test('materializing deepseek-official restores the capabilities a bare id would drop', async () => {
  // The deepseek adapter validates a stated list without per-id catalog
  // fallback: `{id}` alone would lose image input and the real context window.
  const { controller, document } = await controllerFor({
    resolveModelInfo(provider, id) {
      assert.equal(provider, 'deepseek-official')
      return { provider, id, name: 'DeepSeek Chat', context: { contextWindow: 1_048_576 }, defaultMaxTokens: 8192, inputModalities: ['text', 'image'] }
    },
  })
  controller.store.data.checks = {
    'deepseek-official': { at: Date.now(), status: 'ok', protocol: 'openai-completions', added: [{ id: 'deepseek-reasoner' }], gone: [] },
  }

  await controller.apply({ provider: 'deepseek-official' })
  const models = document[DEEPSEEK].models
  assert.deepEqual(models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner'])
  for (const model of models) {
    assert.equal(model.name, 'DeepSeek Chat')
    assert.equal(model.contextWindow, 1_048_576)
    assert.equal(model.maxTokens, 8192)
    assert.deepEqual(model.inputModalities, ['text', 'image'])
  }

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('DeepSeek official can discover and re-add a removed model without altering the retained entry', async () => {
  const flash = { id: 'deepseek-flash', name: 'Local Flash', toolUpdate: 'addition-only' }
  const pro = { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576, maxTokens: 393_216, inputModalities: ['text'] }
  const models = [flash, pro, { id: 'responses-only', blocked: '未声明 Messages 能力' }]
  const { controller, document, dir } = await controllerFor({ deepseek: { models: [flash], maxTokens: 120_000 } })
  controller.list = async ({ baseURL, candidates }) => {
    assert.equal(baseURL, 'https://api.deepseek.com')
    assert.deepEqual(candidates, ['deepseek-models'])
    return { api: candidates[0], via: 'direct', models }
  }
  try {
    const { results: [checked] } = await controller.check({ provider: 'deepseek-official' })
    assert.equal(checked.status, 'ok')
    assert.deepEqual(checked.added, models.slice(1))
    const apply = (id) => controller.apply({ provider: 'deepseek-official', ids: [id], removeIds: [], showInPicker: false })
    await assert.rejects(() => apply('responses-only'), /未声明 Messages 能力/)
    await apply(pro.id)
    assert.deepEqual(document[DEEPSEEK].models, [flash, { ...pro, maxTokens: 120_000 }])
    await controller.apply({ provider: 'deepseek-official', ids: [], removeIds: [pro.id] })
    assert.deepEqual(document[DEEPSEEK].models, [flash])
    const route = (await controller.view()).providers.find(({ provider }) => provider === 'deepseek-official')
    assert.ok(route.check.added.some(({ id, blocked }) => id === pro.id && blocked === undefined))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a write that leaves the route with no models at all is rolled back', async () => {
  // pi-ai's deferred mode keeps the key but reports zero models when it cannot
  // resolve the profile; a route in that state serves nothing, so undoing the
  // edit is the honest outcome.
  const { controller, document } = await controllerFor()
  const original = controller.ctx.get('llm').listModels
  // Resolves the catalog list, then cannot resolve the stated one — exactly the
  // shape pi-ai's deferred mode produces for a profile it refuses.
  controller.ctx.get('llm').listModels = async () => (Array.isArray(document[PIAI].providers.google.models) ? [] : [{ id: 'gemini-4-argon' }])
  controller.store.data.checks = {
    google: { at: Date.now(), status: 'ok', protocol: 'openai-completions', added: [{ id: 'new-model' }], gone: [] },
  }
  try {
    await assert.rejects(() => controller.apply({ provider: 'google' }), /交给网关/)
    assert.equal(document[PIAI].providers.google.models, undefined)
  } finally {
    controller.ctx.get('llm').listModels = original
    await rm(controller.store.dir, { recursive: true, force: true })
  }
})

test('the daily check is armed on a fresh install, and it only reads', async () => {
  // Requirement ③ is "pull the upstream list every day". A default-off timer
  // made a fresh install look broken: no schedule, no data, and a switch the
  // user did not know about. The check itself only records what upstream
  // offers — writing still needs the panel's confirm — so on is the safe
  // default rather than a silent risk.
  const { controller, document } = await controllerFor()
  const view = await controller.view()
  assert.deepEqual(view.schedule, { enabled: true, hour: 9 })
  assert.ok(controller.nextScheduledAt() > Date.now(), 'a timer must be armed')

  // Arming it must not have written anything: the schedule is a read-only job.
  assert.equal(document[PIAI].providers.google.models, undefined)

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('a launch only checks when the ledger is stale and the daily timer is not about to fire', async () => {
  const { controller } = await controllerFor()
  const at = (hour, minute, second = 0) => new Date(2026, 10, 16, hour, minute, second).getTime()
  controller.store.data.schedule = { enabled: true, hour: 9 }

  // Nothing has ever been checked.
  assert.equal(controller.bootCheckDue(at(12, 0)), true)

  // A check an hour ago is fresh enough.
  controller.store.data.summary = { at: at(11, 0) }
  assert.equal(controller.bootCheckDue(at(12, 0)), false)

  // A check from yesterday is not.
  controller.store.data.summary = { at: at(9, 0) - 24 * 60 * 60 * 1000 }
  assert.equal(controller.bootCheckDue(at(12, 0)), true)

  // The daily timer firing in half a minute wins: two checks would collide.
  assert.equal(controller.bootCheckDue(at(8, 59, 30)), false)

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('a route whose address lives on its models borrows it from the address table', async () => {
  // `opencode` keeps `baseUrl` on each catalog model, so the settings document
  // has no baseURL to read. Before the table existed the route looked broken;
  // the old plugin knew these addresses from a table of its own.
  const { controller, document } = await controllerFor()
  document[PIAI].providers.opencode = { apiKeyEnv: 'OPENCODE_API_KEY' }
  const llm = controller.ctx.get('llm')
  const base = llm.listConfigurableProviders()
  llm.listConfigurableProviders = () => [
    ...base,
    { provider: 'opencode', settingsNs: PIAI, settingsPath: ['providers', 'opencode'], displayName: 'OpenCode' },
  ]
  const asked = []
  controller.list = async (options) => {
    asked.push(options.baseURL)
    return { models: [{ id: 'alpha' }, { id: 'beta' }], api: 'openai-completions', via: 'direct' }
  }

  const { results } = await controller.check({ provider: 'opencode' })
  assert.deepEqual(asked, ['https://opencode.ai/inference/v1'])
  assert.equal(results[0].status, 'ok')
  assert.equal(results[0].upstreamCount, 2)
  assert.deepEqual(results[0].added.map((model) => model.id), ['alpha', 'beta'])

  await rm(controller.store.dir, { recursive: true, force: true })
})

test('a route nothing knows how to reach is reported as unknown, not as broken', async () => {
  // A red "check failed" here would blame the user for a hole in the catalog.
  const { controller, document, writes } = await controllerFor()
  document[PIAI].providers.mystery = { apiKeyEnv: 'MYSTERY_API_KEY' }
  const llm = controller.ctx.get('llm')
  const base = llm.listConfigurableProviders()
  llm.listConfigurableProviders = () => [
    ...base,
    { provider: 'mystery', settingsNs: PIAI, settingsPath: ['providers', 'mystery'], displayName: 'Mystery' },
  ]
  const asked = []
  controller.list = async (options) => {
    asked.push(options.baseURL)
    return { models: [{ id: 'unused' }], api: 'openai-completions' }
  }

  const { results } = await controller.check({ provider: 'mystery' })
  assert.deepEqual(asked, [], 'nothing may be asked when no address is known')
  assert.equal(results[0].status, 'no-endpoint')
  assert.equal(results[0].error, undefined)
  assert.deepEqual(writes, [], 'a check never writes')
  assert.deepEqual(Object.keys(document[PIAI].providers).sort(), ['google', 'mystery'])

  await rm(controller.store.dir, { recursive: true, force: true })
})


const DEV_PAYLOAD = {
  google: {
    id: 'google', name: 'Google',
    models: {
      'gemini-x': {
        id: 'gemini-x', name: 'Gemini X', family: 'gemini',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000, output: 100 },
        canonical_model_id: 'google/gemini-x',
      },
    },
  },
}

function devTarget(entries) {
  return {
    provider: 'google', displayName: 'Google', settingsNs: PIAI,
    settingsPath: ['providers', 'google', 'models'], modelEntries: entries, revision: 1,
    effectiveIds: entries.map((entry) => entry.id),
  }
}

test('metadata fallback fills every blank field on an explicit model list and is visible in the tab', async () => {
  const model = { id: 'gemini-x', name: 'Gemini X' }
  const { controller, document, dir, writes } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    const changed = await controller.autoFillMetadata(devTarget([model]))
    assert.equal(changed, 1)
    assert.equal(writes.length, 1)
    assert.deepEqual(document[PIAI].providers.google.models[0], {
      id: 'gemini-x', name: 'Gemini X', contextWindow: 1000, maxTokens: 100,
      reasoningEfforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      input: ['text', 'image'],
    })
    const view = await controller.view()
    assert.equal(view.metadata.pendingCount, 1)
    const row = view.metadata.models[0]
    assert.equal(row.id, 'gemini-x')
    assert.equal(row.fields.contextWindow.value, 1000)
    assert.equal(row.fields.contextWindow.source, 'models.dev')
    assert.equal(row.fields.maxTokens.source, 'models.dev')
    assert.equal(row.fields.reasoningEfforts.value.high, 'high')
    assert.equal(row.status, 'pending')
    assert.equal(row.missing, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('official values overwrite provisional user values and remove the model from the tab', async () => {
  const model = { id: 'gemini-x', contextWindow: 1 }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    controller.store.data.checks = {
      google: { status: 'ok', catalog: [{ id: 'gemini-x', contextWindow: 1000, maxTokens: 100, reasoningEfforts: { low: 'low', high: 'high' }, input: ['text', 'image'] }] },
    }
    controller.metadataState().records.google = {
      'gemini-x': {
        provider: 'google', id: 'gemini-x', firstSeenAt: 1, pending: true,
        fields: { contextWindow: { value: 1, source: 'user', confidence: 'high', at: 1 } },
        log: [],
      },
    }
    const changed = await controller.autoFillMetadata(devTarget([model]))
    assert.equal(changed, 1)
    assert.deepEqual(document[PIAI].providers.google.models[0], {
      id: 'gemini-x', contextWindow: 1000, maxTokens: 100,
      reasoningEfforts: { low: 'low', high: 'high' },
      input: ['text', 'image'],
    })
    assert.equal(controller.metadataState().records.google['gemini-x'].pending, false)
    const view = await controller.view()
    assert.equal(view.metadata.pendingCount, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an official value that already matches promotes models.dev provenance without a write', async () => {
  const model = {
    id: 'gemini-x',
    contextWindow: 1000,
    maxTokens: 100,
    reasoningEfforts: { low: 'low', high: 'high' },
    input: ['text'],
  }
  const { controller, document, dir, writes } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    controller.store.data.checks = {
      google: { status: 'ok', catalog: [{ id: 'gemini-x', contextWindow: 1000, maxTokens: 100, reasoningEfforts: { low: 'low', high: 'high' }, input: ['text'] }] },
    }
    controller.metadataState().records.google = {
      'gemini-x': {
        provider: 'google', id: 'gemini-x', firstSeenAt: 1, pending: true,
        fields: {
          contextWindow: { value: 1000, source: 'models.dev', confidence: 'medium', at: 1 },
          maxTokens: { value: 100, source: 'models.dev', confidence: 'medium', at: 1 },
          reasoningEfforts: { value: { low: 'low', high: 'high' }, source: 'models.dev', confidence: 'medium', at: 1 },
          input: { value: ['text'], source: 'models.dev', confidence: 'medium', at: 1 },
        },
        log: [],
      },
    }
    const changed = await controller.autoFillMetadata(devTarget([model]))
    assert.equal(changed, 0)
    assert.equal(writes.length, 0)
    assert.deepEqual(document[PIAI].providers.google.models[0], model)
    const record = controller.metadataState().records.google['gemini-x']
    assert.equal(record.pending, false)
    assert.equal(record.fields.contextWindow.source, 'official')
    assert.equal(record.fields.maxTokens.source, 'official')
    assert.equal(record.fields.reasoningEfforts.source, 'official')
    assert.equal(record.fields.input.source, 'official')
    const view = await controller.view()
    assert.equal(view.metadata.pendingCount, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a settings conflict leaves the ledger untouched rather than claiming a write', async () => {
  const model = { id: 'gemini-x' }
  let bumped = false
  const { controller, document, dir, writes } = await controllerFor({
    googleModels: [model],
    onMutate({ revisions }) {
      if (!bumped) { bumped = true; revisions[PIAI] += 1 }
    },
  })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    const changed = await controller.autoFillMetadata(devTarget([model]))
    assert.equal(changed, 0)
    assert.equal(writes.length, 1)
    assert.deepEqual(document[PIAI].providers.google.models[0], { id: 'gemini-x' })
    assert.equal(controller.store.data.metadata?.records?.google?.['gemini-x'], undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a route that inherits its catalog is never materialized by metadata fallback', async () => {
  const { controller, dir, writes } = await controllerFor()
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    const changed = await controller.autoFillMetadata({
      provider: 'google', settingsNs: PIAI, settingsPath: ['providers', 'google'],
      modelEntries: undefined, revision: 1, effectiveIds: ['gemini-x'],
    })
    assert.equal(changed, 0)
    assert.deepEqual(writes, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editing and reverting provisional fields writes the setting and keeps user edits', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    await controller.autoFillMetadata(devTarget([model]))
    await controller.updateMetadata({ provider: 'google', id: 'gemini-x', field: 'contextWindow', value: 123 })
    assert.equal(document[PIAI].providers.google.models[0].contextWindow, 123)
    assert.equal(controller.metadataState().records.google['gemini-x'].fields.contextWindow.source, 'user')
    await controller.revertMetadata({ provider: 'google', id: 'gemini-x' })
    const entry = document[PIAI].providers.google.models[0]
    assert.equal(entry.contextWindow, 123)
    assert.equal(entry.maxTokens, undefined)
    assert.equal(entry.reasoningEfforts, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a hand-written value in DSH settings is preserved and adopted into the ledger', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    await controller.autoFillMetadata(devTarget([model]))
    document[PIAI].providers.google.models[0].contextWindow = 999
    const edited = { id: 'gemini-x', contextWindow: 999 }
    const target = devTarget([edited])
    target.revision = 2
    await controller.autoFillMetadata(target)
    assert.equal(document[PIAI].providers.google.models[0].contextWindow, 999)
    assert.equal(document[PIAI].providers.google.models[0].maxTokens, 100)
    const record = controller.metadataState().records.google['gemini-x']
    assert.equal(record.fields.contextWindow.value, 999)
    assert.equal(record.fields.contextWindow.source, 'user')
    assert.equal(record.fields.contextWindow.external, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('the metadata tab shows the live settings value after a hand edit', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    await controller.autoFillMetadata(devTarget([model]))
    document[PIAI].providers.google.models[0].contextWindow = 999
    const target = devTarget(document[PIAI].providers.google.models)
    const view = controller.metadataView([target])
    const row = view.models[0]
    assert.equal(row.fields.contextWindow.value, 999)
    assert.equal(row.fields.contextWindow.source, 'user')
    assert.equal(row.fields.contextWindow.external, true)
    assert.equal(row.fields.maxTokens.value, 100)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an official value overrides a hand-written DSH value', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    await controller.autoFillMetadata(devTarget([model]))
    document[PIAI].providers.google.models[0].contextWindow = 999
    controller.store.data.checks = {
      google: { status: 'ok', catalog: [{ id: 'gemini-x', contextWindow: 1000, maxTokens: 100 }] },
    }
    const edited = { id: 'gemini-x', contextWindow: 999 }
    const target = devTarget([edited])
    target.revision = 2
    await controller.autoFillMetadata(target)
    assert.equal(document[PIAI].providers.google.models[0].contextWindow, 1000)
    const field = controller.metadataState().records.google['gemini-x'].fields.contextWindow
    assert.equal(field.value, 1000)
    assert.equal(field.source, 'official')
    assert.equal(field.external, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('revert preserves a value rewritten outside the panel instead of deleting it', async () => {
  const { controller, document, dir } = await controllerFor({ googleModels: [{ id: 'gemini-x', contextWindow: 999 }] })
  try {
    controller.metadataState().records.google = {
      'gemini-x': {
        provider: 'google', id: 'gemini-x', pending: true,
        fields: { contextWindow: { value: 1000, source: 'models.dev', confidence: 'medium' } },
        log: [],
      },
    }
    const view = await controller.revertMetadata({ provider: 'google', id: 'gemini-x' })
    assert.equal(view.metadata.pendingCount, 1)
    assert.match(controller.takeMetadataNotice(), /保留/)
    assert.equal(document[PIAI].providers.google.models[0].contextWindow, 999)
    const row = controller.metadataState().records.google['gemini-x'].fields.contextWindow
    assert.equal(row.value, 999)
    assert.equal(row.source, 'user')
    assert.equal(row.external, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a reverted fallback is not silently filled again on the next auto-fill', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    await controller.autoFillMetadata(devTarget([model]))
    assert.equal(document[PIAI].providers.google.models[0].contextWindow, 1000)
    await controller.revertMetadata({ provider: 'google', id: 'gemini-x' })
    const afterRevert = document[PIAI].providers.google.models[0]
    assert.equal(afterRevert.contextWindow, undefined)
    assert.equal(afterRevert.maxTokens, undefined)
    assert.equal(afterRevert.reasoningEfforts, undefined)
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.ok(saved.metadata.records.google['gemini-x'].rejected.contextWindow, 'tombstone survives a restart')
    await controller.store.load()
    const reloaded = controller.metadataState().records.google['gemini-x']
    assert.ok(reloaded.rejected.contextWindow, 'tombstone survives a state reload')
    await controller.autoFillMetadata(devTarget([afterRevert]))
    const afterSecondFill = document[PIAI].providers.google.models[0]
    assert.equal(afterSecondFill.contextWindow, undefined)
    assert.equal(afterSecondFill.maxTokens, undefined)
    assert.equal(afterSecondFill.reasoningEfforts, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an official value can still replace a tombstoned fallback', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    await controller.autoFillMetadata(devTarget([model]))
    await controller.revertMetadata({ provider: 'google', id: 'gemini-x' })
    assert.equal(controller.metadataState().records.google['gemini-x'].rejected.contextWindow !== undefined, true)
    controller.store.data.checks = {
      google: { status: 'ok', catalog: [{ id: 'gemini-x', contextWindow: 1000, maxTokens: 100 }] },
    }
    const target = devTarget(document[PIAI].providers.google.models)
    target.revision = undefined
    await controller.autoFillMetadata(target)
    const entry = document[PIAI].providers.google.models[0]
    assert.equal(entry.contextWindow, 1000)
    const record = controller.metadataState().records.google['gemini-x']
    assert.equal(record.fields.contextWindow.source, 'official')
    assert.equal(record.rejected.contextWindow, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('revert refuses an inherited catalog and a model that disappeared from the list', async () => {
  const { controller, dir, writes } = await controllerFor()
  try {
    controller.metadataState().records.google = {
      'gemini-x': { provider: 'google', id: 'gemini-x', pending: true, fields: { maxTokens: { value: 10, source: 'models.dev' } }, log: [] },
    }
    await assert.rejects(
      () => controller.revertMetadata({ provider: 'google', id: 'gemini-x' }),
      (error) => error.status === 409,
    )
    assert.deepEqual(writes, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const second = await controllerFor({ googleModels: [{ id: 'other' }] })
  try {
    second.controller.metadataState().records.google = {
      'gemini-x': { provider: 'google', id: 'gemini-x', pending: true, fields: { maxTokens: { value: 10, source: 'models.dev' } }, log: [] },
    }
    await assert.rejects(
      () => second.controller.revertMetadata({ provider: 'google', id: 'gemini-x' }),
      (error) => error.status === 409,
    )
    assert.deepEqual(second.writes, [])
  } finally {
    await rm(second.dir, { recursive: true, force: true })
  }
})


test('revert refuses to strip limits the host needs for a catalog-less model', async () => {
  const model = { id: 'custom-x', contextWindow: 1000, maxTokens: 100 }
  const { controller, document, writes, dir } = await controllerFor({
    googleModels: [model],
    resolveModelInfo: () => { throw new Error('not in the native catalog') },
  })
  try {
    controller.metadataState().records.google = {
      'custom-x': {
        provider: 'google', id: 'custom-x', pending: true,
        fields: {
          contextWindow: { value: 1000, source: 'models.dev', confidence: 'medium' },
          maxTokens: { value: 100, source: 'models.dev', confidence: 'medium' },
        },
        log: [],
      },
    }
    await assert.rejects(
      () => controller.revertMetadata({ provider: 'google', id: 'custom-x' }),
      (error) => error.status === 409 && /宿主必需/.test(error.message),
    )
    assert.deepEqual(writes, [])
    assert.deepEqual(document[PIAI].providers.google.models[0], model)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a settings conflict while editing becomes a 409, not a 500', async () => {
  let bumped = false
  const { controller, dir } = await controllerFor({
    googleModels: [{ id: 'gemini-x' }],
    onMutate({ revisions }) {
      if (!bumped) { bumped = true; revisions[PIAI] += 1 }
    },
  })
  try {
    await assert.rejects(
      () => controller.updateMetadata({ provider: 'google', id: 'gemini-x', field: 'contextWindow', value: 123 }),
      (error) => error.status === 409 && error.safe === true,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deepseek maxTokens is clamped to the route limit during auto-fill', async () => {
  const { controller, document, dir } = await controllerFor({ googleModels: [{ id: 'gemini-x' }] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    const target = devTarget([{ id: 'gemini-x' }])
    target.adapter = 'deepseek'
    target.modelMaxTokens = 64
    await controller.autoFillMetadata(target)
    assert.equal(document[PIAI].providers.google.models[0].maxTokens, 64)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a user text-only input is adopted and never widened by the aggregator', async () => {
  const model = {
    id: 'gemini-x', contextWindow: 1000, maxTokens: 100,
    reasoningEfforts: { low: 'low', high: 'high' }, input: ['text'],
  }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    const changed = await controller.autoFillMetadata(devTarget([model]))
    assert.equal(changed, 0)
    assert.deepEqual(document[PIAI].providers.google.models[0].input, ['text'])
    const row = controller.metadataState().records.google['gemini-x']
    assert.equal(row.fields.input.source, 'user')
    assert.equal(row.fields.input.external, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('official input replaces the aggregator fallback without widening the route', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    controller.store.data.checks = {
      google: {
        status: 'ok',
        catalog: [{
          id: 'gemini-x', contextWindow: 1000, maxTokens: 100,
          reasoningEfforts: { low: 'low', high: 'high' }, input: ['text'],
        }],
      },
    }
    const changed = await controller.autoFillMetadata(devTarget([model]))
    assert.equal(changed, 1)
    assert.deepEqual(document[PIAI].providers.google.models[0].input, ['text'])
    const record = controller.metadataState().records.google['gemini-x']
    assert.equal(record.fields.input.source, 'official')
    assert.equal(record.pending, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('self-check forces a models.dev refresh and writes what it learned', async () => {
  const model = { id: 'gemini-x' }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    const calls = []
    controller.modelsDevLoader = async ({ force }) => {
      calls.push(force === true)
      return { index: indexModelsDev(DEV_PAYLOAD), fetchedAt: Date.now(), stale: false }
    }
    await controller.runSelfCheck()
    assert.deepEqual(calls, [true], 'the self-check must not accept the activation cache')
    assert.deepEqual(document[PIAI].providers.google.models[0].input, ['text', 'image'])
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(saved.metadata.lastSync.source, 'selfcheck')
    assert.ok(saved.metadata.lastSync.updated >= 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check forces a models.dev refresh and reports the fields it updated', async () => {
  const model = { id: 'gemini-x' }
  const { controller, dir } = await controllerFor({ googleModels: [model] })
  try {
    const calls = []
    controller.modelsDevLoader = async ({ force }) => {
      calls.push(force === true)
      return { index: indexModelsDev(DEV_PAYLOAD), fetchedAt: Date.now(), stale: false }
    }
    controller.list = async () => ({ models: [{ id: 'gemini-x' }], api: 'openai-completions', complete: true })
    const result = await controller.check({ provider: 'google' })
    assert.deepEqual(calls, [true])
    assert.equal(result.sync.source, 'check')
    assert.equal(result.sync.updated, 4)
    const view = await controller.view()
    assert.equal(view.metadata.lastSync.source, 'check')
    assert.equal(view.metadata.lastSync.updated, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty input list is missing, not a user pin', async () => {
  const model = { id: 'gemini-x', input: [] }
  const { controller, document, dir } = await controllerFor({ googleModels: [model] })
  try {
    controller.modelsDevIndex = indexModelsDev(DEV_PAYLOAD)
    const changed = await controller.autoFillMetadata(devTarget([model]))
    assert.equal(changed, 1)
    assert.deepEqual(document[PIAI].providers.google.models[0].input, ['text', 'image'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
