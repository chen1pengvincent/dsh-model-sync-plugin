import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  SystemProxyPolicy, detectProxies, launchEnvironment, parseHarnessProxy,
  probeProxy, HARNESS_POLICY_PACKAGE, harnessPolicyCandidates,
} from '../lib/proxy-policy.js';
import { createProxyFetch } from '../lib/net-proxy.js';
import { SyncState } from '../lib/state.js';

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-sync-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const silent = { info() {}, warn() {}, error() {} };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('parseHarnessProxy keeps the URL the Harness package needs', () => {
  assert.deepEqual(parseHarnessProxy('http://127.0.0.1:7897'), {
    host: '127.0.0.1', port: 7897, url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897',
  });
  // No scheme means http, and an https proxy is a supported value (undici speaks
  // TLS to it) — dropping it here used to disable the switch for those users.
  assert.equal(parseHarnessProxy('127.0.0.1:7897').url, 'http://127.0.0.1:7897');
  const secure = parseHarnessProxy('https://proxy.example.com');
  assert.equal(secure.url, 'https://proxy.example.com:443');
  // Credentials must survive into the installed value but never into a status.
  const auth = parseHarnessProxy('http://user:p%40ss@10.0.0.9:3128');
  assert.equal(auth.url, 'http://user:p%40ss@10.0.0.9:3128');
  assert.equal(auth.display, 'http://***@10.0.0.9:3128');
  assert.doesNotMatch(auth.display, /p%40ss|user/);
  // IPv6 hosts stay bracketed so undici can parse the URL.
  const v6 = parseHarnessProxy('http://[::1]:7897');
  assert.equal(v6.host, '::1');
  assert.equal(v6.url, 'http://[::1]:7897');
  for (const value of ['socks5://127.0.0.1:7897', 'pac+http://x', '', '   ', 'http://', 'http://host:0', 'http://host:99999', undefined, 42]) {
    assert.equal(parseHarnessProxy(value), undefined, `rejects ${String(value)}`);
  }
});

test('launchEnvironment mirrors one URL and passes the bypass list through', () => {
  const entries = launchEnvironment('http://127.0.0.1:7897');
  assert.ok(entries instanceof Map);
  for (const name of ['https_proxy', 'http_proxy', 'all_proxy']) {
    assert.deepEqual(entries.get(name), { value: 'http://127.0.0.1:7897' });
  }
  assert.equal(entries.has('no_proxy'), false);
  const withBypass = launchEnvironment('http://127.0.0.1:7897', ['localhost', ' *.internal ', '']);
  assert.deepEqual(withBypass.get('no_proxy'), { value: 'localhost,*.internal' });
  assert.deepEqual(withBypass.get('NO_PROXY'), { value: 'localhost,*.internal' });
  // An empty Map is the explicit direct policy; it must not contain a
  // `{ value: undefined }` entry, which the Harness policy would try to trim.
  assert.equal(launchEnvironment().size, 0);
  assert.equal(launchEnvironment('').size, 0);
});

test('detectProxies lists every candidate so a stale one cannot hide a live one', async () => {
  const env = { HTTPS_PROXY: 'http://10.0.0.9:3128', HTTP_PROXY: '127.0.0.1:7897', NO_PROXY: 'localhost' };
  const found = await detectProxies({ env, platform: 'darwin', read: async () => ({ https: { host: '127.0.0.1', port: 7897 }, bypass: ['*.local'] }) });
  assert.deepEqual(found.map((item) => item.url), ['http://10.0.0.9:3128', 'http://127.0.0.1:7897']);
  assert.equal(found[0].source, 'environment');
  assert.deepEqual(found[0].bypass, ['localhost']);
  assert.deepEqual(found[1].bypass, ['localhost']);

  const systemOnly = await detectProxies({
    env: {}, platform: 'darwin', read: async () => ({ http: { host: '127.0.0.1', port: 7897 }, bypass: ['*.local'] }),
  });
  assert.deepEqual(systemOnly.map((item) => item.url), ['http://127.0.0.1:7897']);
  assert.equal(systemOnly[0].source, 'system');
  assert.deepEqual(systemOnly[0].bypass, ['*.local']);

  // SOCKS-only is not a policy this transport can honour: report "none"
  // instead of pointing every request at a proxy that cannot be used.
  assert.deepEqual(await detectProxies({ env: { ALL_PROXY: 'socks5://127.0.0.1:7897' }, read: async () => undefined }), []);
  assert.deepEqual(await detectProxies({ env: {}, read: async () => undefined }), []);
  // A throwing `scutil` never escapes.
  assert.deepEqual(await detectProxies({ env: {}, read: async () => { throw new Error('scutil missing'); } }), []);
});

