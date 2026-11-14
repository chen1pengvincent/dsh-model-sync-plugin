/**
 * Proxy-aware fetch for the catalog requests.
 *
 * DSH's host process is a plain Node process: it does not inherit a browser
 * proxy configuration, `undici`'s global dispatcher ignores `HTTPS_PROXY`, and a
 * machine that can only reach a vendor API through a local HTTP proxy therefore
 * fails every catalog request with an opaque transport error. macOS already
 * knows the proxy (`scutil --proxy`), so this module reproduces that decision
 * for the one transport this plugin owns:
 *
 *   resolveProxyFor(url) -> {host, port, authorization} | undefined
 *   createProxyFetch()   -> fetch-compatible function
 *
 * Only plain HTTP proxies are supported (CONNECT for https, absolute-form for
 * http). SOCKS and PAC are deliberately out of scope: sending a request through
 * a proxy the user did not configure would be worse than failing loudly.
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';

const SYSTEM_PROXY_TTL_MS = 60_000;
const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const PROXY_ENV_NAMES = {
  'https:': ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'],
  'http:': ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
};

function debug(message) {
  if (process.env.DSH_MODEL_SYNC_DEBUG_PROXY === '1') process.stderr.write(`[model-sync] ${message}\n`);
}

/** `host`, `host:port`, `[::1]:port` -> {name, port}. */
function splitHostPort(value) {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const ipv6 = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) return { name: ipv6[1], port: ipv6[2] === undefined ? undefined : Number(ipv6[2]) };
  const single = text.match(/^([^:]+)(?::(\d+))?$/);
  if (!single) return undefined;
  return { name: single[1], port: single[2] === undefined ? undefined : Number(single[2]) };
}

function ipv4ToInt(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value * 256) + octet;
  }
  return value;
}

