/**
 * Pure-function tests for the discovery layer: URL construction, response
 * shapes, and the redaction that keeps a credential-bearing baseURL out of
 * stored state and panel text.
 *
 * Run: node --test
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { authHeaders, listAll, listingUrl, readGeminiListing, readListing } from '../lib/discovery.js'
import { maskUrl } from '../lib/http.js'

test('listingUrl appends the protocol path after the base, not after its query', () => {
  // Gateways that take the key in the query string are common; appending the
  // path to the whole string would produce `/v1?key=…/models`, which nothing
  // answers.
  assert.equal(
    listingUrl('https://gw.example/v1?key=abc', 'openai-completions'),
    'https://gw.example/v1/models?key=abc',
  )
  assert.equal(
    listingUrl('https://gw.example/v1?key=abc', 'anthropic-messages'),
    'https://gw.example/v1/models?limit=1000&key=abc',
  )
  assert.equal(
    listingUrl('https://gw.example/v1beta?key=abc', 'google-generative-ai'),
    'https://gw.example/v1beta/models?pageSize=1000&key=abc',
  )
})

test('listingUrl normalizes the two Anthropic root spellings', () => {
  assert.equal(listingUrl('https://api.anthropic.com/v1', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(listingUrl('https://api.anthropic.com/', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000')
})

test('listingUrl supplies the Gemini version segment only when it is missing', () => {
  assert.equal(listingUrl('https://generativelanguage.googleapis.com', 'google-generative-ai'), 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
  assert.equal(
    listingUrl('https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai'),
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
  )
})

test('maskUrl keeps the shape and hides every query value', () => {
  assert.equal(maskUrl('https://gw.example/v1/models?key=secret&x=1'), 'https://gw.example/v1/models?key=***&x=***')
  assert.equal(maskUrl('https://gw.example/v1/models'), 'https://gw.example/v1/models')
  assert.equal(maskUrl('https://gw.example/m?flag'), 'https://gw.example/m?flag')
})

test('readListing accepts both documented shapes and skips unusable rows', () => {
  // A bare string row is not a model entry this plugin can write back, so it is
  // skipped rather than turned into `{ id: 'b' }`.
  const flat = readListing({ data: [{ id: 'a' }, { id: '' }, {}, 'b'] })
  assert.deepEqual(flat.map((model) => model.id), ['a'])

  const rich = readListing({ models: { 'c': { name: 'C', contextWindow: 8192 }, 'd': null } })
  assert.deepEqual(rich.map((model) => model.id).sort(), ['c', 'd'])
  assert.equal(rich.find((model) => model.id === 'c').name, 'C')
})

test('readListing refuses a body that is neither shape', () => {
  assert.throws(() => readListing({ error: 'nope' }), /neither a "data" array nor a "models" object/)
  assert.throws(() => readListing({ models: [] }), /neither a "data" array nor a "models" object/)
})

test('readGeminiListing strips the models/ prefix', () => {
  const rows = readGeminiListing({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 8192 }] })
  assert.deepEqual(rows, [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 8192 }])
})

test('authHeaders never guesses: each protocol gets its own header', () => {
  assert.deepEqual(Object.keys(authHeaders('openai-completions', 'k')).sort(), ['accept', 'accept-encoding', 'authorization'])
  assert.equal(authHeaders('openai-completions', 'k').authorization, 'Bearer k')
  assert.equal(authHeaders('anthropic-messages', 'k')['x-api-key'], 'k')
  assert.equal(authHeaders('anthropic-messages', 'k')['anthropic-version'] !== undefined, true)
  assert.equal(authHeaders('google-generative-ai', 'k')['x-goog-api-key'], 'k')
  // Without a key nothing is sent, so a 401 is reported as a credential problem.
  assert.equal(authHeaders('openai-completions', undefined).authorization, undefined)
})

test('listAll attributes each model to the endpoint that publishes it', async () => {
  // One host, three protocols, three different answers — the shape a
  // mixed-protocol provider really has.
  const server = http.createServer((request, response) => {
    const path = request.url ?? ''
    const send = (payload) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (path.startsWith('/zen/go/v1/models') && request.headers['x-api-key'] !== undefined) {
      send({ data: [{ id: 'claude-haiku-5-5' }, { id: 'shared-id' }] })
      return
    }
    if (path.startsWith('/zen/go/v1/models')) {
      send({ data: [{ id: 'gpt-6-luna' }, { id: 'shared-id' }] })
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    const result = await listAll({
      baseURL: `http://127.0.0.1:${String(port)}/zen/go/v1`,
      candidates: ['openai-completions', 'anthropic-messages'],
      apiKey: 'sk-test',
      prefer: ['openai-completions'],
      timeoutMs: 4000,
    })

    assert.equal(result.listings.length, 2)
    // The only claimant wins outright.
    assert.equal(result.attribution.get('claude-haiku-5-5'), 'anthropic-messages')
    assert.equal(result.attribution.get('gpt-6-luna'), 'openai-completions')
    // Two claimants tie-break to the route's own protocol, which already works.
    assert.equal(result.attribution.get('shared-id'), 'openai-completions')
    assert.deepEqual(result.claimants.get('shared-id').sort(), ['anthropic-messages', 'openai-completions'])
    assert.equal(result.attempts.filter((attempt) => attempt.ok === true).length, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('listAll reports every protocol when none of them answer', async () => {
  await assert.rejects(
    () => listAll({
      baseURL: 'http://127.0.0.1:1/v1',
      candidates: ['openai-completions', 'anthropic-messages'],
      timeoutMs: 500,
    }),
    /no protocol answered a model listing/,
  )
})

test('an empty but successful listing does not win the ladder', async () => {
  // `{"data":[]}` is what an endpoint that does not implement listing answers.
  // Taking it would set the protocol to completions, report zero upstream
  // models, and mark every configured id as gone.
  const server = http.createServer((request, response) => {
    const path = request.url ?? '/'
    if (path.startsWith('/v1/models') && path.includes('limit=')) {
      // Anthropic spelling: a real listing.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'claude-haiku-5-5' }] }))
      return
    }
    if (path.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  try {
    const result = await listAll({
      baseURL: `http://127.0.0.1:${String(port)}/v1`,
      candidates: ['openai-completions', 'anthropic-messages'],
      timeoutMs: 4000,
    })
    assert.equal(result.listings.length, 1, 'the empty answer must not count as a listing')
    assert.equal(result.listings[0].api, 'anthropic-messages')
    assert.deepEqual([...result.attribution.keys()], ['claude-haiku-5-5'])
    const empty = result.attempts.find((attempt) => attempt.api === 'openai-completions')
    assert.equal(empty?.ok, false)
    assert.match(String(empty?.reason), /empty listing/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a listing failure never quotes the key that was in the URL', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await assert.rejects(
      () => listAll({
        baseURL: `http://127.0.0.1:${String(port)}/v1?key=sk-live-SECRET123`,
        candidates: ['openai-completions'],
        timeoutMs: 2000,
      }),
      (error) => {
        assert.equal(/sk-live-SECRET123/.test(String(error)), false, 'the key must be masked')
        assert.match(String(error), /key=\*\*\*/)
        return true
      },
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a non-JSON reply is quoted with its credentials redacted', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html>upstream said: bad key sk-live-DEADBEEF for /models?key=sk-live-DEADBEEF</html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await assert.rejects(
      () => listAll({ baseURL: `http://127.0.0.1:${String(port)}/v1`, candidates: ['openai-completions'], timeoutMs: 2000 }),
      (error) => {
        assert.equal(/sk-live-DEADBEEF/.test(String(error)), false)
        assert.match(String(error), /sk-\*\*\*/)
        return true
      },
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