test('SystemProxyPolicy installs once per value and reverts to direct when off', async () => {
  const calls = [];
  const disposers = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }],
    probe: async () => true,
    install: async (env) => {
      calls.push(env);
      return () => { disposers.push(env); };
    },
  });

  assert.equal(policy.status().enabled, false);
  const on = await policy.apply(true);
  assert.equal(on.enabled, true);
  assert.equal(on.installed, true);
  assert.equal(on.active, true);
  assert.equal(on.url, 'http://127.0.0.1:7897');
  assert.equal(on.source, 'system');
  assert.equal(on.transport, 'harness');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].get('https_proxy').value, 'http://127.0.0.1:7897');

  // Same value, no reason: no second install (the dispatcher is already ours).
  await policy.apply(true);
  assert.equal(calls.length, 1);

  const off = await policy.apply(false);
  assert.equal(off.enabled, false);
  assert.equal(off.installed, true);
  assert.equal(off.active, false);
  assert.equal(off.reason, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].size, 0, 'off must install an explicit direct policy');

  await policy.dispose();
  assert.equal(disposers.length, 2, 'the replaced install was disposed, and dispose() released the newest');
  assert.equal(policy.status().installed, false);
});

test('an undetectable proxy leaves the launcher policy alone', async () => {
  const installed = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [],
    probe: async () => { throw new Error('must not probe without a proxy'); },
    install: async (env) => { installed.push(env); return () => {}; },
  });
  const status = await policy.apply(true);
  assert.equal(status.enabled, true);
  assert.equal(status.installed, false, 'nothing is installed without a proxy');
  assert.equal(status.active, false);
  assert.equal(status.url, undefined);
  assert.equal(status.transport, 'plugin');
  assert.match(status.reason, /未检测到可用的系统代理/);
  assert.equal(installed.length, 0, 'the explicit-direct policy must not replace the launcher policy');
});

test('turning the switch off after a skipped attempt still forces direct', async () => {
  const installed = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [],
    install: async (env) => { installed.push(env.size); return () => {}; },
  });
  await policy.apply(true);
  assert.deepEqual(installed, []);
  const off = await policy.apply(false);
  assert.deepEqual(installed, [0]);
  assert.equal(off.installed, true);
});

test('SystemProxyPolicy never throws when the Harness package is missing', async () => {
  const warnings = [];
  const policy = new SystemProxyPolicy({
    logger: { info() {}, warn(message) { warnings.push(message); }, error() {} },
    detect: async () => [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }],
    probe: async () => true,
    install: async () => { throw new Error('Cannot find package'); },
  });
  const status = await policy.apply(true);
  assert.equal(status.installed, false);
  assert.equal(status.active, false);
  assert.match(status.reason, /无法接管宿主网络/);
  assert.equal(warnings.length, 1);
});

test(`the Harness policy package is the documented one (${HARNESS_POLICY_PACKAGE})`, () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(typeof pkg.name, 'string');
  assert.equal(HARNESS_POLICY_PACKAGE, '@deepseek-ai/dsh-http-proxy');
});

test('createProxyFetch honours a live useProxy predicate', async () => {
  let enabled = false;
  const seen = [];
  const fetchImpl = createProxyFetch({
    useProxy: () => enabled,
    directFetch: async (input) => { seen.push(String(input)); return new Response('direct'); },
    systemProxy: async () => undefined,
  });
  const first = await fetchImpl('https://example.test/one');
  assert.equal(await first.text(), 'direct');
  enabled = true;
  // No system proxy is available in this fixture, so the call still ends on the
  // direct path — the point is that the predicate is consulted per request.
  const second = await fetchImpl('https://example.test/two');
  assert.equal(await second.text(), 'direct');
  assert.deepEqual(seen, ['https://example.test/one', 'https://example.test/two']);
});

test('SyncState defaults the switch on and persists an explicit choice', (t) => {
  const dir = temporary(t);
  const state = new SyncState(dir);
  assert.equal(state.proxyEnabled(), true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).proxyEnabled, true);

  state.setProxyEnabled(false);
  assert.equal(state.proxyEnabled(), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).proxyEnabled, false);

  // A reload keeps the choice; a file written before the switch existed reads as
  // "on" instead of failing validation.
  const reloaded = new SyncState(dir);
  assert.equal(reloaded.proxyEnabled(), false);
});

