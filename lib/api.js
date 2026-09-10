/**
 * dsh-model-sync — web settings API (v2).
 *
 * Read-only check plus an explicit apply of selected additions. Served under
 * the `/model-sync` prefix through the host's webServer service.
 */

async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function display(payload) {
  return {
    ...payload,
    results: (payload.results ?? []).map((result) => ({
      ...result,
      newItems: (result.newItems ?? []).map(({ entry, ...rest }) => rest),
    })),
  };
}

export function registerApi(webServer, controller) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && path === '/model-sync/api/state') return reply(200, controller.status());
      if (req.method === 'POST' && path === '/model-sync/api/check') return reply(200, display(await controller.check()));
      if (req.method === 'POST' && path === '/model-sync/api/apply') {
        const body = await readBody(req);
        const selections = body.selections !== null && typeof body.selections === 'object' ? body.selections : {};
        const outcome = await controller.applySelection(selections, { repairs: body.repairs === true });
        return reply(200, outcome);
      }
      if (req.method === 'POST' && path === '/model-sync/api/settings') {
        const body = await readBody(req);
        if (typeof body.provider === 'string' && typeof body.managed === 'boolean') controller.setManaged(body.provider, body.managed);
        return reply(200, controller.status());
      }
      return reply(404, { error: 'not found' });
    } catch (error) {
      return reply(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  return webServer.register({ kind: 'prefix', path: '/model-sync', handler });
}
