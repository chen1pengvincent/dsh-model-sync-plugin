/**
 * Host half: one controller per profile, plus the panel's HTTP surface.
 *
 * Failure policy. A plugin that fails to activate is **not** reported to the
 * user: only ten hard-coded entry ids are allowed to reject startup, and this
 * package is not one of them. In the Web/desktop host even the warning is thrown
 * away, so a throw here means the panel and everything behind it silently cease
 * to exist. Therefore this module never throws: it activates what it can, and on
 * failure leaves a note on disk that the panel can show and a log line that the
 * startup log keeps.
 */

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Controller } from './controller.js'
import { registerApi } from './api.js'

export const name = 'dsh-model-sync'
export const inject = ['settings']

/** Where this plugin keeps its memory: inside the profile, next to the harness's own settings. */
function stateDirectory(ctx) {
  const profileDir = ctx.get('profileContext')?.dir
  if (typeof profileDir === 'string' && profileDir.length > 0) return join(profileDir, 'model-sync')
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'model-sync')
}

/** Leave a readable trace of an activation failure where the panel will look for it. */
function recordFailure(dir, error, logger) {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
  logger?.error?.(`model-sync: failed to activate: ${message}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'activation-error.txt'), `${new Date().toISOString()}\n${message}\n`, 'utf8')
  } catch {
    // Nothing left to do: the log line above already carries the reason.
  }
}

/**
 * A previous failed activation leaves a note behind for the panel. Once the API
 * is actually registered the note is stale -- and a stale note makes every later
 * verification report a failure that no longer exists, so it has to go.
 */
function clearFailure(dir) {
  try {
    unlinkSync(join(dir, 'activation-error.txt'))
  } catch {
    // Missing is the normal case; anything else is not worth a second failure.
  }
}

/**
 * @param {any} ctx harness context
 */
export function apply(ctx) {
  const logger = ctx.logger
  const dir = stateDirectory(ctx)
  try {
    // Clear first: a note from a previous session must not be read by the boot
    // self-check below. A failure in *this* session writes its own note later.
    clearFailure(dir)
    const controller = new Controller(ctx, { dir, logger })

    ctx.effect(() => {
      controller.start().catch((error) => {
        logger?.warn?.(`model-sync: could not load saved state: ${error instanceof Error ? error.message : String(error)}`)
      })
      return () => controller.dispose()
    }, 'model-sync: controller')

    // The route is registered later, from the inject callback: a duplicate route
    // (a hot reload that kept the old registration) throws here, outside the
    // try/catch above, and an unrecorded throw would look exactly like "the
    // panel never loads".
    ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => {
      try {
        const dispose = registerApi(webCtx.webServer, controller)
        clearFailure(dir)
        return dispose
      } catch (error) {
        recordFailure(dir, error, logger)
        throw error
      }
    }, 'model-sync: api'))
  } catch (error) {
    recordFailure(dir, error, logger)
  }
}
