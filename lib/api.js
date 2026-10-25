/**
 * dsh-model-sync — web settings API (v2).
 *
 * Read-only check plus an explicit apply of selected additions, the managed
 * panel's sibling listing, and its per-model removal. Served under the
 * `/model-sync` prefix through the host's webServer service.
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
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
        const outcome = await controller.applySelection(selections, { repairs: body.repairs === true, recheck: body.recheck !== false, rememberHabit: body.rememberHabit !== false });
        return reply(200, outcome);
      }
      if (req.method === 'POST' && path === '/model-sync/api/opened') {
        return reply(200, { previousOpenedAt: controller.markOpened(), lastOpenedAt: controller.status().lastOpenedAt });
      }
      if (req.method === 'POST' && path === '/model-sync/api/settings') {
        const body = await readBody(req);
        if (typeof body.provider === 'string' && typeof body.managed === 'boolean') controller.setManaged(body.provider, body.managed);
        return reply(200, controller.status());
      }
      if (req.method === 'POST' && path === '/model-sync/api/habits') {
        const body = await readBody(req);
        if (typeof body.provider !== 'string' || typeof body.enabled !== 'boolean') return reply(400, { error: 'provider 和 enabled 为必填' });
        controller.setSelectionHabit(body.provider, body.enabled);
        return reply(200, controller.status());
      }
      if (req.method === 'GET' && path === '/model-sync/api/managed') return reply(200, controller.managedSiblings());
      if (req.method === 'POST' && path === '/model-sync/api/remove-managed') {
        const body = await readBody(req);
        const raw = Array.isArray(body.removals) ? body.removals : [{ provider: body.provider, modelId: body.modelId }];
        if (raw.length === 0) return reply(400, { error: 'removals 不能为空' });
        const outcome = await controller.removeManagedModels(raw, { recheck: body.recheck !== false });
        return reply(200, { ok: true, removed: outcome.removed, results: outcome.results });
      }
      if (req.method === 'POST' && path === '/model-sync/api/remove') {
        const body = await readBody(req);
        const raw = Array.isArray(body.removals) ? body.removals : [{ provider: body.provider, modelId: body.modelId }];
        if (raw.length === 0) return reply(400, { error: 'removals 不能为空' });
        const items = raw.map((item) => ({ provider: item?.provider, modelId: item?.modelId }));
        if (items.some((item) => typeof item.provider !== 'string' || typeof item.modelId !== 'string')) {
          return reply(400, { error: 'provider 和 modelId 为必填' });
        }
        const outcome = await controller.removeSiblingModels(items);
        return reply(200, { ok: true, removed: outcome.removed, results: outcome.results });
      }
      return reply(404, { error: 'not found' });
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500;
      return reply(status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  return webServer.register({ kind: 'prefix', path: '/model-sync', handler });
}
