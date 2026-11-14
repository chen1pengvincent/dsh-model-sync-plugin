import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SystemProxyPolicy, detectSystemProxy, launchEnvironment, HARNESS_POLICY_PACKAGE,
} from '../lib/proxy-policy.js';
import { createProxyFetch } from '../lib/net-proxy.js';
import { SyncState } from '../lib/state.js';
import { createServer } from 'node:net';

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-sync-proxy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('launchEnvironment mirrors one URL into the names the Harness reads', () => {
  const entries = launchEnvironment('http://127.0.0.1:7897');
  assert.ok(entries instanceof Map);
  for (const name of ['https_proxy', 'http_proxy', 'all_proxy']) {
    assert.deepEqual(entries.get(name), { value: 'http://127.0.0.1:7897' });
  }
  // An empty environment is the explicit direct policy; it must not contain a
  // `{ value: undefined }` entry, which the Harness policy would try to trim.
  assert.equal(launchEnvironment().size, 0);
  assert.equal(launchEnvironment('').size, 0);
});

test('detectSystemProxy prefers the environment, then the system setting', async () => {
  const fromEnv = await detectSystemProxy({
    env: { HTTPS_PROXY: 'http://10.0.0.9:3128' }, platform: 'darwin',
    read: async () => ({ https: { host: '127.0.0.1', port: 7897 } }),
  });
  assert.deepEqual(fromEnv, { url: 'http://10.0.0.9:3128', source: 'environment' });

  const fromSystem = await detectSystemProxy({
    env: {}, platform: 'darwin',
    read: async () => ({ http: { host: '127.0.0.1', port: 7897 } }),
  });
  assert.deepEqual(fromSystem, { url: 'http://127.0.0.1:7897', source: 'system' });

  // A SOCKS-only setup is not a policy this transport can honour: report "none"
  // instead of pointing every request at a proxy that cannot be used.
  assert.equal(await detectSystemProxy({ env: { ALL_PROXY: 'socks5://127.0.0.1:7897' }, read: async () => undefined }), undefined);
  assert.equal(await detectSystemProxy({ env: {}, read: async () => undefined }), undefined);
});

test('SystemProxyPolicy installs once per value and reverts to direct when off', async () => {
  const calls = [];
  const disposers = [];
  const policy = new SystemProxyPolicy({
    logger: { info() {}, warn() {}, error() {} },
    detect: async () => ({ url: 'http://127.0.0.1:7897', source: 'system' }),
    probe: async () => true,
    install: async (env) => {
      calls.push(env);
      const disposer = () => { disposers.push(env); };
      return disposer;
    },
  });

  assert.equal(policy.status().enabled, false);
  const on = await policy.apply(true);
  assert.equal(on.enabled, true);
  assert.equal(on.installed, true);
  assert.equal(on.active, true);
  assert.equal(on.url, 'http://127.0.0.1:7897');
  assert.equal(on.source, 'system');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].get('https_proxy').value, 'http://127.0.0.1:7897');

  // Same value, no reason: no second install (the dispatcher is already ours).
  await policy.apply(true);
  assert.equal(calls.length, 1);

  const off = await policy.apply(false);
  assert.equal(off.enabled, false);
  assert.equal(off.installed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].size, 0, 'off must install an explicit direct policy');

  await policy.dispose();
  assert.equal(disposers.length, 1, 'the newest install is the one disposed');
});

test('SystemProxyPolicy reports an undetectable proxy but still turns itself on', async () => {
  const policy = new SystemProxyPolicy({
    logger: { info() {}, warn() {}, error() {} },
    detect: async () => undefined,
    probe: async () => { throw new Error('must not probe without a proxy'); },
    install: async () => () => {},
  });
  const status = await policy.apply(true);
  assert.equal(status.enabled, true);
  assert.equal(status.installed, true);
  assert.equal(status.active, false);
  assert.equal(status.url, undefined);
  assert.match(status.reason, /未检测到可用的系统代理/);
});

test('SystemProxyPolicy never throws when the Harness package is missing', async () => {
  const warnings = [];
  const policy = new SystemProxyPolicy({
    logger: { info() {}, warn(message) { warnings.push(message); }, error() {} },
    detect: async () => ({ url: 'http://127.0.0.1:7897', source: 'system' }),
    probe: async () => true,
    install: async () => { throw new Error('Cannot find package'); },
  });
  const status = await policy.apply(true);
  assert.equal(status.installed, false);
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

test('the controller applies and persists the switch, and reports it in status', async () => {
  const { SyncController } = await import('../lib/sync.js');
  const applied = [];
  const state = {
    data: { proxyEnabled: true, lastCheck: { at: 0, results: [] }, selectionHabits: {} },
    proxyEnabled() { return this.data.proxyEnabled !== false; },
    setProxyEnabled(value) { this.data.proxyEnabled = value; },
    save() {},
    catalog() { return undefined; },
    readModelsDevCache() { return undefined; },
  };
  const controller = new SyncController({
    ctx: { get() { return undefined; } },
    state,
    logger: { info() {}, warn() {}, error() {} },
  });
  controller.routeTargets = () => [];
  controller.managedSiblings = () => [];
  controller.proxy = {
    apply: async (enabled) => { applied.push(enabled); return { enabled, installed: true, url: 'http://127.0.0.1:7897', source: 'system', reason: undefined, transport: 'harness' }; },
    status: () => ({ enabled: state.data.proxyEnabled, installed: true, url: 'http://127.0.0.1:7897', source: 'system' }),
    dispose: async () => {},
  };

  await assert.rejects(() => controller.setProxyEnabled('false'), /布尔值/);
  assert.deepEqual(applied, [], 'a non-boolean must not reach the dispatcher');

  const off = await controller.setProxyEnabled(false);
  assert.deepEqual(applied, [false]);
  assert.equal(state.data.proxyEnabled, false, 'the intent is persisted so a restart retries');
  assert.equal(off.proxy.enabled, false);
  assert.equal(controller.status().proxy.enabled, false);
  assert.equal(controller.proxyEnabled(), false);
});

test('harnessPolicyCandidates walks up from the host entry to its node_modules', async () => {
  const { harnessPolicyCandidates } = await import('../lib/proxy-policy.js');
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
    logger: { info() {}, warn() {}, error() {} },
    detect: async () => ({ url: 'http://127.0.0.1:7897', source: 'system' }),
    probe: async () => false,
    install: async (env) => { installed.push(env); return () => {}; },
  });
  const status = await policy.apply(true);
  assert.equal(status.enabled, true);
  assert.equal(status.installed, true);
  assert.equal(status.active, false, 'a dead listener must not be routed through');
  assert.equal(status.url, 'http://127.0.0.1:7897', 'the URL is still reported for the user');
  assert.match(status.reason, /连接失败/);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].size, 0, 'the installed policy is the explicit direct one');
});

test('probeProxy reports a listening port as alive and a closed one as dead', async (t) => {
  const { probeProxy } = await import('../lib/proxy-policy.js');
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => server.close());
  assert.equal(await probeProxy(`http://127.0.0.1:${port}`), true);
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
