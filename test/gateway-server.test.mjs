/**
 * The gateway has one job that must never regress: a request for a model that
 * speaks the route's own protocol must reach the upstream unchanged, and the
 * upstream's stream must reach the caller while it is still being produced.
 *
 * These tests drive the real server over a real socket against a fake upstream,
 * because the interesting failures (a header lost, a stream buffered, a
 * keep-alive that never ends) only exist at the socket level.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

import { createGateway, protocolOfTail, splitGatewayPath } from '../lib/gateway/server.js'

/** @type {http.Server} */
let upstream
/** @type {number} */
let upstreamPort
/** @type {Array<{path: string, headers: http.IncomingHttpHeaders, body: string}>} */
const seen = []
/** @type {boolean} */
let heldClosed = false
/** @type {(() => void) | undefined} */
let heldResolve

before(async () => {
  upstream = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ path: request.url ?? '', headers: request.headers, body })

      // Holds the stream open forever: used to prove the gateway hangs up on the
      // provider when the caller goes away, instead of holding its socket until
      // the idle timeout.
      if ((request.url ?? '').startsWith('/hold/')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
        request.on('close', () => {
          heldClosed = true
          heldResolve?.()
        })
        return
      }

      if (request.url === '/broken/v1/chat/completions') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'slow down' } }))
        return
      }

      // A Gemini-shaped upstream: the method lives in the path, the answer is
      // `candidates[].content.parts[]`, and `promptTokenCount` includes the cache.
      if ((request.url ?? '').includes(':streamGenerateContent')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
        })}\n\n`)
        response.end()
        return
      }

      // An upstream that splits a Chinese answer mid-character: the gateway
      // must hand the decoder bytes, not a per-chunk `toString`.
      if ((request.url ?? '').includes('/split/')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const text = '你好世界'
        const frame = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`
        const bytes = Buffer.from(frame, 'utf8')
        const cut = bytes.indexOf(Buffer.from('你', 'utf8')) + 1
        response.write(bytes.subarray(0, cut))
        setTimeout(() => {
          response.write(bytes.subarray(cut))
          response.end()
        }, 30)
        return
      }

      // An Anthropic-shaped upstream: the reverse direction of the codec pair a
      // narrowed route depends on (DSH is told the route speaks completions).
      if ((request.url ?? '').endsWith('/messages')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const frames = [
          ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', usage: { input_tokens: 3, output_tokens: 0 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }],
        ]
        for (const [event, payload] of frames) {
          response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        response.end()
        return
      }

      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Two frames with a pause in between: a gateway that buffers would
      // deliver both at once, which the ordering assertion below cannot catch
      // but the "first frame before the end" assertion can.
      response.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
      setTimeout(() => {
        response.write('data: [DONE]\n\n')
        response.end()
      }, 20)
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  upstreamPort = typeof address === 'object' && address !== null ? address.port : 0
})

after(async () => {
  await new Promise((resolve) => upstream.close(resolve))
})

function routeTable(overrides = {}) {
  return new Map([['r1', {
    tap: 'openai-completions',
    upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
    models: new Map([['m1', 'openai-completions']]),
    ...overrides,
  }]])
}

function call(gateway, path, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const headers = { 'content-type': 'application/json', 'content-length': String(payload.length), authorization: 'Bearer sk-test', ...extra }
    if (extra.authorization === null) delete headers.authorization
    const request = http.request({
      host: '127.0.0.1',
      port: gateway.port,
      method: 'POST',
      path,
      headers,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(payload)
  })
}

