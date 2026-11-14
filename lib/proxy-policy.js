/**
 * dsh-model-sync — system-proxy policy for the whole host process.
 *
 * First principles: a switch that only changed this plugin's own `/models`
 * requests would let the catalog appear while every chat completion still timed
 * out, which is not the capability the switch promises ("模型…访问调通"). Node's
 * `fetch` resolves undici's *global dispatcher* per request, so one process-wide
 * install covers the catalog, every pi-ai provider stack, MCP HTTP traffic and
 * web search at once — no TUN device, no per-call plumbing.
 *
 * The Harness already owns that transport: `@deepseek-ai/dsh-http-proxy`
 * installs a dispatcher from the launch environment before the first plugin
 * mounts and exposes `installProxyFromEnvironment(env)` to re-install it. This
 * module is a thin, testable policy object around that entry point: detect the
 * user's proxy (exported environment first, then the macOS system proxy),
 * install it, and — when switched off — install an explicit direct dispatcher so
 * "off" really means off instead of "whatever the launcher happened to apply".
 *
 * The plugin's own catalog transport (`./net-proxy.js`) stays as a second path:
 * if the Harness package cannot be loaded (older build) the switch still fixes
 * the catalog and reports that chat needs the newer Harness.
 *
 * @module dsh-model-sync/proxy-policy
 */

import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProxyURL, readSystemProxy, resetSystemProxyCache } from './net-proxy.js';

/** The Harness library that owns undici's global dispatcher. */
export const HARNESS_POLICY_PACKAGE = '@deepseek-ai/dsh-http-proxy';

/** Environment names the Harness policy reads, in its own precedence order. */
const PROXY_ENV_NAMES = ['https_proxy', 'http_proxy', 'all_proxy'];

/**
 * Wrap one proxy URL in the launch-environment shape the Harness policy reads.
 *
 * `installProxyFromEnvironment` expects the launcher's snapshot object
 * (`env.get(name)?.value`), not a plain record: a `Map` of `{ value }` entries is
 * exactly that shape and keeps the lowercase names undici prefers.
 *
 * @param {string} url absolute `http://host:port` proxy URL.
 * @returns {Map<string, { value: string }>} the environment snapshot.
 */
export function launchEnvironment(url) {
  const entries = new Map();
  if (typeof url !== 'string' || url.length === 0) return entries;
  for (const name of PROXY_ENV_NAMES) entries.set(name, { value: url });
  return entries;
}

/**
 * Find the proxy a user already relies on.
 *
 * Exported variables win over the system setting, matching both the Harness
 * policy's own precedence and what every other tool on the machine does. Only
 * `http:`/`https:` proxies are usable here; a SOCKS-only setup is reported as
 * "no proxy" and the caller keeps the direct path.
 *
 * @param {{env?: Record<string, string|undefined>, platform?: string,
 *          read?: Function}} [options] injectable seams for tests.
 * @returns {Promise<{url: string, source: 'environment'|'system'}|undefined>}
 */
export async function detectSystemProxy({
  env = process.env, platform = process.platform, read = readSystemProxy,
} = {}) {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const proxy = parseProxyURL(env?.[name]);
    if (proxy !== undefined) return { url: `http://${proxy.host}:${proxy.port}`, source: 'environment' };
  }
  const system = typeof read === 'function' ? await read({ platform }) : read;
  const entry = system?.https ?? system?.http;
  if (entry === undefined) return undefined;
  return { url: `http://${entry.host}:${entry.port}`, source: 'system' };
}

/**
 * Is anything actually listening on that proxy?
 *
 * A configured-but-dead proxy is the worst case for a *global* install: every
 * request in the process would fail instead of falling back to a direct
 * connection. A short TCP probe keeps "Clash is not running right now" from
 * turning into "the agent has no network".
 *
 * @param {string} url `http://host:port`.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} true when the socket connects.
 */
export function probeProxy(url, timeoutMs = 800) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect({ host: target.hostname, port, timeout: timeoutMs });
    const finish = (alive) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Candidate absolute entry paths for the Harness policy module.
 *
 * Plugins run from the profile's generation directory, so the bare specifier is
 * resolved by the Harness's own `@deepseek-ai/*` fallback first. When that path
 * fails (a host build whose fallback does not cover this package), the module
 * still sits in the host's `node_modules`, reachable by walking up from the
 * Harness entry file that `harness-node-entry.mjs` puts in `process.argv[1]`.
 *
 * @param {string|undefined} entry the Harness entry file, if known.
 * @returns {string[]} absolute candidate paths, nearest first.
 */
export function harnessPolicyCandidates(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return [];
  const suffix = join('node_modules', '@deepseek-ai', 'dsh-http-proxy', 'lib', 'index.js');
  const candidates = [];
  let dir = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    candidates.push(join(dir, suffix));
  }
  return candidates;
}

