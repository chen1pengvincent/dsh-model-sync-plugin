import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  bypassProxy, createProxyFetch, parseProxyURL, parseScutilProxy, resolveProxyFor,
} from '../lib/net-proxy.js';

const certificate = fs.readFileSync(fileURLToPath(new URL('./fixtures/test-proxy.crt', import.meta.url)));
const privateKey = fs.readFileSync(fileURLToPath(new URL('./fixtures/test-proxy.key', import.meta.url)));

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
}`;

test('parseProxyURL accepts http proxies and rejects everything else', () => {
  assert.deepEqual(parseProxyURL('127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
  assert.deepEqual(parseProxyURL('http://127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
  assert.deepEqual(parseProxyURL('http://user:p%C3%A4ss@proxy.example:3128'), {
    host: 'proxy.example', port: 3128, authorization: `Basic ${Buffer.from('user:päss').toString('base64')}`,
  });
  assert.equal(parseProxyURL('socks5://127.0.0.1:7897'), undefined);
  assert.equal(parseProxyURL('https://127.0.0.1:7897'), undefined);
  assert.equal(parseProxyURL('  '), undefined);
  assert.equal(parseProxyURL('http://host:0'), undefined);
  assert.equal(parseProxyURL('http://:7897'), undefined);
});

test('parseScutilProxy reads the macOS dictionary and its exception list', () => {
  assert.deepEqual(parseScutilProxy(SCUTIL), {
    http: { host: '127.0.0.1', port: 7897 },
    https: { host: '127.0.0.1', port: 7897 },
    bypass: ['127.0.0.1', '192.168.0.0/16', '*.local'],
  });
  assert.equal(parseScutilProxy(''), null);
  assert.equal(parseScutilProxy('<dictionary> {\n  HTTPEnable : 0\n}'), null);
});

test('bypassProxy honours wildcards, suffixes and CIDR blocks', () => {
  assert.equal(bypassProxy('anything.example', ['*']), true);
  assert.equal(bypassProxy('localhost', ['localhost']), true);
  assert.equal(bypassProxy('api.localhost', ['localhost']), true);
  assert.equal(bypassProxy('a.example.com', ['.example.com']), true);
  assert.equal(bypassProxy('a.example.com', ['*.example.com']), true);
  assert.equal(bypassProxy('example.com', ['example.com']), true);
  assert.equal(bypassProxy('notexample.com', ['example.com']), false);
  assert.equal(bypassProxy('192.168.5.5', ['192.168.0.0/16']), true);
  assert.equal(bypassProxy('172.32.1.1', ['192.168.0.0/16']), false);
  assert.equal(bypassProxy('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(bypassProxy('generativelanguage.googleapis.com', SCUTIL ? ['127.0.0.1', '*.local'] : []), false);
});

test('resolveProxyFor prefers the environment, then the system proxy', async () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7897' };
  assert.deepEqual(await resolveProxyFor('https://generativelanguage.googleapis.com/v1beta/models', { env, platform: 'linux' }), { host: '127.0.0.1', port: 7897 });
  assert.equal(await resolveProxyFor('https://generativelanguage.googleapis.com/', { env: { NO_PROXY: '.googleapis.com', HTTPS_PROXY: 'http://127.0.0.1:7897' }, platform: 'linux' }), undefined);
  assert.equal(await resolveProxyFor('https://generativelanguage.googleapis.com/', { env: {}, platform: 'linux' }), undefined);
  const systemProxy = () => ({ http: { host: '10.0.0.9', port: 3128 }, https: { host: '10.0.0.9', port: 3128 }, bypass: ['127.0.0.1'] });
  assert.deepEqual(await resolveProxyFor('https://example.com/', { env: {}, platform: 'darwin', systemProxy }), { host: '10.0.0.9', port: 3128 });
  assert.equal(await resolveProxyFor('https://127.0.0.1/', { env: {}, platform: 'darwin', systemProxy }), undefined);
});

/** Minimal CONNECT proxy that records what it was asked to tunnel. */
function startConnectProxy() {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const head = buffer.slice(0, end);
      seen.push(head.split('\r\n')[0]);
      const match = head.match(/^CONNECT ([^:\s]+):(\d+) /);
      if (!match) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      const upstream = net.connect({ host: match[1], port: Number(match[2]) }, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      seen,
      port: server.address().port,
      close: () => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections?.();
        return new Promise((done) => server.close(done));
      },
    }));
  });
}

function startTlsServer(handler) {
  const server = https.createServer({ key: privateKey, cert: certificate }, handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => { server.closeAllConnections?.(); return new Promise((done) => server.close(done)); },
    }));
  });
}

test('createProxyFetch tunnels https through the proxy and returns a Response', async () => {
  const seenRequests = [];
  const tls = await startTlsServer((req, res) => {
    seenRequests.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }));
  });
  const proxy = await startConnectProxy();
  try {
    const fetchThrough = createProxyFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      platform: 'linux',
      tlsOptions: { ca: certificate },
      directFetch: async () => { throw new TypeError('fetch failed'); },
    });
    const response = await fetchThrough(`https://localhost:${tls.port}/v1beta/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': 'test-key' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), { models: [{ name: 'models/gemini-2.5-flash' }] });
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0], `CONNECT localhost:${tls.port} HTTP/1.1`);
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0].url, '/v1beta/models?pageSize=1000');
    assert.equal(seenRequests[0].headers.host, `localhost:${tls.port}`);
    assert.equal(seenRequests[0].headers['x-goog-api-key'], 'test-key');
    assert.equal(seenRequests[0].headers['accept-encoding'], 'identity');
  } finally {
    await proxy.close();
    await tls.close();
  }
});