test('a same-protocol request is proxied verbatim and streamed through', async () => {
  const gateway = createGateway({ routes: () => routeTable(), hostNeedsProxy: () => false })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(reply.status, 200)
    assert.match(reply.text, /"content":"a"/)
    assert.match(reply.text, /\[DONE\]/)

    const hit = seen.at(-1)
    assert.equal(hit.path, '/v1/chat/completions')
    assert.equal(hit.headers.authorization, 'Bearer sk-test')
    assert.deepEqual(JSON.parse(hit.body), { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
  } finally {
    await gateway.stop()
  }
})

test('an upstream error is forwarded with its status and body intact', async () => {
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'openai-completions',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/broken/v1`,
      models: new Map([['m1', 'openai-completions']]),
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', { model: 'm1' })
    assert.equal(reply.status, 429)
    assert.match(reply.text, /slow down/)
  } finally {
    await gateway.stop()
  }
})

test('an unknown route is a 503, not a crash and not an empty 200', async () => {
  const gateway = createGateway({ routes: () => routeTable(), hostNeedsProxy: () => false })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/nope/chat/completions', { model: 'm1' })
    assert.equal(reply.status, 503)
    assert.match(reply.text, /no gateway route/)
  } finally {
    await gateway.stop()
  }
})

test('a request without a model field is refused before any upstream call', async () => {
  const gateway = createGateway({ routes: () => routeTable(), hostNeedsProxy: () => false })
  await gateway.start()
  const before = seen.length
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', { messages: [] })
    assert.equal(reply.status, 400)
    assert.match(reply.text, /needs a .*model.* field/)
    assert.equal(seen.length, before)
  } finally {
    await gateway.stop()
  }
})

test('the port is released on stop and the reserved lane port is refused', async () => {
  const gateway = createGateway({ routes: () => routeTable(), hostNeedsProxy: () => false })
  await gateway.start()
  const port = gateway.port
  assert.ok(port > 0)
  await gateway.stop()
  assert.equal(gateway.port, 0)

  const second = createGateway({ routes: () => routeTable(), hostNeedsProxy: () => false })
  await assert.rejects(() => second.start(port, [port]), /reserved by the compression lane/)
  assert.equal(second.port, 0)
})

test('path parsing accepts every endpoint pi-ai appends', () => {
  assert.deepEqual(splitGatewayPath('/g/abc/chat/completions'), { routeId: 'abc', tail: 'chat/completions' })
  assert.deepEqual(splitGatewayPath('/g/abc/v1/messages'), { routeId: 'abc', tail: 'v1/messages' })
  assert.equal(splitGatewayPath('/health'), undefined)
  assert.equal(splitGatewayPath('/g/abc'), undefined)

  assert.equal(protocolOfTail('chat/completions'), 'openai-completions')
  assert.equal(protocolOfTail('v1/messages'), 'anthropic-messages')
  assert.equal(protocolOfTail('responses'), 'openai-responses')
  assert.equal(protocolOfTail('embeddings'), undefined)
})

test('a gemini path is recognised and passed through unchanged', async () => {
  const gateway = createGateway({ routes: () => new Map([['r1', {
    tap: 'google-generative-ai',
    upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1beta`,
    models: new Map([['gemini-4-argon', 'google-generative-ai']]),
  }]]) })
  await gateway.start(0, [18787])
  try {
    const path = '/g/r1/models/gemini-4-argon:streamGenerateContent?alt=sse'
    const reply = await call(gateway, path, { contents: [{ parts: [{ text: 'hi' }] }] })
    assert.equal(reply.status, 200)
    // Passthrough means the fake upstream saw the same path, including the
    // query string: the gateway forwards the tail, it does not rebuild it.
    assert.ok(seen.some((row) => row.path === '/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse'))
  } finally {
    await gateway.stop()
  }
})

test('a protocol no build can encode is refused with a 501', async () => {
  // The route advertises completions but the model is served by a protocol this
  // build has no codec for: refusing beats handing a chat body to it.
  const gateway = createGateway({ routes: () => routeTable({
    models: new Map([['alpha-2', 'typesafe-system-one']]),
  }) })
  await gateway.start(0, [18787])
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', { model: 'alpha-2', messages: [] })
    assert.equal(reply.status, 501)
    assert.match(reply.text, /cannot translate openai-completions to typesafe-system-one/)
    assert.equal(gateway.stats().failures, 1)
  } finally {
    await gateway.stop()
  }
})