test('the controller persists the choice before touching the dispatcher', async () => {
  const { SyncController } = await import('../lib/sync.js');
  const events = [];
  const state = {
    data: { proxyEnabled: true, lastCheck: { at: 0, results: [] }, selectionHabits: {} },
    proxyEnabled() { return this.data.proxyEnabled !== false; },
    setProxyEnabled(value) { events.push(`state:${value}`); this.data.proxyEnabled = value; },
    save() {},
    catalog() { return undefined; },
    readModelsDevCache() { return undefined; },
  };
  const controller = new SyncController({ ctx: { get() { return undefined; } }, state, logger: silent });
  controller.routeTargets = () => [];
  controller.managedSiblings = () => [];
  controller.proxy = {
    disposed: false,
    apply: async (enabled) => { events.push(`apply:${enabled}`); return { enabled, installed: true, active: enabled, url: 'http://127.0.0.1:7897', source: 'system', reason: undefined, transport: 'harness' }; },
    status: () => ({ enabled: state.data.proxyEnabled, installed: true, url: 'http://127.0.0.1:7897', source: 'system' }),
    dispose: async () => {},
  };

  await assert.rejects(() => controller.setProxyEnabled('false'), /布尔值/);
  assert.deepEqual(events, [], 'a non-boolean must not reach the dispatcher');

  const off = await controller.setProxyEnabled(false);
  assert.deepEqual(events, ['state:false', 'apply:false'], 'persist first, then install');
  assert.equal(state.data.proxyEnabled, false, 'the intent is persisted so a restart retries');
  assert.equal(off.proxy.enabled, false);

  // While the plugin is unloading, the route must fail instead of teaching the
  // user that the switch worked.
  controller.proxy.disposed = true;
  await assert.rejects(() => controller.setProxyEnabled(true), (error) => error.status === 409);
});

test('harnessPolicyCandidates walks up from the host entry to its node_modules', () => {
  assert.deepEqual(harnessPolicyCandidates(undefined), []);
  assert.deepEqual(harnessPolicyCandidates(''), []);
  const candidates = harnessPolicyCandidates('/Applications/X.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.ok(candidates.length >= 5, 'walks several ancestors without assuming one depth');
  assert.ok(candidates.some((path) => path.endsWith('/app.asar/node_modules/@deepseek-ai/dsh-http-proxy/lib/index.js')),
    'the asar root node_modules layout is covered');
  assert.ok(candidates.some((path) => path.endsWith('/Resources/node_modules/@deepseek-ai/dsh-http-proxy/lib/index.js')),
    'a hoisted layout is covered too');
});

test('a configured but dead proxy never becomes a process-wide outage', async () => {
  const installed = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }],
    probe: async () => false,
    install: async (env) => { installed.push(env); return () => {}; },
  });
  const status = await policy.apply(true);
  assert.equal(status.enabled, true);
  assert.equal(status.installed, false, 'a dead listener must not be installed');
  assert.equal(status.active, false);
  assert.equal(status.url, undefined, 'a dead proxy is not reported as the active URL');
  assert.match(status.reason, /连接失败/);
  assert.equal(installed.length, 0);
});

test('the first live candidate wins over an earlier dead one', async () => {
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [
      { url: 'http://10.0.0.9:3128', display: 'http://10.0.0.9:3128', source: 'environment' },
      { url: 'https://user:pass@proxy.test:8443', display: 'https://***@proxy.test:8443', source: 'environment' },
    ],
    probe: async (url) => url.includes('proxy.test'),
    install: async (env) => () => env,
  });
  const status = await policy.apply(true);
  assert.equal(status.active, true);
  assert.equal(status.url, 'https://***@proxy.test:8443', 'the status never carries the password');
  assert.equal(status.source, 'environment');
});

test('probeProxy reports a listening port as alive and a closed one as dead', async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => server.close());
  assert.equal(await probeProxy(`http://127.0.0.1:${port}`), true);
  assert.equal(await probeProxy('http://[::1]:1', 120), false, 'a bracketed IPv6 URL parses instead of throwing');
  const closed = await new Promise((resolve) => {
    const probe = createServer(() => {});
    probe.listen(0, '127.0.0.1', () => {
      const free = probe.address().port;
      probe.close(() => resolve(free));
    });
  });
  assert.equal(await probeProxy(`http://127.0.0.1:${closed}`, 300), false);
  assert.equal(await probeProxy('not a url'), false);
});

test('switching again restores the previous install before replacing it', async () => {
  const events = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }],
    probe: async () => true,
    install: async (env) => {
      events.push(`install:${env.size}`);
      return async () => { events.push('dispose'); };
    },
  });
  await policy.apply(true);
  await policy.apply(false);
  assert.deepEqual(events, ['install:3', 'dispose', 'install:0']);
  await policy.dispose();
  assert.deepEqual(events, ['install:3', 'dispose', 'install:0', 'dispose']);
});

test('a failed replacement still leaves the launcher policy restored', async () => {
  let disposed = 0;
  let calls = 0;
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }],
    probe: async () => true,
    install: async () => {
      calls += 1;
      if (calls === 2) throw new Error('Cannot find package');
      return async () => { disposed += 1; };
    },
  });
  await policy.apply(true);
  const status = await policy.apply(false);
  assert.equal(disposed, 1, 'the previous policy was restored before the failed install');
  assert.equal(status.installed, false);
  assert.match(status.reason, /无法接管宿主网络/);
});