function matchesCidr(host, entry) {
  const slash = entry.indexOf('/');
  if (slash === -1) return false;
  const network = ipv4ToInt(entry.slice(0, slash));
  const bits = Number(entry.slice(slash + 1));
  const address = ipv4ToInt(host);
  if (network === undefined || address === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (network & mask) === (address & mask);
}

/**
 * True when `host` must bypass the proxy. Accepts the syntaxes macOS and the
 * NO_PROXY convention actually use: `*`, exact host, `:port`, leading dot or
 * `*.` suffix, plain suffix (`example.com` also covers `a.example.com`), and
 * IPv4 CIDR blocks.
 */
export function bypassProxy(host, entries) {
  const target = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (target === '') return false;
  for (const raw of entries ?? []) {
    let entry = String(raw ?? '').trim().toLowerCase();
    if (entry === '') continue;
    if (entry === '*') return true;
    if (entry.includes('://')) entry = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
    if (matchesCidr(target, entry)) return true;
    const parsed = splitHostPort(entry);
    if (!parsed) continue;
    if (parsed.port !== undefined && parsed.port !== Number(NaN)) {
      // A port-qualified bypass only matches that port; the caller cannot tell
      // us the port here, so keep the entry a host match only.
    }
    let name = parsed.name.toLowerCase().replace(/^\./, '').replace(/^\*\./, '');
    if (name === '') continue;
    if (name === target) return true;
    if (target.endsWith(`.${name}`)) return true;
  }
  return false;
}

/** `http://user:pass@127.0.0.1:7897` -> {host, port, authorization}. */
export function parseProxyURL(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  let text = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== 'http:') return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port === '' ? 80 : Number(url.port);
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const authorization = url.username === ''
    ? undefined
    : `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
  return { host, port, ...(authorization === undefined ? {} : { authorization }) };
}

/** Parse the `<dictionary>` text printed by `scutil --proxy`. */
export function parseScutilProxy(text) {
  if (typeof text !== 'string' || text === '') return null;
  const number = (key) => {
    const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(-?\\d+)`));
    return match ? Number(match[1]) : undefined;
  };
  const string = (key) => {
    const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([^\\s}]+)`));
    return match ? match[1] : undefined;
  };
  const entry = (prefix) => {
    if (number(`${prefix}Enable`) !== 1) return undefined;
    const host = string(`${prefix}Proxy`);
    const port = number(`${prefix}Port`);
    if (host === undefined || port === undefined) return undefined;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    return { host, port };
  };
  const bypass = [];
  const block = text.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/);
  if (block) {
    for (const match of block[1].matchAll(/\d+\s*:\s*([^\s]+)/g)) bypass.push(match[1]);
  }
  const http = entry('HTTP');
  const https = entry('HTTPS');
  if (http === undefined && https === undefined) return null;
  return { http, https, bypass };
}

let systemProxyCache;

/**
 * macOS system proxy, cached for a minute. Any failure (non-darwin host,
 * scutil missing, timeout) means "no system proxy", never an exception.
 */
export function readSystemProxy({ platform = process.platform } = {}) {
  if (platform !== 'darwin') return Promise.resolve(null);
  if (systemProxyCache !== undefined && Date.now() - systemProxyCache.at < SYSTEM_PROXY_TTL_MS) {
    return Promise.resolve(systemProxyCache.value);
  }
  return new Promise((resolve) => {
    execFile('scutil', ['--proxy'], { timeout: 2_000, windowsHide: true }, (error, stdout) => {
      const value = error ? null : parseScutilProxy(String(stdout ?? ''));
      systemProxyCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

/** Reset the cached system proxy (tests and `check`-triggered re-reads). */
export function resetSystemProxyCache() { systemProxyCache = undefined; }

/**
 * Decide the proxy for one URL: NO_PROXY first, then the environment, then the
 * macOS system settings. Returns undefined when the request should go direct.
 */
export async function resolveProxyFor(target, {
  env = process.env, platform = process.platform, systemProxy = readSystemProxy,
} = {}) {
  const url = target instanceof URL ? target : new URL(String(target));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const envBypass = String(env.NO_PROXY ?? env.no_proxy ?? '').split(',');
  if (bypassProxy(host, envBypass)) return undefined;
  for (const name of PROXY_ENV_NAMES[url.protocol] ?? []) {
    const proxy = parseProxyURL(env[name]);
    if (proxy !== undefined) return proxy;
  }
  const system = typeof systemProxy === 'function' ? await systemProxy({ platform }) : systemProxy;
  if (!system) return undefined;
  if (bypassProxy(host, system.bypass ?? [])) return undefined;
  const entry = url.protocol === 'https:' ? system.https : system.http;
  if (entry === undefined) return undefined;
  return { host: entry.host, port: entry.port };
}

function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('This operation was aborted', 'AbortError')
    : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

function transportError(message) {
  return Object.assign(new TypeError('fetch failed'), { cause: new Error(message) });
}

function connectSocket(options, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const cleanup = () => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onConnect = () => { cleanup(); resolve(socket); };
    const onError = (error) => { cleanup(); socket.destroy(); reject(transportError(`proxy connection failed: ${error.message}`)); };
    const onAbort = () => { cleanup(); socket.destroy(); reject(abortError()); };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function write(socket, data) {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(transportError(`proxy write failed: ${error.message}`)) : resolve()));
  });
}

/** Open a CONNECT tunnel and return the (optionally TLS-wrapped) socket. */
async function openTunnel(proxy, url, { signal, tlsOptions }) {
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const socket = await connectSocket({ host: proxy.host, port: proxy.port }, signal);
  try {
    const head = [
      `CONNECT ${host}:${port} HTTP/1.1`,
      `Host: ${host}:${port}`,
      ...(proxy.authorization === undefined ? [] : [`Proxy-Authorization: ${proxy.authorization}`]),
      'Proxy-Connection: keep-alive',
      '',
      '',
    ].join('\r\n');
    await write(socket, head);
    const { head: headBuffer, rest } = await readHead(socket, signal);
    // A proxy may already have sent bytes that belong to the tunnelled stream;
    // dropping them would corrupt whatever protocol starts next.
    if (rest.length > 0) socket.unshift(rest);
    const status = Number(headBuffer.toString('latin1').split('\r\n', 1)[0].split(' ')[1]);
    if (status !== 200) throw transportError(`proxy refused CONNECT with ${status}`);
    if (url.protocol !== 'https:') return socket;
    return await new Promise((resolve, reject) => {
      const secured = tls.connect({ socket, servername: net.isIP(host) === 0 ? host : undefined, ALPNProtocols: ['http/1.1'], ...tlsOptions });
      const cleanup = () => {
        secured.removeListener('secureConnect', onSecure);
        secured.removeListener('error', onErrorSecured);
        signal?.removeEventListener('abort', onAbortSecured);
      };
      const onSecure = () => { cleanup(); resolve(secured); };
      const onErrorSecured = (error) => { cleanup(); secured.destroy(); reject(transportError(`proxy TLS handshake failed: ${error.message}`)); };
      const onAbortSecured = () => { cleanup(); secured.destroy(); reject(abortError()); };
      secured.once('secureConnect', onSecure);
      secured.once('error', onErrorSecured);
      signal?.addEventListener('abort', onAbortSecured, { once: true });
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Read bytes until the blank line that ends an HTTP head. */
function readHead(socket, signal) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      signal?.removeEventListener('abort', onAbort);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > MAX_HEADER_BYTES) { cleanup(); reject(transportError('proxy response head too large')); }
        return;
      }
      cleanup();
      socket.pause();
      resolve({ head: buffer.subarray(0, end + 4), rest: buffer.subarray(end + 4) });
    };
    const onError = (error) => { cleanup(); reject(transportError(`proxy read failed: ${error.message}`)); };
    const onEnd = () => { cleanup(); reject(transportError('proxy closed the connection before responding')); };
    const onAbort = () => { cleanup(); socket.destroy(); reject(abortError()); };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseHead(head) {
  const text = head.toString('latin1');
  const [statusLine, ...lines] = text.split('\r\n');
  const status = Number(statusLine.split(' ')[1]);
  const headers = new Headers();
  for (const line of lines) {
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    try { headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim()); } catch { /* ignore malformed header */ }
  }
  return { status, headers };
}

function decodeChunked(body) {
  const parts = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd === -1) return undefined;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) return undefined;
    const start = lineEnd + 2;
    if (size === 0) {
      const next = body.indexOf('\r\n', start);
      if (next === -1) return undefined;
      return Buffer.concat(parts);
    }
    if (start + size > body.length) return undefined;
    parts.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
  return undefined;
}

/** Read one HTTP response body from an already-tunnelled socket. */
function readResponse(socket, { method, signal, idleTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let head;
    let settled = false;
    const timer = setTimeout(() => finish(transportError('proxy response timed out')), idleTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const complete = () => {
      if (head === undefined) return undefined;
      if (method === 'HEAD' || head.status === 204 || head.status === 304) return Buffer.alloc(0);
      const encoding = (head.headers.get('transfer-encoding') ?? '').toLowerCase();
      if (encoding.includes('chunked')) return decodeChunked(buffer);
      const length = head.headers.get('content-length');
      if (length !== null && /^\d+$/.test(length.trim())) {
        const want = Number(length.trim());
        return buffer.length >= want ? buffer.subarray(0, want) : undefined;
      }
      return undefined;
    };
    const settleIfComplete = () => {
      if (head === undefined) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (buffer.length > MAX_HEADER_BYTES) finish(transportError('proxy response head too large'));
          return;
        }
        head = parseHead(buffer.subarray(0, end + 4));
        buffer = buffer.subarray(end + 4);
      }
      const body = complete();
      if (body !== undefined) finish(undefined, { status: head.status, headers: head.headers, body });
    };
    const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); settleIfComplete(); };
    const onError = (error) => finish(transportError(`proxy response failed: ${error.message}`));
    const onEnd = () => {
      settleIfComplete();
      if (settled) return;
      if (head !== undefined && (head.headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
        const body = decodeChunked(buffer);
        if (body !== undefined) { finish(undefined, { status: head.status, headers: head.headers, body }); return; }
      }
      if (head !== undefined && head.headers.get('content-length') === null) {
        finish(undefined, { status: head.status, headers: head.headers, body: buffer });
        return;
      }
      finish(transportError('proxy closed the connection before the response was complete'));
    };
    const onAbort = () => { socket.destroy(); finish(abortError()); };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function requestHead(url, method, headers, proxy) {
  const path = `${url.pathname}${url.search}`;
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${url.host}`];
  const seen = new Set(['host', 'connection', 'accept-encoding', 'proxy-authorization', 'content-length']);
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`${name}: ${value}`);
  });
  lines.push('Accept-Encoding: identity');
  lines.push('Connection: close');
  lines.push('', '');
  return lines.join('\r\n');
}

