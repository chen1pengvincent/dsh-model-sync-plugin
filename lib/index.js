/**
 * dsh-model-sync — host half.
 *
 * Force-mirrors each provider's live `/models` listing into the DSH settings
 * sections the settings service already validates:
 *   - `llm-deepseek.models`  (official DeepSeek route catalog)
 *   - `llm-pi-ai.providers.<route>` (pi-ai routes, per-protocol siblings when
 *     a provider mixes wire protocols)
 *
 * Boot behaviour: once the user has confirmed the first preview, every boot
 * recomputes and applies. Before that confirmation the boot only prepares a
 * preview — nothing is written without an explicit apply.
 *
 * @module dsh-model-sync
 */

import { registerApi } from './api.js';
import { STARTUP_DELAY_MS, SyncController } from './sync.js';
import { SyncState } from './state.js';

export const name = 'dsh-model-sync';
export const inject = ['settings'];

export function apply(ctx, config) {
  const state = new SyncState();
  const logger = {
    info: (message) => ctx.logger.info(message),
    warn: (message) => ctx.logger.warn(message),
    error: (message) => ctx.logger.error(message),
  };
  const controller = new SyncController({ ctx, state, logger });
  const delay = Number.isFinite(config?.startupDelayMs) ? config.startupDelayMs : STARTUP_DELAY_MS;

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void controller.startup();
    }, Math.max(0, delay));
    return () => clearTimeout(timer);
  }, 'dsh-model-sync: startup sync');

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerApi(webCtx.webServer, controller), 'dsh-model-sync: web api');
  });
}

export { SyncController, SyncState };