test('createProxyFetch decodes chunked responses', async () => {
  const tls = await startTlsServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    res.write('{"models":');
    setTimeout(() => { res.write('[{"name":"models/x"}]}'); res.end(); }, 20);
  });
  const proxy = await startConnectProxy();
  try {
    const fetchThrough = createProxyFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      platform: 'linux',
      tlsOptions: { ca: certificate },
      directFetch: async () => { throw new TypeError('fetch failed'); },
    });
    const response = await fetchThrough(`https://localhost:${tls.port}/v1beta/models`);
    assert.deepEqual(await response.json(), { models: [{ name: 'models/x' }] });
  } finally {
    await proxy.close();
    await tls.close();
  }
});

test('createProxyFetch honours an abort signal', async () => {
  const tls = await startTlsServer(() => { /* never responds */ });
  const proxy = await startConnectProxy();
  try {
    const fetchThrough = createProxyFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      platform: 'linux',
      tlsOptions: { ca: certificate },
      directFetch: () => new Promise(() => {}),
    });
    const controller = new AbortController();
    const pending = fetchThrough(`https://localhost:${tls.port}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  } finally {
    await proxy.close();
    await tls.close();
  }
});

test('createProxyFetch keeps a working direct response even when the proxy is unusable', async () => {
  const closed = await startConnectProxy();
  const port = closed.port;
  await closed.close();
  const fetchThrough = createProxyFetch({
    env: { HTTPS_PROXY: `http://127.0.0.1:${port}` },
    platform: 'linux',
    directFetch: async () => new Response('direct-ok', { status: 200 }),
  });
  const response = await fetchThrough('https://example.invalid/v1beta/models');
  assert.equal(await response.text(), 'direct-ok');
});

test('createProxyFetch goes direct when no proxy applies', async () => {
  let calls = 0;
  const fetchThrough = createProxyFetch({
    env: {},
    platform: 'linux',
    directFetch: async (input) => { calls += 1; return new Response(String(input), { status: 200 }); },
  });
  const response = await fetchThrough('https://example.invalid/catalog');
  assert.equal(calls, 1);
  assert.equal(await response.text(), 'https://example.invalid/catalog');
});


test('createProxyFetch hedges a stalled direct request with the proxy', async () => {
  const tls = await startTlsServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"models":[]}');
  });
  const proxy = await startConnectProxy();
  try {
    const fetchThrough = createProxyFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      platform: 'linux',
      tlsOptions: { ca: certificate },
      hedgeDelayMs: 30,
      directFetch: () => new Promise(() => {}),
    });
    const started = Date.now();
    const response = await fetchThrough(`https://localhost:${tls.port}/v1beta/models`);
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed < 1_000, `expected the proxy hedge to win quickly, took ${elapsed}ms`);
    assert.equal(proxy.seen[0], `CONNECT localhost:${tls.port} HTTP/1.1`);
  } finally {
    await proxy.close();
    await tls.close();
  }
});

test('createProxyFetch does not use the proxy for a fast direct response', async () => {
  const proxy = await startConnectProxy();
  try {
    const fetchThrough = createProxyFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      platform: 'linux',
      hedgeDelayMs: 5_000,
      directFetch: async () => new Response('direct', { status: 200 }),
    });
    const response = await fetchThrough('https://example.invalid/catalog');
    assert.equal(await response.text(), 'direct');
    assert.equal(proxy.seen.length, 0);
  } finally {
    await proxy.close();
  }
});

test('createProxyFetch rejects when the hedge starts and both attempts fail', async () => {
  // Regression: the hedge fired first, the proxy failed, and the later direct
  // failure used to be dropped — the promise then hung until the caller aborted.
  const dead = await startConnectProxy();
  const deadPort = dead.port;
  await dead.close();
  const fetchThrough = createProxyFetch({
    env: { HTTPS_PROXY: `http://127.0.0.1:${deadPort}` },
    platform: 'linux',
    hedgeDelayMs: 20,
    directFetch: () => new Promise((_, reject) => setTimeout(() => reject(new TypeError('fetch failed')), 120)),
  });
  const started = Date.now();
  await assert.rejects(
    fetchThrough('https://example.invalid/v1beta/models'),
    (error) => /fetch failed/.test(String(error?.message)) || error?.name === 'TypeError',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `expected a fast rejection, took ${elapsed}ms`);
});

test('createProxyFetch refuses a redirect instead of reporting it as an HTTP status', async () => {
  const tls = await startTlsServer((req, res) => {
    res.writeHead(302, { location: 'https://example.invalid/elsewhere' });
    res.end();
  });
  const proxy = await startConnectProxy();
  try {
    const fetchThrough = createProxyFetch({
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
      platform: 'linux',
      tlsOptions: { ca: certificate },
      directFetch: async () => { throw new TypeError('fetch failed'); },
    });
    const url = `https://localhost:${tls.port}/v1beta/models`;
    await assert.rejects(fetchThrough(url, { redirect: 'error' }), (error) => error instanceof TypeError);
    const response = await fetchThrough(url);
    assert.equal(response.status, 302);
  } finally {
    await proxy.close();
    await tls.close();
  }
});
