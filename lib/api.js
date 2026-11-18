/**
 * The panel's HTTP surface, mounted on the harness web server.
 *
 * Every reply is JSON. Errors carry `safe: true` and a `publicMessage` when the
 * sentence is written for the user; the harness renders that instead of a stack
 * trace. Anything else is a bug and is allowed to surface as a 500.
 *
 * Route shape: `/model-sync/api/<verb>`, POST for anything that changes
 * something. Bodies are capped so a stray request cannot exhaust memory.
 */

import { format } from './verify.js'

/** Largest request body accepted; every documented call is a few hundred bytes. */
const MAX_BODY = 64 * 1024

/** Build an error the harness is allowed to show verbatim. */
function publicError(message, status = 400) {
  return Object.assign(new Error(message), { status, safe: true, publicMessage: message })
}

/** Read and parse a JSON request body. */
async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY) throw publicError('request body too large', 413)
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw publicError('request body is not a JSON object')
  }
}

/** Write one JSON reply. */
function sendJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Register the prefix handler.
 * @param {any} webServer harness web server service
 * @param {import('./controller.js').Controller} controller
 * @returns {() => void} unregister
 */
export function registerApi(webServer, controller) {
  const route = async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const verb = path.replace(/^\/model-sync\/api\/?/, '').replace(/\/+$/, '')
    try {
      // This route lives outside the host's `/api` trust fence, so refuse
      // browser cross-site calls here. Non-browser clients (tests, scripts)
      // send no Origin/Sec-Fetch-Site and keep working.
      const headers = request.headers ?? {}
      const origin = typeof headers.origin === 'string' ? headers.origin : ''
      if (origin && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin)) {
        throw publicError('cross-origin request refused', 403)
      }
      const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : ''
      if (site && site !== 'same-origin' && site !== 'none') {
        throw publicError('cross-site request refused', 403)
      }
      if (request.method === 'POST') {
        const contentType = String(headers['content-type'] ?? '').toLowerCase()
        if (contentType && !contentType.startsWith('application/json')) {
          throw publicError('content-type must be application/json', 415)
        }
      }
      if (request.method === 'GET' && (verb === 'view' || verb === '')) {
        sendJson(response, 200, { ok: true, view: await controller.view() })
        return
      }
      if (request.method === 'GET' && verb === 'visibility') {
        sendJson(response, 200, { ok: true, hidden: controller.visibility() })
        return
      }
      if (request.method === 'GET' && verb === 'display-models') {
        sendJson(response, 200, { ok: true, ...await controller.displayModels() })
        return
      }
      if (request.method !== 'POST') throw publicError('this endpoint only accepts POST', 405)
      const body = await readJsonBody(request)
      switch (verb) {
        case 'check':
          sendJson(response, 200, { ok: true, ...await controller.check({ provider: body.provider, reason: 'manual' }) })
          return
        case 'apply':
          sendJson(response, 200, { ok: true, ...await controller.apply({
            provider: body.provider, ids: body.ids, showInPicker: body.showInPicker,
            removeIds: body.removeIds, seenUsage: body.seenUsage, pickerChanges: body.pickerChanges,
          }) })
          return
        case 'visibility':
          sendJson(response, 200, { ok: true, ...await controller.setVisibility(body.changes) })
          return
        case 'remove':
          sendJson(response, 200, { ok: true, ...await controller.remove({ provider: body.provider, id: body.id }) })
          return
        case 'ignore':
          sendJson(response, 200, { ok: true, ...await controller.ignore({ provider: body.provider, ids: body.ids }) })
          return
        case 'unignore':
          sendJson(response, 200, { ok: true, ...await controller.unignore({ provider: body.provider }), view: await controller.view() })
          return
        case 'restore':
          sendJson(response, 200, { ok: true, ...await controller.restore({ provider: body.provider }) })
          return
        case 'metadata-update':
          sendJson(response, 200, { ok: true, view: await controller.updateMetadata({
            provider: body.provider, id: body.id, field: body.field, value: body.value,
          }) })
          return
        case 'metadata-revert': {
          const view = await controller.revertMetadata({ provider: body.provider, id: body.id })
          sendJson(response, 200, { ok: true, view, notice: controller.takeMetadataNotice() })
          return
        }
        case 'prune':
          throw publicError('旧路由现在仅供核对，请在 DSH 设置中确认归属和模型配置后处理。', 409)
        case 'cleanup':
          sendJson(response, 200, { ok: true, ...await controller.cleanup({ providers: body.providers }) })
          return
        case 'settings':
          sendJson(response, 200, { ok: true, view: await controller.settings({ proxy: body.proxy, schedule: body.schedule, ignored: body.ignored, bili: body.bili, gateway: body.gateway }) })
          return
        case 'gateway-start':
          sendJson(response, 200, { ok: true, gateway: await controller.startGateway(), view: await controller.view() })
          return
        case 'gateway-stop':
          sendJson(response, 200, { ok: true, gateway: await controller.stopGateway(), view: await controller.view() })
          return
        case 'gateway-route':
          sendJson(response, 200, { ok: true, ...await controller.routeGateway({ provider: body.provider }), view: await controller.view() })
          return
        case 'gateway-unroute':
          sendJson(response, 200, { ok: true, ...await controller.unrouteGateway({ provider: body.provider }), view: await controller.view() })
          return
        case 'bili':
          sendJson(response, 200, { ok: true, bili: await controller.syncBili({ reason: 'manual' }), view: await controller.view() })
          return
        case 'selfcheck': {
          // The panel cannot read the profile manifest, and a terminal script
          // cannot see what the loaded plugin sees; this verb runs both halves
          // inside the host so one click covers the manual acceptance steps.
          // `runSelfCheck` also stores the verdict, so the panel's first row
          // and the text agree after a manual run instead of disagreeing until
          // the next restart.
          const verdict = await controller.runSelfCheck()
          sendJson(response, 200, { ok: true, verdict, text: format(verdict), view: await controller.view() })
          return
        }
        case 'bili-revoke':
          sendJson(response, 200, { ok: true, bili: await controller.revokeBili(), view: await controller.view() })
          return
        default:
          throw publicError(`unknown endpoint "/model-sync/api/${verb}"`, 404)
      }
    } catch (error) {
      const status = typeof (/** @type {any} */ (error))?.status === 'number' ? /** @type {any} */ (error).status : 500
      const safe = /** @type {any} */ (error)?.safe === true
      const message = safe
        ? String(/** @type {any} */ (error).publicMessage ?? /** @type {any} */ (error).message)
        : 'the model-sync plugin failed; see the harness log for details'
      if (!safe) controller.logger?.error?.(error)
      sendJson(response, status, { ok: false, error: message })
    }
  }

  // `register` returns the disposer; the server exposes no `unregister`.
  const dispose = webServer.register({ kind: 'prefix', path: '/model-sync', handler: route })
  return () => dispose?.()
}
