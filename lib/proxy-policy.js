/**
 * The host-wide network switch.
 *
 * `@deepseek-ai/dsh-http-proxy` (shipped inside the Harness) owns undici's
 * global dispatcher. Re-installing it with a different environment snapshot is
 * therefore the only supported way to move *every* `fetch` in this process —
 * the provider stack (pi-ai), MCP transports and our own catalog requests —
 * without restarting the app or editing the user's `.env`.
 *
 * The switch is deliberate about its three states:
 *   on + a live proxy   → install that proxy (global transport + catalog)
 *   on + nothing usable → leave the launcher's policy alone (never silent direct)
 *   off                 → install an explicit direct policy
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

import { readSystemProxy, resetSystemProxyCache } from './net-proxy.js';

export const HARNESS_POLICY_PACKAGE = '@deepseek-ai/dsh-http-proxy';

/** Names the Harness package reads; lowercase first, uppercase as a fallback. */
const PROXY_ENV_NAMES = ['https_proxy', 'http_proxy', 'all_proxy'];
const NO_PROXY_NAMES = ['no_proxy', 'NO_PROXY'];
const DETECT_BUDGET_MS = 3000;
const PROBE_TIMEOUT_MS = 800;
const POLICY_FILE = 'node_modules/@deepseek-ai/dsh-http-proxy/lib/index.js';

const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

/**
 * Parse a proxy value the way the Harness package does: scheme optional, both
 * `http:` and `https:` (an https proxy is spoken to over TLS by undici),
 * credentials and bracketed IPv6 hosts preserved.
 *
 * Returns `undefined` for anything this plugin cannot use (SOCKS/PAC/垃圾).
 */
export function parseHarnessProxy(value) {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  if (text === '') return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return undefined;
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const credentials = url.username === ''
    ? ''
    : `${url.username}${url.password === '' ? '' : `:${url.password}`}@`;
  const masked = url.username === '' ? '' : '***@';
  const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  return {
    host,
    port,
    // `url` keeps the credentials on purpose: it is what gets installed.
    url: `${url.protocol}//${credentials}${authority}`,
    // `display` is the only form allowed in status payloads, logs and the UI.
    display: `${url.protocol}//${masked}${authority}`,
  };
}

/**
 * Build the environment snapshot the Harness package consumes. It expects a
 * Map of `{ value }` entries (not a plain object), and an empty Map is the
 * documented way to say "force direct".
 */
export function launchEnvironment(url, bypass) {
  const entries = new Map();
  if (typeof url !== 'string' || url === '') return entries;
  for (const name of PROXY_ENV_NAMES) entries.set(name, { value: url });
  const list = Array.isArray(bypass)
    ? bypass.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
    : [];
  if (list.length > 0) for (const name of NO_PROXY_NAMES) entries.set(name, { value: list.join(',') });
  return entries;
}

function envValue(env, name) {
  if (env === undefined || env === null) return undefined;
  const value = typeof env.get === 'function' ? env.get(name) : env[name];
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof value.value === 'string') return value.value;
  return undefined;
}

function envBypass(env) {
  for (const name of NO_PROXY_NAMES) {
    const value = envValue(env, name);
    if (!isBlank(value)) return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  }
  return [];
}

/**
 * Every usable proxy this machine advertises, in priority order: `https_proxy`
 * then `http_proxy` then `all_proxy` (lowercase first), then the macOS system
 * settings. The caller probes them in order and keeps the first live one, so a
 * stale `HTTPS_PROXY` can no longer hide a working `HTTP_PROXY`.
 */
export async function detectProxies({ env = process.env, platform = process.platform, read = readSystemProxy } = {}) {
  const found = [];
  const seen = new Set();
  const push = (parsed, source, bypass) => {
    if (parsed === undefined || seen.has(parsed.url)) return;
    seen.add(parsed.url);
    found.push({ ...parsed, source, bypass });
  };
  for (const name of PROXY_ENV_NAMES) {
    // Same precedence as the Harness package: lowercase, then uppercase.
    const parsed = parseHarnessProxy(envValue(env, name) ?? envValue(env, name.toUpperCase()));
    if (parsed !== undefined) push(parsed, 'environment', envBypass(env));
  }
  let system;
  try { system = await read({ platform }); } catch { system = null; }
  const entry = system?.https ?? system?.http;
  if (entry !== undefined && entry !== null) {
    push(parseHarnessProxy(`${entry.host}:${entry.port}`), 'system', Array.isArray(system.bypass) ? system.bypass : []);
  }
  return found;
}

