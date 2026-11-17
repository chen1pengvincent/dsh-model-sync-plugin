/**
 * Tests for the retry that keeps a wobbly network from turning a working route
 * red.
 *
 * One request in four through this machine's HTTP proxy dies during the TLS
 * handshake and the next one succeeds. The ladder used to record that as "this
 * protocol is wrong" and paint the card red, even though nothing was wrong with
 * the configuration.
 *
 * Run: node --test
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { isTransientFailure, listModels } from '../lib/discovery.js'

/** Start a server on a random port, run the test, always close the server. */
async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}/v1`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('isTransientFailure knows a dropped connection but not an answer', () => {
  assert.equal(isTransientFailure('TLS handshake with generativelanguage.googleapis.com failed: Client network socket disconnected before secure TLS connection was established'), true)
  assert.equal(isTransientFailure('read ECONNRESET'), true)
  assert.equal(isTransientFailure('no reply within 15000ms'), true)
  assert.equal(isTransientFailure('this endpoint answered 502 Bad Gateway'), true)
  // A 4xx is the server answering; retrying it would just ask the same question again.
  assert.equal(isTransientFailure('this endpoint answered 401; check the API key'), false)
  assert.equal(isTransientFailure('answered a non-JSON body: <html>'), false)
  // A host that merely contains the word must not make every request look transient.
  assert.equal(isTransientFailure('https://timeout.example/v1/models answered 404'), false)
})

test('a dropped connection is retried once and then trusted', async () => {
  let hits = 0
  await withServer((request, response) => {
    hits += 1
    if (hits === 1) {
      // The socket dies mid-request: exactly what the proxy does now and then.
      request.socket.destroy()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }))
  }, async (baseURL) => {
    const listed = await listModels({ baseURL, candidates: ['openai-completions'], timeoutMs: 5000 })
    assert.equal(listed.api, 'openai-completions')
    assert.deepEqual(listed.models.map((model) => model.id), ['alpha', 'beta'])
    assert.equal(hits, 2, 'the first attempt failed and the second one answered')
    assert.deepEqual(listed.attempts, [{ api: 'openai-completions', ok: true }])
  })
})

test('an answered 401 is not retried', async () => {
  let hits = 0
  await withServer((request, response) => {
    hits += 1
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'invalid key' } }))
  }, async (baseURL) => {
    await assert.rejects(
      () => listModels({ baseURL, candidates: ['openai-completions'], timeoutMs: 5000 }),
      /answered 401/,
    )
    assert.equal(hits, 1, 'a 401 is an answer, so asking again would be pointless')
  })
})
