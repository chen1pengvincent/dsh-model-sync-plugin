/**
 * dsh-model-sync — OpenCode session header half.
 *
 * OpenCode Go requires every inference request to carry a stable
 * per-conversation `x-opencode-session` header (it answers
 * `400 MissingSessionID` otherwise) and uses the value to pin one
 * conversation's requests to the same upstream replica, keeping its prompt
 * cache warm across turns. The pi-ai adapter DSH shipped when this half was
 * written (0.85.1) never sent the header; later versions may, and the fetch
 * guard leaves an existing header untouched. A static `headers:` entry in
 * settings is the wrong tool either way: one
 * fixed value collapses every conversation into a single affinity bucket and
 * the thread's measurements show the resulting cache-hit regression.
 *
 * This attaches the header at request time, per conversation, without touching
 * settings:
 *
 *   1. The `llm/stream` waterfall hands us the request options — including
 *      `provider` and the durable `sessionId` the agent loop stamps on every
 *      loop-built request.
 *   2. For OpenCode routes we drive the downstream (lazy) chunk stream inside
 *      an AsyncLocalStorage store. The adapter only reaches the network while
 *      that stream is being pulled, so the store is active exactly when the
 *      HTTP call happens.
 *   3. A patched `globalThis.fetch` adds the header while a store is active,
 *      only for the OpenCode hosts, and only when the caller did not already
 *      set it. Every wire protocol goes through fetch, so one seam covers
 *      chat-completions, responses and anthropic-messages alike.
 *
 * The default value is an opaque random UUID per DSH session, so the internal
 * session id is never disclosed to a third party; `mode: 'session-id'` opts in
 * to sending the raw id.
 *
 * Pure helpers are exported for unit testing; nothing here imports the kernel.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const SESSION_HEADER = 'x-opencode-session';

/** Header values must be a ByteString: visible ASCII only (no 0x00-0x1f/0x7f+). */
const HEADER_VALUE_RE = /^[\x21-\x7e]+$/;

/** Bound the session→uuid map so a long-lived process cannot grow it forever. */
const UUID_TABLE_MAX = 4096;

/**
 * Default prefixes of the providers served by OpenCode Go. The plugin creates
 * siblings such as `opencode-go-responses` / `opencode-go-messages`, so the
 * match is by prefix (`<prefix>` or `<prefix>-…`), not by exact id.
 */
const DEFAULT_PROVIDER_PREFIXES = ['opencode-go', 'opencode'];

/** Normalize the `sessionHeader` config block. */
export function resolveHeaderConfig(config) {
  if (config === false || config?.enabled === false) {
    return { enabled: false, mode: 'uuid', prefixes: [] };
  }
  const prefixes = Array.isArray(config?.providers) && config.providers.length > 0
    ? config.providers.map((value) => String(value)).filter((value) => value.length > 0)
    : [...DEFAULT_PROVIDER_PREFIXES];
  const mode = config?.mode === 'session-id' ? 'session-id' : 'uuid';
  return { enabled: true, mode, prefixes };
}

