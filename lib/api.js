/** Native Host API. Checking and viewing never mutate provider settings. */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const badRequest = (message, status = 400) => Object.assign(new Error(message), { status, safe: true, publicMessage: message });

async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw badRequest('请求体过大', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw badRequest('请求体不是合法 JSON'); }
  if (!isObject(value)) throw badRequest('请求体必须是 JSON 对象');
  return value;
}

function display(payload) {
  return {
    ...payload,
    results: (payload.results ?? []).map(({ configScope, ...result }) => ({
      ...result, newItems: (result.newItems ?? []).map(({ entry, ...item }) => item),
    })),
  };
}

function booleanOption(body, key, fallback) {
  if (!own(body, key)) return fallback;
  if (typeof body[key] !== 'boolean') throw badRequest(`${key} 必须是布尔值`);
  return body[key];
}

function selectionOptions(body) {
  if (own(body, 'expectedRevisions') && !isObject(body.expectedRevisions)) throw badRequest('expectedRevisions 必须是对象');
  if (Object.values(body.expectedRevisions ?? {}).some((revision) => !Number.isSafeInteger(revision) || revision < 0)) {
    throw badRequest('expectedRevisions 的版本必须是非负安全整数');
  }
  return {
    expectedRevisions: body.expectedRevisions ?? {},
    repairs: booleanOption(body, 'repairs', false),
    recheck: booleanOption(body, 'recheck', true),
    rememberHabit: booleanOption(body, 'rememberHabit', true),
  };
}

function requireExpectedRevisions(options, providers) {
  for (const provider of new Set(providers)) {
    if (typeof provider !== 'string' || !provider || !own(options.expectedRevisions, provider)) {
      throw badRequest('请先重新检查供应商，并携带每个受影响供应商的 expectedRevisions 版本');
    }
  }
}

function removalItems(body) {
  if (own(body, 'removals') && !Array.isArray(body.removals)) throw badRequest('removals 必须是数组');
  const raw = body.removals ?? [{ provider: body.provider, owner: body.owner, id: body.id ?? body.modelId }];
  if (!raw.length) throw badRequest('removals 不能为空');
  const items = raw.map((item) => ({
    provider: item?.provider, id: item?.id ?? item?.modelId,
    ...(item?.owner === undefined ? {} : { owner: item.owner }),
  }));
  if (items.some((item) => typeof item.provider !== 'string' || !item.provider || typeof item.id !== 'string' || !item.id ||
    (item.owner !== undefined && (typeof item.owner !== 'string' || !item.owner)))) throw badRequest('provider、模型 ID 和可选 owner 必须是非空字符串');
  return items;
}

export function registerApi(webServer, controller) {
  const handler = async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && path === '/model-sync/api/state') return reply(200, controller.status());
      if (req.method === 'POST' && path === '/model-sync/api/check') return reply(200, display(await controller.check()));
      if (req.method === 'POST' && path === '/model-sync/api/apply') {
        const body = await readBody(req);
        if (own(body, 'selections') && !isObject(body.selections)) throw badRequest('selections 必须是对象');
        if (own(body, 'removals') && !Array.isArray(body.removals)) throw badRequest('removals 必须是数组');
        const selections = body.selections ?? {};
        const removals = body.removals ?? [];
        const options = selectionOptions(body);
        requireExpectedRevisions(options, [...Object.keys(selections), ...removals.map((item) => item?.provider)]);
        return reply(200, await controller.applySelection(selections, { ...options, removals }));
      }
      if (req.method === 'POST' && path === '/model-sync/api/viewed') {
        const body = await readBody(req);
        if (typeof body.provider !== 'string' || !body.provider || typeof body.revision !== 'string' || !body.revision) throw badRequest('provider 和 revision 为必填');
        return reply(200, await controller.markViewed(body.provider, body.revision));
      }
      if (req.method === 'POST' && path === '/model-sync/api/opened') return reply(200, controller.markOpened());
      if (req.method === 'POST' && (path === '/model-sync/api/settings' || path === '/model-sync/api/habits')) {
        const body = await readBody(req);
        const key = path.endsWith('/habits') ? 'enabled' : 'managed';
        if (typeof body.provider !== 'string' || !body.provider || typeof body[key] !== 'boolean') throw badRequest(`provider 和布尔值 ${key} 为必填`);
        if (key === 'enabled') controller.setSelectionHabit(body.provider, body.enabled);
        else controller.setManaged(body.provider, body.managed);
        return reply(200, controller.status());
      }
      if (req.method === 'GET' && path === '/model-sync/api/proxy') return reply(200, controller.proxyStatus());
      if (req.method === 'POST' && path === '/model-sync/api/proxy') {
        // A cross-site page can send text/plain without a CORS preflight; this
        // route changes process-wide networking, so require the JSON type the
        // panel actually sends and reject the simple-request shapes.
        const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') throw badRequest('content-type 必须是 application/json', 415);
        const body = await readBody(req);
        if (!own(body, 'enabled') || typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是布尔值');
        return reply(200, await controller.setProxyEnabled(body.enabled));
      }
      if (req.method === 'GET' && path === '/model-sync/api/managed') return reply(200, controller.managedSiblings());
      if (req.method === 'POST' && (path === '/model-sync/api/remove-managed' || path === '/model-sync/api/remove')) {
        const body = await readBody(req);
        const items = removalItems(body);
        const options = selectionOptions(body);
        requireExpectedRevisions(options, controller.resolveRemovals(items).map((item) => item.provider));
        const outcome = path.endsWith('/remove-managed')
          ? await controller.removeManagedModels(items, options)
          : await controller.removeSiblingModels(items, options);
        return reply(200, { ...outcome, ok: outcome.errors.length === 0 });
      }
      return reply(404, { error: 'not found' });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      const message = error?.safe === true && typeof error.publicMessage === 'string' ? error.publicMessage
        : '操作失败；未显示可能包含凭证的内部错误，请重新检查后重试';
      return reply(status, { error: message });
    }
  };
  return webServer.register({ kind: 'prefix', path: '/model-sync', handler });
}