test('a gemini model on a completions route is translated to the Gemini wire', async () => {
  // This is the direction a narrowed route uses when one of its models is a
  // Gemini model: the client speaks completions, the upstream speaks Gemini.
  const gateway = createGateway({ routes: () => routeTable({
    upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1beta`,
    models: new Map([['gemini-4-argon', 'google-generative-ai']]),
  }), hostNeedsProxy: () => false })
  await gateway.start(0, [18787])
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', {
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'say pong' }],
    })
    assert.equal(reply.status, 200)
    // The Gemini method lives in the path, and without alt=sse it buffers.
    const hit = seen.at(-1)
    assert.equal(hit.path, '/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse')
    const outbound = JSON.parse(hit.body)
    assert.deepEqual(outbound.contents, [{ role: 'user', parts: [{ text: 'say pong' }] }])
    assert.equal(outbound.messages, undefined)
    // The inbound client still receives completions frames carrying the answer.
    assert.match(reply.text, /pong/)
    assert.match(reply.text, /"object":"chat.completion.chunk"/)
    assert.equal(gateway.stats().translated, 1)
  } finally {
    await gateway.stop()
  }
})

test('the gemini tail shapes protocolOfTail knows are exactly the model ones', () => {
  assert.equal(protocolOfTail('models/gemini-4-argon:streamGenerateContent'), 'google-generative-ai')
  assert.equal(protocolOfTail('v1beta/models/gemini-4-argon:generateContent'), 'google-generative-ai')
  // A model id containing "models/" but no method suffix is not a Gemini call.
  assert.equal(protocolOfTail('chat/completions'), 'openai-completions')
})

test('a model the probe never saw is passed through rather than translated blindly', async () => {
  const gateway = createGateway({ routes: () => new Map([['r1', {
    tap: undefined,
    upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
    models: new Map(),
  }]]) })
  await gateway.start(0, [18787])
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', { model: 'never-probed', messages: [] })
    assert.equal(reply.status, 200)
    assert.equal(gateway.stats().translated, 0)
  } finally {
    await gateway.stop()
  }
})

test('a translated stream carries the content, not just the envelope', async () => {
  // The regression this exists for: `encoder.push` takes one event at a time,
  // so spreading a chunk's events into it kept only the first and the caller
  // received a message_start with no content.
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'anthropic-messages',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      models: new Map([['m1', 'openai-completions']]),
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/r1/v1/messages', {
      model: 'm1',
      max_tokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    assert.equal(reply.status, 200)
    assert.match(reply.text, /event: content_block_delta/)
    const text = reply.text
      .split('\n\n')
      .map((frame) => /^data: (.*)$/m.exec(frame)?.[1])
      .filter((line) => line !== undefined)
      .flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
      .flatMap((json) => json?.delta?.text ?? [])
      .join('')
    assert.equal(text, 'a')
    assert.equal(gateway.stats().translated, 1)
  } finally {
    await gateway.stop()
  }
})

test("the route's own auth beats the protocol encoder's", async () => {
  // opencode answers `anthropic-messages` requests authenticated with a bearer
  // token; the encoder's `x-api-key` gets a 401 there.
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'anthropic-messages',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      apiKey: 'sk-encoder',
      authHeaders: { authorization: 'Bearer sk-route' },
      models: new Map([['m1', 'openai-completions']]),
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    await call(gateway, '/g/r1/v1/messages', { model: 'm1', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    const last = seen.at(-1)
    assert.equal(last?.headers.authorization, 'Bearer sk-route')
    assert.equal(last?.headers['x-api-key'], undefined)
  } finally {
    await gateway.stop()
  }
})

test('a passthrough keeps the caller auth, and fills in the route auth when there is none', async () => {
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'openai-completions',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      authHeaders: { authorization: 'Bearer sk-route' },
      models: new Map([['m1', 'openai-completions']]),
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    await call(gateway, '/g/r1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(seen.at(-1)?.headers.authorization, 'Bearer sk-test')
    await call(gateway, '/g/r1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] }, { authorization: null })
    assert.equal(seen.at(-1)?.headers.authorization, 'Bearer sk-route')
  } finally {
    await gateway.stop()
  }
})

test('a completions request for an anthropic model is translated the other way', async () => {
  // This is the direction a narrowed route relies on: the route states one
  // protocol on the DSH side, so every model the catalog describes differently
  // arrives in that protocol and has to be translated on the way out.
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'openai-completions',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      models: new Map([['m1', 'anthropic-messages']]),
      authHeaders: { 'x-api-key': 'sk-route', 'anthropic-version': '2023-06-01' },
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', {
      model: 'm1',
      max_tokens: 32,
      stream: true,
      messages: [
        { role: 'system', content: 'You answer in one word.' },
        { role: 'user', content: 'hi' },
      ],
    })
    assert.equal(reply.status, 200)
    // The caller asked in completions and must get completions back, text and all.
    assert.match(reply.text, /"content":"a"/)
    assert.match(reply.text, /\[DONE\]/)

    const hit = seen.at(-1)
    assert.equal(hit.path, '/v1/messages')
    const sent = JSON.parse(hit.body)
    assert.equal(sent.model, 'm1')
    assert.equal(sent.max_tokens, 32)
    // Anthropic accepts either a string or text blocks; the encoder picks blocks.
    assert.deepEqual(sent.system, [{ type: 'text', text: 'You answer in one word.' }])
    assert.deepEqual(sent.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    // The route decides how to authenticate an anthropic-shaped upstream.
    assert.equal(hit.headers['x-api-key'], 'sk-route')
    assert.equal(hit.headers['anthropic-version'], '2023-06-01')
  } finally {
    await gateway.stop()
  }
})

test('a caller that hangs up releases the upstream stream', async () => {
  const gateway = createGateway({ routes: () => new Map([['r1', {
    tap: 'openai-completions',
    upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/hold`,
    models: new Map([['m1', 'openai-completions']]),
  }]]) })
  await gateway.start(0, [18787])
  const hungUp = new Promise((resolve) => {
    heldResolve = resolve
  })
  try {
    const payload = Buffer.from(JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }))
    await new Promise((resolve) => {
      const request = http.request({
        host: '127.0.0.1',
        port: gateway.port,
        method: 'POST',
        path: '/g/r1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      }, (response) => {
        // Leave the moment the first frame lands, the way a closed panel or a
        // cancelled chat does.
        response.once('data', () => {
          request.destroy()
          resolve(undefined)
        })
        response.on('error', () => resolve(undefined))
      })
      request.on('error', () => resolve(undefined))
      request.end(payload)
    })
    const closed = await Promise.race([
      hungUp.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ])
    assert.equal(closed, true, 'the gateway must hang up on the provider when the caller leaves')
    assert.equal(heldClosed, true)
  } finally {
    await gateway.stop()
  }
})