/** True when a provider id belongs to one of the configured route prefixes. */
export function providerMatches(provider, prefixes) {
  if (provider === undefined || provider === null) return false;
  const id = String(provider);
  return prefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}-`));
}

/** True when a value can legally be used as an HTTP header value. */
export function safeHeaderValue(value) {
  const raw = String(value);
  return raw.length > 0 && HEADER_VALUE_RE.test(raw);
}

/**
 * Derive the opaque header value for one DSH session id.
 * @param sessionId - the durable conversation id from `options.sessionId`.
 * @param mode - `'uuid'` (default, opaque) or `'session-id'` (opt-in, raw).
 * @param table - per-install Map caching the session→uuid mapping.
 */
export function headerValueFor(sessionId, mode, table) {
  if (typeof sessionId !== 'string' && typeof sessionId !== 'number') return undefined;
  const raw = String(sessionId);
  if (!safeHeaderValue(raw)) return undefined;
  if (mode === 'session-id') return raw;
  let value = table.get(raw);
  if (value === undefined) {
    value = randomUUID();
    if (table.size >= UUID_TABLE_MAX) {
      const oldest = table.keys().next().value;
      if (oldest !== undefined) table.delete(oldest);
    }
    table.set(raw, value);
  }
  return value;
}

/**
 * The headers a fetch call carries, mirroring native precedence: `init.headers`
 * wins, otherwise a `Request`'s own headers are the base.
 */
function headerSource(input, init) {
  return init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
}

/** True when the outgoing request already carries the session header. */
export function hasSessionHeader(input, init) {
  const source = headerSource(input, init);
  if (source === undefined) return false;
  try {
    return new Headers(source).has(SESSION_HEADER);
  } catch {
    return false;
  }
}

/**
 * True when the request targets one of the OpenCode hosts. With no host list we
 * fail open (the store only exists for OpenCode providers), but a host we know
 * is a different one always declines.
 */
export function targetsHost(input, hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return true;
  try {
    const raw = typeof input === 'string'
      ? input
      : typeof URL !== 'undefined' && input instanceof URL
        ? input.href
        : input?.url;
    if (typeof raw !== 'string') return false;
    return hosts.includes(new URL(raw).host);
  } catch {
    return false;
  }
}

/** Build a fetch that injects the header while an ALS store is active. */
export function patchFetch(original, als) {
  return function patchedFetch(input, init) {
    const state = als.getStore();
    if (state !== undefined && !hasSessionHeader(input, init) && targetsHost(input, state.hosts)) {
      const headers = new Headers(headerSource(input, init));
      headers.set(SESSION_HEADER, state.value);
      return original.call(this, input, { ...init, headers });
    }
    return original.apply(this, arguments);
  };
}

/**
 * Wrap a downstream async iterable so every pull runs inside an ALS store.
 * Async generators inherit the store as long as their body is driven from a
 * pull made inside `als.run`, which is exactly what this does per `next()`.
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return als.run(store, () => iterator.next());
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value);
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value };
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error));
      }
      throw error;
    },
  };
}

/**
 * Install the `x-opencode-session` half on a cordis context.
 *
 * @param ctx - the plugin context (`effect`, `on`, `logger`).
 * @param config - the normalized-or-raw `sessionHeader` config block.
 * @param deps.resolveHosts - `(provider) => string[]`; host names to scope the
 *   patch to. Empty means "no host constraint" (still gated by provider).
 * @returns a small handle exposing the resolved config and a dispose hook.
 */
export function installSessionHeader(ctx, config, deps = {}) {
  const resolved = resolveHeaderConfig(config);
  const resolveHosts = typeof deps.resolveHosts === 'function' ? deps.resolveHosts : () => [];
  const handle = {
    ...resolved,
    installed: false,
    dispose: () => {},
    status: () => ({ ...resolved, installed: handle.installed }),
  };
  if (!resolved.enabled) return handle;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') {
    ctx.logger?.warn?.('dsh-model-sync: globalThis.fetch unavailable; cannot attach x-opencode-session');
    return handle;
  }

  const als = new AsyncLocalStorage();
  const uuidBySession = new Map();
  const patched = patchFetch(originalFetch, als);

  const removeEffect = ctx.effect(() => {
    handle.installed = true;
    globalThis.fetch = patched;
    ctx.logger?.info?.(`dsh-model-sync: attaching x-opencode-session for [${resolved.prefixes.join(', ')}] (mode=${resolved.mode})`);
    return () => {
      // Restore only if we are still the active patch — never clobber a patch
      // installed later by another plugin.
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
      handle.installed = false;
    };
  }, 'dsh-model-sync: fetch patch');

  ctx.on('llm/stream', (options, next) => {
    if (options === null || typeof options !== 'object') return next();
    if (!providerMatches(options.provider, resolved.prefixes)) return next();
    const sessionId = options.sessionId;
    if (sessionId === undefined || sessionId === null) return next();
    const value = headerValueFor(sessionId, resolved.mode, uuidBySession);
    if (value === undefined) return next();

    // `next()` returns the lazy downstream stream; calling it is the only way
    // the adapter is reached, so wrap its iterator in the store.
    const downstream = next();
    if (downstream === null || downstream === undefined) return downstream;
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream;
    return withStore(downstream, { value, hosts: resolveHosts(options.provider) }, als);
  }, { global: true, prepend: true });

  handle.dispose = () => {
    removeEffect?.();
  };
  return handle;
}