/**
 * Fetch one URL through a proxy, returning a real `Response`.
 *
 * The caller's `init` is honoured for method, headers, body, signal and
 * `redirect: 'error'` (a 3xx then throws, exactly like native fetch). Every
 * request is sent inside a `CONNECT` tunnel, so a proxy that refuses CONNECT
 * fails here; falling back to a direct request is the caller's decision (see
 * `createProxyFetch`), not this function's.
 */
export async function requestThroughProxy(url, proxy, init = {}, {
  tlsOptions = {}, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, timeoutMs,
} = {}) {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortError();
  const method = String(init.method ?? 'GET').toUpperCase();
  const socket = await openTunnel(proxy, url, { signal, tlsOptions });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => socket.destroy(), timeoutMs);
  try {
    const headers = new Headers(init.headers ?? {});
    if (init.body !== undefined && init.body !== null && !headers.has('content-length')) {
      const length = typeof init.body === 'string' ? Buffer.byteLength(init.body) : (init.body.byteLength ?? 0);
      headers.set('Content-Length', String(length));
    }
    await write(socket, requestHead(url, method, headers, proxy));
    if (init.body !== undefined && init.body !== null) {
      await write(socket, typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body.buffer ?? init.body, init.body.byteOffset ?? 0, init.body.byteLength ?? init.body.length ?? 0));
    }
    const response = await readResponse(socket, { method, signal, idleTimeoutMs });
    // Native fetch rejects a redirect in `redirect: 'error'` mode; the catalog
    // caller relies on that to classify a captive portal as a transport error
    // rather than an HTTP failure.
    if (init.redirect === 'error' && response.status >= 300 && response.status < 400) {
      throw new TypeError('unexpected redirect');
    }
    const body = method === 'HEAD' || response.status === 204 || response.status === 304 ? null : response.body;
    return new Response(body, { status: response.status, headers: response.headers });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    socket.destroy();
  }
}

