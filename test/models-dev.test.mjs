import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  indexModelsDev,
  loadModelsDev,
  lookupModelsDev,
  metadataFor,
  modelsDevProvider,
  reasoningEffortsFromOptions,
} from '../lib/models-dev.js'

const payload = {
  google: {
    id: 'google',
    name: 'Google',
    models: {
      'gemini-x': {
        id: 'gemini-x',
        name: 'Gemini X',
        family: 'gemini',
        reasoning: true,
        reasoning_options: [
          { type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off'] },
          { type: 'toggle' },
          { type: 'budget_tokens' },
        ],
        modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
        limit: { context: 100, output: 10 },
        canonical_model_id: 'google/gemini-x',
      },
      'canonical-only': {
        id: 'canonical-only',
        family: 'gemini',
        modalities: { input: ['text', 'image'] },
        limit: { context: 777, output: 77 },
        canonical_model_id: 'google/canonical-only',
      },
    },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    models: {
      'gemini-x': {
        id: 'gemini-x',
        family: 'gemini',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        limit: { context: 200, output: 20 },
        canonical_model_id: 'google/gemini-x',
      },
    },
  },
}

test('provider aliases are explicit and narrow', () => {
  assert.equal(modelsDevProvider('deepseek-official'), 'deepseek')
  assert.equal(modelsDevProvider('google'), 'google')
  assert.equal(modelsDevProvider('unknown'), 'unknown')
})

test('reasoning effort options keep every DSH level and drop unsupported modes', () => {
  assert.deepEqual(
    reasoningEffortsFromOptions(payload.google.models['gemini-x'].reasoning_options),
    { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  )
  assert.equal(reasoningEffortsFromOptions([{ type: 'toggle' }]), undefined)
  assert.equal(reasoningEffortsFromOptions([{ type: 'budget_tokens', values: [1, 2] }]), undefined)
  assert.equal(reasoningEffortsFromOptions(undefined), undefined)
})

test('lookup is exact per provider and never borrows another route numbers', () => {
  const index = indexModelsDev(payload, 1234)
  assert.equal(lookupModelsDev(index, 'google', 'gemini-x')?.model.limit.context, 100)
  assert.equal(lookupModelsDev(index, 'openrouter', 'gemini-x')?.model.limit.context, 200)
  assert.equal(lookupModelsDev(index, 'reseller', 'gemini-x'), undefined)
  const google = metadataFor(index, 'google', 'gemini-x')
  const openrouter = metadataFor(index, 'openrouter', 'gemini-x')
  assert.equal(google?.contextWindow, 100)
  assert.equal(google?.maxTokens, 10)
  assert.equal(openrouter?.contextWindow, 200)
  assert.equal(openrouter?.maxTokens, 20)
  assert.equal(google?.confidence, 'medium')
  assert.equal(google?.exact, true)
  assert.equal(google?.family, 'gemini')
  assert.equal(google?.modality, '文本+图像+音频')
  assert.deepEqual(google?.input, ['text', 'image'])
  assert.equal(openrouter?.input, undefined)
})

test('canonical-only information is display-only, never numbers', () => {
  const index = indexModelsDev(payload, 1234)
  const meta = metadataFor(index, 'reseller', 'gemini-x')
  assert.equal(meta?.contextWindow, undefined)
  assert.equal(meta?.maxTokens, undefined)
  assert.equal(meta?.reasoningEfforts, undefined)
  assert.equal(meta?.family, 'gemini')
  assert.equal(meta?.modality, '文本+图像+音频')
  assert.equal(meta?.input, undefined)
  assert.equal(meta?.exact, false)
  assert.equal(meta?.confidence, 'low')
  const canonicalOnly = metadataFor(index, 'reseller', 'canonical-only')
  assert.equal(canonicalOnly?.contextWindow, undefined)
  assert.equal(canonicalOnly?.maxTokens, undefined)
  assert.equal(canonicalOnly?.input, undefined)
  assert.equal(canonicalOnly?.family, 'gemini')
})

test('canonical fallback keeps the first full and short matches independently', () => {
  const index = indexModelsDev({
    a: { models: { x: { family: 'first', canonical_model_id: 'a/same' } } },
    b: { models: { y: { family: 'second', canonical_model_id: 'b/same' } } },
    c: { models: { z: { family: 'third', canonical_model_id: 'same' } } },
  })
  assert.equal(metadataFor(index, 'other', 'same').family, 'first')
  assert.equal(metadataFor(index, 'other', 'a/same').family, 'first')
  assert.equal(metadataFor(index, 'other', 'b/same').family, 'second')
  assert.equal(metadataFor(index, 'c', 'z').family, 'third')
})

test('a fresh cache skips the network; force and stale fallback are explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'models-dev-test-'))
  const cachePath = join(dir, 'models.dev.json')
  try {
    let calls = 0
    const reply = { status: 200, json: payload }
    const fetch = async () => {
      calls += 1
      return reply
    }
    const first = await loadModelsDev({ cachePath, fetch, now: () => 1_000, ttlMs: 100 })
    assert.equal(calls, 1)
    assert.equal(first.stale, false)
    assert.equal(first.fromCache, false)
    assert.equal(first.index.providers.get('google')?.models.get('gemini-x')?.limit.context, 100)
    const second = await loadModelsDev({ cachePath, fetch, now: () => 1_050, ttlMs: 100 })
    assert.equal(calls, 1)
    assert.equal(second.fromCache, true)
    assert.equal(second.stale, false)
    const forced = await loadModelsDev({ cachePath, fetch, now: () => 1_060, ttlMs: 100, force: true })
    assert.equal(calls, 2)
    assert.equal(forced.fromCache, false)

    const failed = async () => { throw new Error('offline') }
    const stale = await loadModelsDev({ cachePath, fetch: failed, now: () => 9_000, ttlMs: 100 })
    assert.equal(stale.stale, true)
    assert.equal(stale.fromCache, true)
    assert.match(stale.error, /offline/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed first load without cache is an error, not an empty catalog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'models-dev-test-'))
  try {
    await assert.rejects(
      () => loadModelsDev({ cachePath: join(dir, 'models.dev.json'), fetch: async () => { throw new Error('offline') } }),
      /offline/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty cached payload is ignored and never suppresses the network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'models-dev-test-'))
  const cachePath = join(dir, 'models.dev.json')
  try {
    const { writeModelsDevCache } = await import('../lib/models-dev.js')
    await writeModelsDevCache(cachePath, {}, 5_000)
    let calls = 0
    const result = await loadModelsDev({
      cachePath,
      now: () => 5_100,
      ttlMs: 10_000,
      fetch: async () => { calls += 1; return { status: 200, json: payload } },
    })
    assert.equal(calls, 1)
    assert.equal(result.fromCache, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty live payload is an error and does not poison a good cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'models-dev-test-'))
  const cachePath = join(dir, 'models.dev.json')
  try {
    const { writeModelsDevCache } = await import('../lib/models-dev.js')
    await writeModelsDevCache(cachePath, payload, 1_000)
    const rejected = await loadModelsDev({
      cachePath, force: true, fetch: async () => ({
        status: 200, json: { provider: { models: { a: null, b: [], c: 'incomplete' } } },
      }),
    })
    assert.equal(rejected.fromCache, true)
    assert.equal(rejected.stale, true)
    assert.match(rejected.error, /empty catalog/)
    const stillGood = await loadModelsDev({
      cachePath,
      now: () => 99_000,
      ttlMs: 100,
      fetch: async () => { throw new Error('offline') },
    })
    assert.equal(stillGood.fromCache, true)
    assert.equal(metadataFor(stillGood.index, 'google', 'gemini-x').contextWindow, 100)
    assert.match(stillGood.error, /offline/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
