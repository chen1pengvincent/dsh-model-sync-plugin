/**
 * The panel's HTTP surface, exercised the way the browser will call it.
 *
 * These tests pin the two properties a mis-typed route could silently break:
 * every documented verb answers, and an unknown verb answers 404 instead of
 * falling through to something that writes.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import test from 'node:test'

import { registerApi } from '../lib/api.js'

/** A controller stub that records which action the API called. */
function stubController() {
  const calls = []
  const view = { providers: [], foreign: [], proxy: { enabled: false }, schedule: { enabled: false, hour: 9 } }
  return {
    calls,
    logger: { error() {} },
    async view() { return view },
    async check(body) { calls.push(['check', body]); return { results: [] } },
    async apply(body) { calls.push(['apply', body]); return { written: ['x'] } },
    async remove(body) { calls.push(['remove', body]); return { removed: body.id } },
    async ignore(body) { calls.push(['ignore', body]); return { ignored: body.ids } },
    async restore(body) { calls.push(['restore', body]); return {} },
    async cleanup(body) { calls.push(['cleanup', body]); return { removed: body.providers } },
    async settings(body) { calls.push(['settings', body]); return view },
  }
}

/** Mount the API and return a function that performs one request. */
function mount(controller) {
  let registered
  const webServer = {
    register(options) { registered = options; return () => {} },
  }
  registerApi(webServer, controller)
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, '/model-sync')

  return async function request(method, url, body) {
    const request_ = Object.assign(
      Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
      { method, url },
    )
    /** @type {any} */
    const response = {
      status: 0,
      headers: undefined,
      body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
    }
    await registered.handler(request_, response)
    return { status: response.status, json: response.body === '' ? undefined : JSON.parse(response.body) }
  }
}

test('GET view answers with the panel payload', async () => {
  const controller = stubController()
  const request = mount(controller)
  const reply = await request('GET', '/model-sync/api/view')
  assert.equal(reply.status, 200)
  assert.equal(reply.json.ok, true)
  assert.deepEqual(reply.json.view.providers, [])
})

test('each documented verb reaches its controller method with the body', async () => {
  const controller = stubController()
  const request = mount(controller)
  const cases = [
    ['check', { provider: 'google' }],
    ['apply', { provider: 'google', ids: ['a'] }],
    ['remove', { provider: 'google', id: 'a' }],
    ['ignore', { provider: 'google', ids: ['a'] }],
    ['restore', { provider: 'google' }],
    ['cleanup', { providers: ['x'] }],
    ['settings', { schedule: { enabled: true, hour: 9 } }],
  ]
  for (const [verb, body] of cases) {
    const reply = await request('POST', `/model-sync/api/${verb}`, body)
    assert.equal(reply.status, 200, `${verb} should answer 200`)
    assert.equal(reply.json.ok, true, `${verb} should answer ok`)
  }
  assert.deepEqual(controller.calls.map(([name]) => name), cases.map(([verb]) => verb))
})

test('an unknown verb answers 404 and calls nothing', async () => {
  const controller = stubController()
  const request = mount(controller)
  const reply = await request('POST', '/model-sync/api/apply-all-the-things', {})
  assert.equal(reply.status, 404)
  assert.equal(reply.json.ok, false)
  assert.equal(controller.calls.length, 0)
})

test('a safe error keeps its sentence, an unsafe one does not leak', async () => {
  const controller = stubController()
  controller.apply = async () => {
    throw Object.assign(new Error('internal detail'), { status: 409, safe: true, publicMessage: 'check this provider before applying' })
  }
  controller.check = async () => { throw new Error('secret-bearing message') }
  const request = mount(controller)

  const safe = await request('POST', '/model-sync/api/apply', { provider: 'google' })
  assert.equal(safe.status, 409)
  assert.equal(safe.json.error, 'check this provider before applying')

  const unsafe = await request('POST', '/model-sync/api/check', {})
  assert.equal(unsafe.status, 500)
  assert.ok(!unsafe.json.error.includes('secret-bearing'), 'upstream detail must not reach the browser')
})

test('GET on a POST-only verb is refused', async () => {
  const controller = stubController()
  const request = mount(controller)
  const reply = await request('GET', '/model-sync/api/apply')
  assert.equal(reply.status, 405)
  assert.equal(controller.calls.length, 0)
})

test('a body that is not a JSON object is rejected', async () => {
  const controller = stubController()
  const request = mount(controller)
  const reply = await request('POST', '/model-sync/api/check', ['not', 'an', 'object'])
  assert.equal(reply.status, 400)
  assert.equal(controller.calls.length, 0)
})

test('every verb the panel sends has a handler on this side', async () => {
  // A button wired to a verb the host half does not know is a dead button that
  // still shows a toast -- the failure is invisible in any single-file test.
  const [client, api] = await Promise.all([
    readFile(new URL('../lib/client.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/api.js', import.meta.url), 'utf8'),
  ])
  const verbs = new Set()
  for (const match of client.matchAll(/\b(?:act|call)\('([a-z-]+)'/g)) verbs.add(match[1])
  assert.ok(verbs.size >= 10, `expected the panel to use the api, saw ${String(verbs.size)} verbs`)
  for (const verb of verbs) {
    assert.ok(api.includes(`'${verb}'`), `the api has no handler for the verb "${verb}"`)
  }
})
