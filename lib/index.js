/**
 * dsh-model-sync — host half.
 *
 * Monitors each provider's live `/models` listing against the DSH settings
 * sections the settings service already validates:
 *   - `llm-deepseek.models`  (official DeepSeek route catalog)
 *   - `llm-pi-ai.providers.<route>` (pi-ai routes, per-protocol siblings when
 *     a provider mixes wire protocols)
 *
 * Boot behaviour: a read-only check runs on startup (plus a one-time repair of
 * models the v1 strict mirror misplaced). Nothing is ever added automatically:
 * new models are only listed, and solely the explicitly checked ones are
 * appended — each write is preceded by a settings.yaml backup. User-managed
 * entries are never deleted or rewritten.
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
import { readSettingsSection, STARTUP_DELAY_MS, SyncController } from './sync.js';
import { SyncState } from './state.js';

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
  const section = readSettingsSection(ctx.get?.('settings'), 'llm-pi-ai');
  const profile = section?.providers?.[provider];
  addHost(hosts, profile?.baseURL);
  addHost(hosts, profile?.baseUrl);
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
  const state = new SyncState();
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

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void controller.startup();
    }, Math.max(0, delay));
    return () => clearTimeout(timer);
  }, 'dsh-model-sync: startup sync');

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
