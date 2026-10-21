import { test } from 'node:test';
import assert from 'node:assert/strict';

import { profileHosts } from '../lib/index.js';
import {
  SESSION_HEADER,
  hasSessionHeader,
  headerValueFor,
  installSessionHeader,
  patchFetch,
  providerMatches,
  resolveHeaderConfig,
  safeHeaderValue,
  targetsHost,
  withStore,
} from '../lib/session-header.js';

test('resolveHeaderConfig defaults to enabled uuid mode for opencode providers', () => {
  const resolved = resolveHeaderConfig(undefined);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.mode, 'uuid');
  assert.deepEqual(resolved.prefixes, ['opencode-go', 'opencode']);
  assert.equal(resolveHeaderConfig(false).enabled, false);
  assert.equal(resolveHeaderConfig({ enabled: false }).enabled, false);
  assert.equal(resolveHeaderConfig({ mode: 'session-id' }).mode, 'session-id');
  assert.equal(resolveHeaderConfig({ mode: 'nope' }).mode, 'uuid');
  assert.deepEqual(resolveHeaderConfig({ providers: ['my-gateway'] }).prefixes, ['my-gateway']);
});

test('providerMatches accepts the primary route and its siblings only', () => {
  const prefixes = ['opencode-go'];
  assert.equal(providerMatches('opencode-go', prefixes), true);
  assert.equal(providerMatches('opencode-go-responses', prefixes), true);
  assert.equal(providerMatches('opencode-go-messages', prefixes), true);
  assert.equal(providerMatches('opencode-gopher', prefixes), false);
  assert.equal(providerMatches('openrouter', prefixes), false);
  assert.equal(providerMatches(undefined, prefixes), false);
});

test('safeHeaderValue only admits visible ASCII', () => {
  assert.equal(safeHeaderValue('session-abc_123'), true);
  assert.equal(safeHeaderValue(''), false);
  assert.equal(safeHeaderValue('中文会话'), false);
  assert.equal(safeHeaderValue('line\nbreak'), false);
});

test('headerValueFor is opaque, stable per session, and distinct across sessions', () => {
  const table = new Map();
  const a1 = headerValueFor('session-a', 'uuid', table);
  const a2 = headerValueFor('session-a', 'uuid', table);
  const b = headerValueFor('session-b', 'uuid', table);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^[0-9a-f-]{36}$/);
  assert.equal(headerValueFor('session-a', 'session-id', table), 'session-a');
  assert.equal(headerValueFor('bad\nid', 'uuid', table), undefined);
  assert.equal(headerValueFor(undefined, 'uuid', table), undefined);
});

test('hasSessionHeader mirrors native precedence', () => {
  assert.equal(hasSessionHeader('https://opencode.ai/x', { headers: { [SESSION_HEADER]: 'v' } }), true);
  assert.equal(hasSessionHeader('https://opencode.ai/x', { headers: {} }), false);
  assert.equal(hasSessionHeader('https://opencode.ai/x', undefined), false);
  const req = new Request('https://opencode.ai/x', { headers: { [SESSION_HEADER]: 'v' } });
  assert.equal(hasSessionHeader(req, undefined), true);
});

test('targetsHost scopes to known hosts and fails the unknown-but-named case closed', () => {
  assert.equal(targetsHost('https://opencode.ai/zen/go/v1/chat/completions', ['opencode.ai']), true);
  assert.equal(targetsHost('https://evil.example/x', ['opencode.ai']), false);
  assert.equal(targetsHost('https://opencode.ai/x', []), true);
  assert.equal(targetsHost({ url: 'https://opencode.ai/x' }, ['opencode.ai']), true);
  assert.equal(targetsHost(new URL('https://opencode.ai/x'), ['opencode.ai']), true);
  assert.equal(targetsHost(new URL('https://evil.example/x'), ['opencode.ai']), false);
  assert.equal(targetsHost('not a url', ['opencode.ai']), false);
});