/** Load the Harness policy module: bare specifier first, then its real path. */
async function loadHarnessPolicy() {
  try {
    return await import(HARNESS_POLICY_PACKAGE);
  } catch (bareFailure) {
    for (const candidate of harnessPolicyCandidates(process.argv?.[1])) {
      if (!existsSync(candidate)) continue;
      try {
        return await import(pathToFileURL(candidate).href);
      } catch { /* try the next ancestor */ }
    }
    throw bareFailure;
  }
}

/** The real installer: load the Harness library and re-install its dispatcher. */
async function harnessInstall(env, report) {
  const policy = await loadHarnessPolicy();
  if (typeof policy?.installProxyFromEnvironment !== 'function') {
    throw new Error(`${HARNESS_POLICY_PACKAGE} 未导出 installProxyFromEnvironment`);
  }
  return await policy.installProxyFromEnvironment(env, report);
}

/**
 * The switch's host half.
 *
 * One instance per plugin lifetime. `apply()` is idempotent for the same value,
 * serialized against itself (two clicks cannot interleave two installs), and
 * never throws: a failed install is reported through `status().reason` and the
 * previous dispatcher stays in place, because a broken switch must not take the
 * agent's networking down with it.
 */
export class SystemProxyPolicy {
  /**
   * @param {{logger?: {warn?: Function, info?: Function},
   *          install?: Function, detect?: Function}} [options]
   */
  constructor({ logger = console, install = harnessInstall, detect = detectSystemProxy, probe = probeProxy } = {}) {
    this.logger = logger;
    this.install = install;
    this.detect = detect;
    this.probe = probe;
    this.active = false;
    this.enabled = false;
    this.url = undefined;
    this.source = 'none';
    this.installed = false;
    this.reason = undefined;
    this.disposer = undefined;
    this.applied = undefined;
    this.pending = Promise.resolve();
  }

  /** Synchronous snapshot for the status payload. */
  status() {
    return {
      enabled: this.enabled === true,
      installed: this.installed === true,
      active: this.active === true,
      url: this.url,
      source: this.source,
      reason: this.reason,
      transport: this.installed || this.enabled ? 'harness' : 'plugin',
    };
  }

  /**
   * Install (or remove) the process-wide proxy.
   *
   * @param {boolean} enabled what the switch should mean from now on.
   * @returns {Promise<object>} the same snapshot `status()` returns.
   */
  apply(enabled) {
    const wanted = enabled === true;
    // Serialize: a second click waits for the first install to settle instead of
    // racing it for the global dispatcher.
    const run = this.pending.then(() => this.#apply(wanted));
    this.pending = run.catch(() => {});
    return run;
  }

  async #apply(wanted) {
    if (this.applied === wanted && this.reason === undefined) return this.status();
    this.enabled = wanted;
    let url;
    let source = 'none';
    try {
      resetSystemProxyCache();
      const detected = wanted ? await this.detect() : undefined;
      url = detected?.url;
      source = detected?.source ?? 'none';
      // A dead proxy must not become a process-wide outage: probe it first and
      // fall back to an explicit direct policy when nothing answers.
      const alive = url === undefined ? false : await this.probe(url);
      this.url = url;
      this.source = source;
      this.active = wanted && url !== undefined && alive === true;
      // Drop the previous install first: its disposer restores the launcher's
      // own dispatcher, so a failed install below leaves the process on the
      // policy it had before this plugin ever touched it.
      if (this.disposer !== undefined) {
        const previous = this.disposer;
        this.disposer = undefined;
        try { await previous(); } catch { /* the replacement below is what matters */ }
      }
      const disposer = await this.install(this.active ? launchEnvironment(url) : launchEnvironment(undefined), (message) => {
        this.logger?.warn?.(`系统代理策略：${message}`);
      });
      // The installer is idempotent per policy but every call hands back a
      // disposer for the state it replaced; only the newest one is kept.
      this.disposer = typeof disposer === 'function' ? disposer : undefined;
      this.installed = true;
      this.reason = wanted && url === undefined
        ? '未检测到可用的系统代理（HTTP/HTTPS）；已保持直连'
        : wanted && !this.active
          ? `检测到系统代理 ${url}，但连接失败（代理未运行？）；已保持直连`
          : undefined;
      this.applied = wanted;
      this.logger?.info?.(wanted
        ? this.active
          ? `系统代理已启用：${url}（${source === 'environment' ? '环境变量' : '系统设置'}）`
          : '系统代理已跳过，出站请求保持直连'
        : '系统代理已关闭，出站请求恢复直连');
    } catch (error) {
      this.installed = false;
      this.active = false;
      this.reason = `无法接管宿主网络（${error?.message ?? '未知错误'}）；仅插件的目录检查走系统代理`;
      this.applied = undefined;
      this.logger?.warn?.(this.reason);
    }
    return this.status();
  }

  /** Restore whatever dispatcher the Harness installed before this plugin. */
  async dispose() {
    const disposer = this.disposer;
    this.disposer = undefined;
    this.applied = undefined;
    if (disposer === undefined) return;
    try {
      await disposer();
    } catch { /* unloading must never throw */ }
  }
}
