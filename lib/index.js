/**
 * dsh-model-sync — host half.
 *
 * Monitors each provider's live `/models` listing against the DSH settings
 * sections the settings service already validates:
 *   - `llm-deepseek.models`  (official DeepSeek route catalog)
 *   - `llm-pi-ai.providers.<route>` (pi-ai routes, per-protocol siblings when
 *     a provider mixes wire protocols)
 *
 * Boot and configuration-change checks are read-only. Catalog changes are
 * measured against the last viewed complete upstream snapshot, not against
 * enabled models. Only explicit selection/removal intents change settings;
 * each atomic, revision-checked write backs up the actual profile patch.
 *
 * It also carries the OpenCode session header half: OpenCode Go answers
 * `400 MissingSessionID` unless each request presents a stable per-conversation
 * `x-opencode-session`, and the pi-ai adapter cannot be relied on to send one.
 * The header is attached at request time from the durable `options.sessionId`
 * (`lib/session-header.js`), so a route this plugin declared — including a
 * route that sets an explicit `api:` and never receives pi-ai's own wrapper —
 * is covered as well.
 *
 * @module dsh-model-sync
 */

import { registerApi } from './api.js';
import { createModelSyncCommand } from './command.js';
import { BUILTIN_ROUTES } from './routes.js';
import { installSessionHeader, providerMatches } from './session-header.js';
import { STARTUP_DELAY_MS, SyncController } from './sync.js';
import { atPath, settingsDescriptors } from './providers.js';
import { SyncState } from './state.js';
import { join } from 'node:path';

export const name = 'dsh-model-sync';
export const inject = ['settings'];

/** Host names of the built-in routes that provider belongs to. */
function routeHosts(provider) {
  const hosts = new Set();
  for (const route of Object.values(BUILTIN_ROUTES)) {
    if (!providerMatches(provider, [route.provider])) continue;
    for (const base of route.discovery?.baseUrls ?? []) addHost(hosts, base);
    for (const spec of Object.values(route.protocols ?? {})) addHost(hosts, spec?.baseUrl);
  }
  return [...hosts];
}

/** Host names declared on the provider's pi-ai settings profile, if any. */
export function profileHosts(ctx, provider) {
  const hosts = new Set();
  const descriptors = settingsDescriptors(ctx.get?.('settings'));
  const directory = ctx.get?.('llm')?.listConfigurableProviders?.() ?? [];
  const entries = directory.filter((entry) => entry.provider === provider);
  const profiles = entries.map((entry) => atPath(descriptors.find((item) => item.ns === entry.settingsNs)?.value, entry.settingsPath));
  // Compatibility for older kernels without the configurable-provider directory.
  if (!directory.length) for (const entry of descriptors) if (entry.value?.providers?.[provider]) profiles.push(entry.value.providers[provider]);
  for (const profile of profiles) {
    addHost(hosts, profile?.baseURL);
    addHost(hosts, profile?.baseUrl);
  }
  return [...hosts];
}

function addHost(hosts, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  try {
    hosts.add(new URL(value).host);
  } catch {
    /* not an absolute URL: ignore */
  }
}

export function apply(ctx, config) {
  // Each profile has an independent unread baseline and ownership ledger.
  // The unprofiled fallback retains the historical location for old kernels.
  const profileDir = ctx.get?.('profileContext')?.dir;
  const state = new SyncState(profileDir ? join(profileDir, 'model-sync') : undefined);
  const logger = {
    info: (message) => ctx.logger.info(message),
    warn: (message) => ctx.logger.warn(message),
    error: (message) => ctx.logger.error(message),
  };
  const controller = new SyncController({ ctx, state, logger });
  const delay = Number.isFinite(config?.startupDelayMs) ? config.startupDelayMs : STARTUP_DELAY_MS;

  // OpenCode Go requires a stable per-conversation `x-opencode-session`; attach
  // it at request time (see lib/session-header.js). Hosts are resolved lazily
  // so they follow live settings changes.
  installSessionHeader(ctx, config?.sessionHeader, {
    resolveHosts: (provider) => [...new Set([...profileHosts(ctx, provider), ...routeHosts(provider)])],
  });

  // All subscriptions belong to this Cordis scope and disappear on unload.
  for (const event of [
    'settings/document-updated', 'llm/adapters-updated', 'llm/models-updated',
    'credentials/reference-updated', 'credentials/record-updated', 'app-boot/config-reload',
  ]) ctx.on(event, () => controller.refreshAfterMutation());

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void controller.startup().catch(() => logger.warn('模型目录初始化检查失败，已保留上次成功目录'));
    }, Math.max(0, delay));
    timer.unref?.();
    return () => { clearTimeout(timer); controller.dispose(); };
  }, 'dsh-model-sync: read-only catalog lifecycle');

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerApi(webCtx.webServer, controller), 'dsh-model-sync: web api');
  });

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register(createModelSyncCommand(controller)), 'dsh-model-sync: command');
  });
}

export { SyncController, SyncState };
export {
  SESSION_HEADER,
  headerValueFor,
  installSessionHeader,
  providerMatches,
  resolveHeaderConfig,
} from './session-header.js';
