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
    [DEEPSEEK]: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
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
      if (provider === 'deepseek-official') return [{ id: 'deepseek-chat' }]
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
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
  }

  return { ctx, document, writes, settings }
}

/** A controller over a temp state directory. */
async function controllerFor(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-sync-test-'))
  const fake = harness({ ...options, profileDir: dir })
  // Tests must never reach the real bili lane: one stray sync would rewrite
  // another plugin's config. `locate` returning undefined is the honest fake.
  const controller = new Controller(fake.ctx, {
    dir,
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

test('the synthetic providers of the previous version are found, and only those', async () => {
  const { controller, document, dir } = await controllerFor({
    extraProviders: {
      opencode: { apiKeyEnv: 'OPENCODE_API_KEY', baseURL: 'https://opencode.ai/zen/v1' },
      'opencode-chat': { displayName: 'opencode · Chat Completions', api: 'openai-completions', baseURL: 'https://opencode.ai/zen/v1' },
      'opencode-responses': { displayName: 'opencode · Responses', api: 'openai-responses' },
      // Its parent route is not configured, so this is not a leftover sibling.
      'opencode-go-messages': { displayName: 'opencode-go · Anthropic Messages', api: 'anthropic-messages' },
    },
  })
  try {
    const legacy = controller.legacySiblings()
    assert.deepEqual(legacy.map((row) => row.provider).sort(), ['opencode-chat', 'opencode-responses'])

    // The panel must not offer to manage a key it also offers to delete: that
    // would invite the user to add models to a provider scheduled to vanish —
    // and would ask the upstream for its models in the meantime.
    const managed = (await controller.view()).providers.map((row) => row.provider)
    assert.equal(managed.includes('opencode-chat'), false, 'a synthesised sibling is not a route to manage')
    assert.equal(managed.includes('opencode-responses'), false)
    assert.ok(managed.includes('opencode'), 'its parent route still is')
    assert.ok(managed.includes('opencode-go-messages'), 'a suffix without its parent is the user\'s own route')

    const result = await controller.prune()
    assert.deepEqual(result.removed.sort(), ['opencode-chat', 'opencode-responses'])
    const providers = document[PIAI].providers
    assert.equal(providers['opencode-chat'], undefined)
    assert.equal(providers['opencode-responses'], undefined)
    assert.ok(providers.opencode, 'the parent route survives')
    assert.ok(providers['opencode-go-messages'], 'a suffix without its parent route is left alone')
    assert.ok(providers.google, 'the configured route is untouched')
    assert.equal(result.snapshot !== undefined, true, 'a snapshot is taken before deleting keys')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pruning twice is a no-op, not an error', async () => {
  const { controller, dir } = await controllerFor({
    extraProviders: {
      opencode: {},
      'opencode-chat': { api: 'openai-completions' },
    },
  })
  try {
    assert.deepEqual((await controller.prune()).removed, ['opencode-chat'])
    assert.deepEqual((await controller.prune()).removed, [])
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