/**
 * Build a fetch-compatible function that honours the environment and the macOS
 * system proxy.
 *
 * The direct request always goes first: a machine whose vendor APIs are
 * reachable keeps exactly the behaviour it had before this module existed
 * (including a host, or a test, that replaced `globalThis.fetch`). When a proxy
 * is configured it is a *safe alternative*, not a detour:
 *
 *   - direct fails fast             -> the proxy retries immediately;
 *   - direct is slow (a black-holed -> the proxy starts after `hedgeDelayMs`
 *     corporate network, for example)    and the first successful response wins;
 *   - one side fails while the      -> the other keeps its chance.
 *     other is still running
 *
 * The losing attempt is aborted so no socket or body is left behind.
 */
export function createProxyFetch({
  env = process.env,
  platform = process.platform,
  systemProxy = readSystemProxy,
  directFetch,
  tlsOptions = {},
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  fallbackToDirect = true,
  hedgeDelayMs = 2_500,
  useProxy,
} = {}) {
  // Resolved per call: the host (and the tests) may replace globalThis.fetch
  // after this module is imported, and a frozen reference would silently
  // bypass that transport.
  const direct = () => directFetch ?? globalThis.fetch;
  return async function proxyFetch(input, init = {}) {
    // A live predicate, not a captured boolean: the switch may flip while a
    // request is queued, and "off" must mean the plain transport immediately.
    if (typeof useProxy === 'function' && !useProxy()) return direct()(input, init);
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? input));
    if (!fallbackToDirect) return direct()(input, init);
    const proxy = await resolveProxyFor(url, { env, platform, systemProxy });
    if (proxy === undefined) return direct()(input, init);
    if (init.signal?.aborted) throw abortError();
    debug(`proxy ${proxy.host}:${proxy.port} available for ${url.origin}`);

    const callerSignal = init.signal ?? undefined;
    const links = [];
    const controllers = new Set();
    let settled = false;
    let directFailed = false;
    let directError;
    let proxyState = 'idle';
    let proxyError;
    let hedgeTimer;

    const link = (controller) => {
      controllers.add(controller);
      if (callerSignal === undefined) return;
      const onAbort = () => controller.abort();
      callerSignal.addEventListener('abort', onAbort, { once: true });
      links.push(() => callerSignal.removeEventListener('abort', onAbort));
    };
    const stopOthers = (winner) => {
      for (const controller of controllers) {
        if (controller !== winner) controller.abort();
      }
    };

    return await new Promise((resolve, reject) => {
      const onCallerAbort = () => finish(abortError());
      const finish = (error, response, winner) => {
        if (settled) return;
        settled = true;
        clearTimeout(hedgeTimer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
        stopOthers(winner);
        for (const unlink of links) unlink();
        if (error !== undefined) reject(error); else resolve(response);
      };
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      const startProxy = (why) => {
        if (proxyState !== 'idle' || settled) return;
        proxyState = 'running';
        proxyError = why;
        clearTimeout(hedgeTimer);
        const controller = new AbortController();
        link(controller);
        requestThroughProxy(url, proxy, { ...init, signal: controller.signal }, { tlsOptions, idleTimeoutMs }).then(
          (response) => finish(undefined, response, controller),
          (error) => {
            if (settled) return;
            if (error?.name === 'AbortError' && callerSignal?.aborted) { finish(abortError()); return; }
            debug(`proxy request failed (${error?.cause?.message ?? error?.message})`);
            // The proxy was the last hope: if the direct attempt is already gone,
            // its error (or the proxy's) ends the request. Otherwise the direct
            // attempt is still running and its own handler decides.
            proxyState = 'failed';
            proxyError = error;
            if (directFailed) finish(error ?? directError);
          },
        );
      };
      const controller = new AbortController();
      link(controller);
      direct()(input, { ...init, signal: controller.signal }).then(
        (response) => finish(undefined, response, controller),
        (error) => {
          if (settled) return;
          if (error?.name === 'AbortError' && callerSignal?.aborted) { finish(abortError()); return; }
          directFailed = true;
          directError = error;
          debug(`direct request failed (${error?.cause?.message ?? error?.message}); trying the proxy`);
          if (proxyState === 'failed') { finish(error); return; }
          startProxy(undefined);
        },
      );
      if (hedgeDelayMs > 0 && Number.isFinite(hedgeDelayMs)) {
        hedgeTimer = setTimeout(() => startProxy(undefined), hedgeDelayMs);
      }
    });
  };
}

/** Default transport used by the catalog calls. */
export const proxyFetch = createProxyFetch();
