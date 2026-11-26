/**
 * The tunnel is the part of this client nothing else can cover: it is written
 * against `net` rather than `http` precisely because the harness environment
 * hijacks `http.request` (`NODE_USE_ENV_PROXY=1`) and the compression plugin
 * rewrites `fetch`.
 *
 * The case worth pinning down is the argument shape: callers pass a proxy URL
 * and the transport wants an endpoint, so a string has to be accepted.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { getEventListeners, once } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'
import { after, before, test } from 'node:test'

import { AbortedError, openStream, parseProxy, request } from '../lib/http.js'

/** @type {net.Server} */
let tunnel
let tunnelPort
const connectLines = []

before(async () => {
  tunnel = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      connectLines.push(chunk.toString('latin1').trim())
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
    })
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => tunnel.listen(0, '127.0.0.1', resolve))
  const address = tunnel.address()
  tunnelPort = typeof address === 'object' && address !== null ? address.port : 0
})

after(async () => {
  await new Promise((resolve) => tunnel.close(resolve))
})

test('a proxy string is understood as a proxy endpoint', () => {
  assert.deepEqual(parseProxy('http://127.0.0.1:7897'), { protocol: 'http:', host: '127.0.0.1', port: 7897, auth: undefined })
  assert.deepEqual(parseProxy('http://user:pw@127.0.0.1:7897'), { protocol: 'http:', host: '127.0.0.1', port: 7897, auth: 'user:pw' })
  // A SOCKS proxy is refused outright rather than silently ignored: falling back
  // to a direct connection is the one outcome a proxy switch must never produce.
  assert.equal(parseProxy('socks5://127.0.0.1:1080'), undefined)
})

test('a string proxy reaches the tunnel and asks for the right origin', async () => {
  connectLines.length = 0
  const reply = await request({
    url: 'http://example.test/probe?x=1',
    proxy: `http://127.0.0.1:${String(tunnelPort)}`,
    timeoutMs: 2_000,
  }).catch((error) => ({ failed: error.message }))

  // The fake tunnel answers CONNECT and then hangs up, so the request itself
  // cannot succeed -- what matters is that the tunnel was asked, which means the
  // string was normalised instead of being read as an object.
  assert.equal(connectLines.length, 1)
  assert.match(connectLines[0], /^CONNECT example\.test:80 HTTP\/1\.1/)
  assert.ok('failed' in reply || reply.status !== undefined)
})

/* --------------------------------------------- refusals, not silent direct */

test('a proxy that cannot be understood is refused instead of sending the key in clear', () => {
  assert.equal(parseProxy('socks5://127.0.0.1:1080'), undefined)
  assert.equal(parseProxy('https://127.0.0.1:8080'), undefined)
  assert.equal(parseProxy('http://user:%zz@127.0.0.1:8080'), undefined, 'a raw % must not throw URIError')
})