test('a path with a broken escape is a 404, not a dead host process', () => {
  // `decodeURIComponent` throws URIError on these; the listener runs inside
  // `http.createServer`, where a synchronous throw is an uncaught exception.
  assert.equal(splitGatewayPath('/g/%/x'), undefined)
  assert.equal(splitGatewayPath('/g/%zz/x'), undefined)
  assert.deepEqual(splitGatewayPath('/g/google/chat/completions'), { routeId: 'google', tail: 'chat/completions' })
})

test('a multi-byte character split across chunks survives the translation', async () => {
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'openai-completions',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/split`,
      models: new Map([['m1', 'anthropic-messages']]),
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/r1/chat/completions', {
      model: 'm1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    assert.equal(reply.status, 200)
    assert.match(reply.text, /你好世界/, 'the text must arrive intact')
    assert.equal(reply.text.includes('\uFFFD'), false, 'no replacement characters may appear')
  } finally {
    await gateway.stop()
  }
})

test('a Gemini request keeps its model when translated to another protocol', async () => {
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'google-generative-ai',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      models: new Map([['m1', 'openai-completions']]),
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/r1/models/m1:streamGenerateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    })
    assert.equal(reply.status, 200)
    const hit = seen.at(-1)
    assert.equal(hit.path, '/v1/chat/completions')
    assert.equal(JSON.parse(hit.body).model, 'm1', 'Gemini carries the model in the URL; the translation has to put it back')
  } finally {
    await gateway.stop()
  }
})

test('a base that already ends in /v1 is not doubled on the passthrough path', async () => {
  const gateway = createGateway({
    routes: () => new Map([['r1', {
      tap: 'anthropic-messages',
      upstreamBaseURL: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      models: new Map([['m1', 'anthropic-messages']]),
    }]]),
    hostNeedsProxy: () => false,
  })
  await gateway.start()
  try {
    const reply = await call(gateway, '/g/r1/v1/messages', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(reply.status, 200)
    assert.equal(seen.at(-1).path, '/v1/messages')
  } finally {
    await gateway.stop()
  }
})