test('dispose waits for an in-flight install and uninstalls it', async () => {
  const events = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }],
    probe: async () => true,
    install: async () => {
      await delay(20);
      events.push('install');
      return async () => { events.push('dispose'); };
    },
  });
  const running = policy.apply(true);
  await delay(1);
  await policy.dispose();
  await running;
  assert.deepEqual(events, ['install', 'dispose'], 'an install that lands after unload must not stay installed');
  assert.equal(policy.status().installed, false);
  assert.equal(policy.status().active, false);
});

test('a late apply after dispose does not install anything', async () => {
  let installs = 0;
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }],
    probe: async () => true,
    install: async () => { installs += 1; return () => {}; },
  });
  await policy.dispose();
  const status = await policy.apply(true);
  assert.equal(status.enabled, false, 'a disposed policy never reports enabled');
  assert.equal(installs, 0);
});

test('a forced re-detection follows the machine proxy without bouncing an unchanged one', async () => {
  let current = [{ url: 'http://127.0.0.1:7897', display: 'http://127.0.0.1:7897', source: 'system' }];
  const installs = [];
  const disposed = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => current,
    probe: async () => true,
    install: async (env) => {
      const value = env.get('https_proxy')?.value;
      installs.push(value);
      return () => disposed.push(value);
    },
  });

  await policy.apply(true);
  assert.deepEqual(installs, ['http://127.0.0.1:7897']);

  // Without `force` the cached decision stands, even if the machine moved.
  current = [{ url: 'http://127.0.0.1:1080', display: 'http://127.0.0.1:1080', source: 'system' }];
  await policy.apply(true);
  assert.equal(installs.length, 1);

  // Forced: swap to the new port, restoring the previous install first.
  const moved = await policy.apply(true, { force: true });
  assert.deepEqual(installs, ['http://127.0.0.1:7897', 'http://127.0.0.1:1080']);
  assert.deepEqual(disposed, ['http://127.0.0.1:7897'], 'the old dispatcher is disposed before the new one lands');
  assert.equal(moved.active, true);
  assert.equal(moved.url, 'http://127.0.0.1:1080');

  // Forced but unchanged: keep the live dispatcher instead of bouncing it.
  await policy.apply(true, { force: true });
  assert.equal(installs.length, 2, 'the same proxy must not be reinstalled');
  assert.deepEqual(disposed, ['http://127.0.0.1:7897']);

  // Forced and the machine has no proxy any more: hand control back honestly.
  current = [];
  const gone = await policy.apply(true, { force: true });
  assert.equal(gone.active, false);
  assert.equal(gone.installed, false);
  assert.match(gone.reason, /未检测到可用的系统代理/);
  assert.deepEqual(disposed, ['http://127.0.0.1:7897', 'http://127.0.0.1:1080']);
});

test('a forced re-detection reuses the same install when only the source label changed', async () => {
  let current = [{ url: 'http://10.0.0.9:3128', display: 'http://10.0.0.9:3128', source: 'system' }];
  const installs = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => current,
    probe: async () => true,
    install: async (env) => { installs.push(env.get('https_proxy')?.value); return () => {}; },
  });
  await policy.apply(true);
  // Installing rewrites process.env, so the same proxy legitimately comes back
  // labelled `environment` next time — that alone must not bounce the dispatcher.
  current = [{ url: 'http://10.0.0.9:3128', display: 'http://10.0.0.9:3128', source: 'environment' }];
  const status = await policy.apply(true, { force: true });
  assert.equal(status.active, true);
  assert.equal(status.source, 'environment');
  assert.equal(installs.length, 1);
});

test('a forced re-detection is keyed on the endpoint, not the no_proxy spelling', async () => {
  let current = [{ url: 'http://10.0.0.9:3128', display: 'http://10.0.0.9:3128', source: 'system', bypass: ['localhost'] }];
  const installs = [];
  const policy = new SystemProxyPolicy({
    logger: silent,
    detect: async () => current,
    probe: async () => true,
    install: async (env) => { installs.push(env.get('no_proxy')?.value); return () => {}; },
  });
  await policy.apply(true);
  assert.deepEqual(installs, ['localhost']);
  // The Harness policy appends loopback escapes when it writes process.env, so
  // reading our own install back yields a longer list; that must not churn.
  current = [{ url: 'http://10.0.0.9:3128', display: 'http://10.0.0.9:3128', source: 'environment', bypass: ['localhost', '::1', '[::1]'] }];
  const status = await policy.apply(true, { force: true });
  assert.equal(status.active, true);
  assert.equal(installs.length, 1, 'the endpoint did not change, so nothing is reinstalled');
});