test('patchFetch injects only inside an active store, preserving other headers', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const als = new AsyncLocalStorage();
  const seen = [];
  const original = (input, init) => {
    seen.push({ input, headers: new Headers(init?.headers) });
    return Promise.resolve('ok');
  };
  const patched = patchFetch(original, als);

  await patched('https://opencode.ai/x', { headers: { authorization: 'Bearer k' } });
  assert.equal(seen.at(-1).headers.has(SESSION_HEADER), false);

  await als.run({ value: 'uuid-1', hosts: ['opencode.ai'] }, () => patched('https://opencode.ai/x', { headers: { authorization: 'Bearer k' } }));
  assert.equal(seen.at(-1).headers.get(SESSION_HEADER), 'uuid-1');
  assert.equal(seen.at(-1).headers.get('authorization'), 'Bearer k');

  await als.run({ value: 'uuid-1', hosts: ['opencode.ai'] }, () => patched('https://evil.example/x', {}));
  assert.equal(seen.at(-1).headers.has(SESSION_HEADER), false);

  await als.run({ value: 'uuid-1', hosts: ['opencode.ai'] }, () => patched('https://opencode.ai/x', { headers: { [SESSION_HEADER]: 'preset' } }));
  assert.equal(seen.at(-1).headers.get(SESSION_HEADER), 'preset');
});

test('withStore makes the context visible to pulls of a downstream generator', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const als = new AsyncLocalStorage();
  let seen;
  const downstream = (async function* () {
    seen = als.getStore();
    yield 1;
  })();
  const wrapped = withStore(downstream, { value: 'v' }, als);
  assert.equal(als.getStore(), undefined);
  for await (const chunk of wrapped) assert.equal(chunk, 1);
  assert.deepEqual(seen, { value: 'v' });
});

function fakeCtx() {
  const effects = [];
  const listeners = [];
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      const cleanup = fn();
      effects.push({ cleanup, label });
      return () => cleanup?.();
    },
    on(name, handler, options) {
      listeners.push({ name, handler, options });
      return () => {};
    },
    effects,
    listeners,
  };
}

test('installSessionHeader installs the fetch patch and restores it on dispose', async () => {
  const ctx = fakeCtx();
  const original = globalThis.fetch;
  const spy = () => Promise.resolve('ok');
  globalThis.fetch = spy;
  try {
    const handle = installSessionHeader(ctx, undefined, { resolveHosts: () => ['opencode.ai'] });
    assert.equal(handle.installed, true);
    assert.notEqual(globalThis.fetch, spy);
    assert.equal(ctx.effects.length, 1);
    assert.equal(ctx.listeners[0].name, 'llm/stream');
    assert.equal(ctx.listeners[0].options.prepend, true);

    // The wrapped stream runs its body inside the store, so a fetch issued from
    // it carries the header; an unrelated provider is passed through untouched.
    let receivedHeader;
    const handler = ctx.listeners[0].handler;
    const downstream = (async function* () {
      await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', { headers: {} });
      receivedHeader = 'x';
      yield 1;
    })();
    const wrapped = handler({ provider: 'opencode-go-responses', sessionId: 'session-1' }, () => downstream);
    for await (const _ of wrapped) { /* drain */ }
    assert.equal(receivedHeader, 'x');

    const unrelated = (async function* () { yield 2; })();
    assert.equal(handler({ provider: 'openrouter', sessionId: 's' }, () => unrelated), unrelated);

    handle.dispose();
    assert.equal(globalThis.fetch, spy);
    assert.equal(handle.installed, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('installSessionHeader can be disabled by config', () => {
  const ctx = fakeCtx();
  const original = globalThis.fetch;
  try {
    const handle = installSessionHeader(ctx, false, {});
    assert.equal(handle.installed, false);
    assert.equal(ctx.effects.length, 0);
    assert.equal(globalThis.fetch, original);
  } finally {
    globalThis.fetch = original;
  }
});

test('profileHosts reads entry-based settings through describe()', () => {
  const ctx = {
    get: () => ({
      describe: () => [{
        ns: 'llm-pi-ai',
        value: {
          providers: {
            'opencode-go': { baseURL: 'https://gateway.example/v1' },
            opencode: { baseUrl: 'https://console.example/api' },
          },
        },
      }],
    }),
  };
  assert.deepEqual(profileHosts(ctx, 'opencode-go'), ['gateway.example']);
  assert.deepEqual(profileHosts(ctx, 'opencode'), ['console.example']);
  assert.deepEqual(profileHosts(ctx, 'missing'), []);
});