/** TCP connect probe: a configured-but-dead Clash must not become an outage. */
export function probeProxy(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const parsed = parseHarnessProxy(url);
  if (parsed === undefined) return Promise.resolve(false);
  return new Promise((resolveProbe) => {
    let settled = false;
    const socket = connect({ host: parsed.host, port: parsed.port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Candidate on-disk locations for the Harness package. A profile plugin is
 * loaded from `profiles/<name>/node_modules`, while the package itself lives
 * inside `app.asar`, which the host's module fallback can read but a bare
 * `import()` from a plain Node process cannot.
 */
export function harnessPolicyCandidates(entry) {
  if (typeof entry !== 'string' || entry === '') return [];
  const found = [];
  let current = resolve(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    const base = dirname(current);
    if (base === current) break;
    found.push(join(base, POLICY_FILE));
    const next = dirname(base);
    if (next === base) break;
    current = base;
  }
  return found;
}

async function loadHarnessPolicy() {
  try {
    return await import(HARNESS_POLICY_PACKAGE);
  } catch (bare) {
    for (const candidate of harnessPolicyCandidates(process.argv[1])) {
      if (!existsSync(candidate)) continue;
      try { return await import(pathToFileURL(candidate).href); } catch { /* try the next one */ }
    }
    throw bare;
  }
}

/**
 * Serialized owner of the process-wide policy. All transitions run through
 * `this.pending`; `dispose()` waits for (and then undoes) whatever landed.
 */
export class SystemProxyPolicy {
  constructor({
    logger = undefined,
    detect = detectProxies,
    probe = probeProxy,
    install = undefined,
    packageLoader = loadHarnessPolicy,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    budgetMs = DETECT_BUDGET_MS,
    baseEnv = undefined,
  } = {}) {
    this.logger = logger;
    this.detect = detect;
    this.probe = probe;
    this.installFn = install;
    this.packageLoader = packageLoader;
    this.probeTimeoutMs = probeTimeoutMs;
    this.budgetMs = budgetMs;
    // Installing the policy writes the proxy into process.env. Keep the
    // launch-time view so a forced re-detection can still see a system-proxy
    // change that the previous install would otherwise mask.
    this.baseEnv = baseEnv ?? { ...process.env };
    this.installer = undefined;
    this.enabled = false;
    this.active = false;
    this.installed = false;
    this.url = undefined;
    this.display = undefined;
    this.source = 'none';
    this.bypass = undefined;
    this.reason = undefined;
    this.applied = undefined;
    this.disposer = undefined;
    this.pending = Promise.resolve();
    this.disposed = false;
  }

  status() {
    return {
      enabled: this.enabled === true,
      active: this.active === true,
      installed: this.installed === true,
      url: this.display,
      source: this.source,
      reason: this.reason,
      transport: this.installed === true ? 'harness' : 'plugin',
    };
  }

  /**
   * Turn the switch on or off; safe to call repeatedly.
   *
   * `force` re-reads the machine's proxy settings even when the previous
   * decision is still cached — the check button uses it so a proxy that moved
   * to another port is picked up without toggling the switch or restarting.
   */
  apply(enabled, { force = false } = {}) {
    if (this.disposed) return Promise.resolve(this.status());
    const wanted = enabled === true;
    const run = this.pending.then(() => this.#apply(wanted, force === true)).catch((error) => {
      // Do not touch `active`/`installed` here: a failure before the swap leaves
      // the previous dispatcher live, and the panel must not claim otherwise.
      this.reason = `无法接管宿主网络（${error instanceof Error ? error.message : String(error)}）；仅插件的目录检查走系统代理`;
      this.logger?.warn?.(`[model-sync] proxy switch failed: ${String(error?.message ?? error)}`);
      return this.status();
    });
    this.pending = run;
    return run;
  }

  async #apply(wanted, force = false) {
    if (this.disposed) return this.status();
    if (force !== true && this.applied === wanted && this.reason === undefined && (wanted === false || this.active === true)) {
      return this.status();
    }
    this.enabled = wanted;
    resetSystemProxyCache();
    if (wanted === false) {
      await this.#swap(launchEnvironment(undefined));
      this.applied = false;
      this.active = false;
      this.url = undefined;
      this.display = undefined;
      this.bypass = undefined;
      this.source = 'none';
      this.reason = undefined;
      this.logger?.info?.('[model-sync] proxy switch off: explicit direct policy installed');
      return this.status();
    }
    const candidates = await this.detect({ env: this.baseEnv });
    let chosen;
    const deadline = Date.now() + this.budgetMs;
    for (const candidate of candidates) {
      if (Date.now() > deadline) {
        this.logger?.warn?.('[model-sync] proxy probe budget exhausted; falling back to what is installed');
        break;
      }
      if (await this.probe(candidate.url, this.probeTimeoutMs)) { chosen = candidate; break; }
    }
    if (this.disposed) return this.status();
    if (chosen === undefined) {
      const known = this.active === true && this.installed === true && this.url !== undefined
        ? candidates.find((candidate) => candidate.url === this.url)
        : undefined;
      if (force === true && known !== undefined) {
        // A single failed TCP probe (Clash restarting, slow tunnel) must not
        // tear down a working install: keep it and say so.
        this.applied = true;
        this.reason = `暂时探测不到 ${known.display}（代理可能正在重启）；继续沿用上次的接管`;
        this.logger?.warn?.(`[model-sync] proxy probe failed for ${known.display}; keeping the install`);
        return this.status();
      }
      // Nothing usable: restore whatever the launcher installed instead of
      // forcing direct on users who never asked for that.
      await this.#swap(null);
      this.applied = wanted;
      this.active = false;
      this.url = undefined;
      this.display = undefined;
      this.bypass = undefined;
      this.source = 'none';
      this.reason = candidates.length === 0
        ? '未检测到可用的系统代理（HTTP/HTTPS）；已保持宿主原有网络设置'
        : `检测到系统代理 ${candidates[0].display}，但连接失败（代理未运行？）；已保持宿主原有网络设置`;
      this.logger?.info?.(`[model-sync] proxy switch skipped: ${this.reason}`);
      return this.status();
    }
    // A forced re-detection that lands on the very proxy we already installed
    // must not bounce the dispatcher: keep it and just refresh the bookkeeping.
    // Identity is the endpoint, not its provenance or the no_proxy spelling:
    // installing writes process.env (the Harness policy appends loopback
    // escapes), so the same proxy legitimately reads back with a longer bypass
    // list on the next probe. A no_proxy-only edit is picked up on the next
    // off/on toggle, which is worth more than reinstalling on every check.
    if (this.active === true && this.installed === true && this.url === chosen.url
      && this.display === chosen.display) {
      this.applied = true;
      this.source = chosen.source;
      this.bypass = chosen.bypass;
      this.reason = undefined;
      return this.status();
    }
    await this.#swap(launchEnvironment(chosen.url, chosen.bypass));
    this.applied = wanted;
    this.active = true;
    this.url = chosen.url;
    this.display = chosen.display;
    this.source = chosen.source;
    this.bypass = chosen.bypass;
    this.reason = undefined;
    this.logger?.info?.(`[model-sync] proxy switch on: ${chosen.display} (${chosen.source})`);
    return this.status();
  }

  /**
   * Replace the current install. `null` means "do not install, just restore the
   * previous owner"; any Map (including an empty one) installs.
   */
  async #swap(env) {
    if (this.disposer !== undefined) {
      const previous = this.disposer;
      this.disposer = undefined;
      this.installed = false;
      // The harness disposer restores the previous dispatcher synchronously and
      // only then awaits `agent.close()`, which drains in-flight streams (a long
      // SSE generation can take minutes). Awaiting it here would leave the
      // process without a dispatcher for that whole time, so the restore is
      // kicked off and the close is left to finish on its own.
      try {
        const closing = previous();
        if (closing !== undefined && typeof closing.then === 'function') closing.then(undefined, () => {});
      } catch { /* the previous owner is best-effort */ }
    }
    if (env === null || env === undefined) return;
    const install = this.installFn ?? await this.#installer();
    const disposer = await install(env);
    if (this.disposed) {
      if (typeof disposer === 'function') { try { await disposer(); } catch { /* already unloading */ } }
      this.installed = false;
      return;
    }
    this.disposer = typeof disposer === 'function' ? disposer : undefined;
    this.installed = this.disposer !== undefined;
  }

  async #installer() {
    if (this.installer === undefined) {
      const policy = await this.packageLoader();
      this.installer = (env) => policy.installProxyFromEnvironment(env);
    }
    return this.installer;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { await this.pending; } catch { /* the transition already reported itself */ }
    const disposer = this.disposer;
    this.disposer = undefined;
    this.installed = false;
    this.active = false;
    this.applied = undefined;
    if (disposer === undefined) return;
    try { await disposer(); } catch { /* process is going away */ }
  }
}