test('requesting with an unusable proxy throws before anything leaves the machine', async () => {
  let touched = false
  const server = net.createServer((socket) => { touched = true; socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await assert.rejects(
      request({ url: `http://127.0.0.1:${String(port)}/models`, proxy: 'socks5://127.0.0.1:9', timeoutMs: 1000 }),
      /not usable/,
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(touched, false, 'nothing may reach the upstream when the proxy is unusable')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

/* ------------------------------------------------------- bounded and framed */

function serveOnce(handler) {
  const server = net.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    resolve({ server, port })
  }))
}

test('completed requests and streams release a shared cancellation signal', async () => {
  const { server, port } = await serveOnce((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
  })
  const { signal } = new AbortController()
  const options = { url: `http://127.0.0.1:${port}`, signal }
  try {
    for (let i = 0; i < 8; i++) {
      assert.equal((await request(options)).text, 'ok')
      const reply = await openStream(options)
      try {
        const chunks = []
        for await (const chunk of reply.chunks) chunks.push(chunk)
        assert.equal(Buffer.concat(chunks).toString(), 'ok')
      } finally {
        reply.close()
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  // destroy() finishes emitting 'close' on the following event-loop turn.
  for (let i = 0; i < 10 && getEventListeners(signal, 'abort').length; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})

for (const phase of ['TCP connect', 'proxy CONNECT', 'TLS handshake', 'response headers']) {
  test(`cancellation during ${phase} reports the transport's AbortedError`, async () => {
    const controller = new AbortController()
    const { server, port } = await serveOnce((socket) => {
      socket.on('error', () => {})
      socket.once('data', () => controller.abort())
    })
    const address = `127.0.0.1:${port}`
    try {
      const pending = request({
        url: phase === 'TLS handshake' ? `https://${address}` : `http://${address}`,
        proxy: phase === 'proxy CONNECT' ? `http://${address}` : undefined,
        signal: controller.signal,
        timeoutMs: 1500,
      })
      if (phase === 'TCP connect') controller.abort()
      await assert.rejects(pending, (error) => error instanceof AbortedError && error.code === 'ABORTED')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
}

test('cancelling while waiting for the next body chunk preserves the cancellation type', async () => {
  const { server, port } = await serveOnce((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na'))
  })
  const controller = new AbortController()
  let reply
  try {
    reply = await openStream({ url: `http://127.0.0.1:${port}`, signal: controller.signal, timeoutMs: 1500 })
    assert.equal((await reply.chunks.next()).value.toString(), 'a')
    const pending = reply.chunks.next()
    controller.abort()
    await assert.rejects(pending, (error) => error instanceof AbortedError && error.code === 'ABORTED')
  } finally {
    reply?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('aborting an established TLS stream reports cancellation to its pending reader', async (t) => {
  // A single-use shared key authenticates the fixture without a certificate file.
  const key = randomBytes(32)
  const fixture = { maxVersion: 'TLSv1.2', ciphers: 'PSK-AES128-CBC-SHA' }
  const server = tls.createServer({
    ...fixture, pskCallback: (_, identity) => identity === 'fixture' ? key : null,
  }, (socket) => socket.once('data', () => {
    socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n')
  }))
  const connect = tls.connect
  t.mock.method(tls, 'connect', (options) => connect({
    ...options, ...fixture, pskCallback: () => ({ identity: 'fixture', psk: key }), checkServerIdentity: () => undefined,
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const controller = new AbortController()
  let reply
  try {
    reply = await openStream({ url: `https://127.0.0.1:${server.address().port}`, signal: controller.signal, timeoutMs: 1500 })
    assert.equal((await reply.chunks.next()).value.toString(), 'a')
    const waiting = reply.chunks.next()
    controller.abort()
    await assert.rejects(waiting, (error) => error instanceof AbortedError && error.code === 'ABORTED')
  } finally {
    reply?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a reply whose headers never end is cut off instead of read forever', async () => {
  const { server, port } = await serveOnce((socket) => {
    socket.write('HTTP/1.1 200 OK\r\nX-Fill: ')
    const filler = setInterval(() => socket.write('a'.repeat(16 * 1024)), 5)
    socket.on('close', () => clearInterval(filler))
    socket.on('error', () => clearInterval(filler))
  })
  try {
    await assert.rejects(
      request({ url: `http://127.0.0.1:${String(port)}/models`, timeoutMs: 3000 }),
      /exceeded 65536 bytes/,
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a stalled stream consumer pauses upstream reads and can resume without losing bytes', async (t) => {
  const body = Buffer.alloc(256 * 1024, 'a')
  const { server, port } = await serveOnce((socket) => socket.once('data', () => {
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`)
    socket.end(body)
  }))
  const connect = net.connect
  let upstream
  t.mock.method(net, 'connect', (...args) => {
    upstream = connect(...args)
    return upstream
  })
  try {
    const reply = await openStream({ url: `http://127.0.0.1:${port}/stream` })
    try {
      const chunks = []
      for await (const chunk of reply.chunks) {
        assert.equal(upstream.isPaused(), true)
        chunks.push(chunk)
      }
      assert.deepEqual(Buffer.concat(chunks), body)
    } finally {
      reply.close()
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a chunked body that closes without its zero chunk still comes back whole', async () => {
  const { server, port } = await serveOnce((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n')
      socket.write('7\r\n{"a":1}\r\n')
      socket.end()
    })
    socket.on('error', () => undefined)
  })
  try {
    const reply = await request({ url: `http://127.0.0.1:${String(port)}/models`, timeoutMs: 3000 })
    assert.equal(reply.text, '{"a":1}')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a header value with a line break is refused, not injected', async () => {
  await assert.rejects(
    request({ url: 'http://127.0.0.1:9/models', headers: { 'x-a': 'v\r\nx-injected: 1' }, timeoutMs: 300 }),
    /line break/,
  )
})
