/*
 * Official account directories and explicitly labelled public OpenAPI catalogs.
 * A public schema is never an account-availability check or an API-list fallback.
 * Documentation checked 2026-11-12 (listing is NOT a live API availability test):
 * OpenAI: https://developers.openai.com/api/reference/resources/models/methods/list.md
 * Anthropic: https://platform.claude.com/docs/en/api/models/list.md
 * DeepSeek: https://api-docs.deepseek.com/api/list-models.md
 * Moonshot CN: https://platform.kimi.com/docs/api/list-models.md
 * Google: https://aistudio.google.com/api-reference/models/list-models.md
 * xAI: https://docs.x.ai/developers/rest-api-reference/inference/models.md
 * Meta: https://dev.meta.ai/docs/api-reference/models/list-models.md
 *
 * Unsupported means "no verified directory contract", NOT "API nonexistent".
 * Coding products/regions never borrow another product's credentials or catalog.
 * In particular Meta Model API (Muse) and the historical Llama API are distinct.
 */

const MAX_PAGES = 100;
const MAX_MODELS = 100_000;
const ANTHROPIC_VERSION = '2026-10-21';
const REASONS = Object.freeze({
  coding: '尚未核实该官方 Coding 产品的目录契约；不能使用普通 API 目录代替。',
  llama: '尚未证实历史 Llama API 当前目录及可用状态；不能自动替换为 Meta Muse API。',
});
const SCHEMA_NOTICE = '官方公开目录，非账号可用性验证';
const PUBLIC_SCHEMAS = Object.freeze({
  'api-cn': {
    url: 'https://docs.bigmodel.cn/openapi/openapi.json',
    server: 'https://open.bigmodel.cn/api',
    format: 'json',
  },
  'api-intl': {
    url: 'https://docs.z.ai/api-reference/llm/chat-completion.md',
    server: 'https://api.z.ai/api',
    format: 'markdown',
  },
});
// Official implementation evidence for the shared Moonshot / Coding list API:
// https://github.com/MoonshotAI/kimi-cli/blob/8283d785a6b1fa582e8d175f848815d7eef9af17/src/kimi_cli/auth/platforms.py
// Regional Coding base URLs: https://www.kimi.com/code/docs/en/kimi-code/models.html
// Public schemas above are separate products/regions, never an authenticated fallback.

/** Recognize exact official HTTPS origins AND product base paths, not SDK brands. */
export function identifyOfficialEndpoint(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length > 2048 || /[\s\\%?#]/u.test(baseURL)) return undefined;
  const parts = /^https:\/\/([^/]+)(\/.*)?$/iu.exec(baseURL);
  if (!parts) return undefined;
  let url;
  try { url = new URL(baseURL); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  // Reject empty userinfo, encoded authorities, unusual ports, dot segments and
  // backslashes BEFORE URL normalization can disguise them as an approved URL.
  const authority = parts[1].toLowerCase();
  if (authority !== url.hostname && authority !== `${url.hostname}:443`) return undefined;
  const rawPath = parts[2] || '';
  if (url.pathname !== (rawPath || '/')) return undefined;
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const at = (...paths) => paths.includes(path);
  const endpoint = (vendor, product, protocol, discoveryPath, reason, nativeProtocol) => Object.freeze({
    vendor, product, protocol,
    baseURL: `${url.origin}${path}`,
    discoveryBase: `${url.origin}${discoveryPath}`,
    status: reason ? 'unsupported' : 'supported',
    source: vendor === 'zhipu' && PUBLIC_SCHEMAS[product] ? 'official-schema' : 'official-api',
    ...(reason ? { reason } : {}),
    // The wire protocol DSH's installed catalog uses for model calls when it
    // differs from the protocol this plugin uses to LIST models. OpenAI lists
    // through chat/completions but its installed models speak Responses.
    ...(nativeProtocol ? { nativeProtocol } : {}),
  });
  switch (url.hostname) {
    case 'api.openai.com':
      if (at('', '/v1')) return endpoint('openai', 'api', 'openai-completions', '/v1', undefined, 'openai-responses');
      break;
    case 'api.anthropic.com':
      if (at('', '/v1')) return endpoint('anthropic', 'api', 'anthropic-messages', '/v1');
      break;
    case 'api.deepseek.com':
      if (at('', '/v1', '/anthropic')) return endpoint('deepseek', 'api',
        path === '/anthropic' ? 'anthropic-messages' : 'openai-completions', '');
      break;
    case 'api.moonshot.cn':
    case 'api.moonshot.ai':
      if (at('', '/v1', '/anthropic')) {
        const international = url.hostname === 'api.moonshot.ai';
        return endpoint('kimi', international ? 'moonshot-intl' : 'moonshot-cn',
          path === '/anthropic' ? 'anthropic-messages' : 'openai-completions', '/v1');
      }
      break;
    case 'api.kimi.com':
    case 'api.kimi.ai':
      if (at('/coding', '/coding/v1')) return endpoint('kimi',
        url.hostname === 'api.kimi.com' ? 'coding-cn' : 'coding-intl',
        path === '/coding' ? 'anthropic-messages' : 'openai-completions', '/coding/v1');
      break;
    case 'open.bigmodel.cn':
    case 'api.z.ai': {
      const region = url.hostname === 'open.bigmodel.cn' ? 'cn' : 'intl';
      if (at('/api/paas/v4')) return endpoint('zhipu', `api-${region}`, 'openai-completions', path);
      if (at('/api/coding/paas/v4', '/api/anthropic', '/api/v1')) {
        const protocol = path === '/api/anthropic' ? 'anthropic-messages'
          : path === '/api/v1' ? 'openai-responses' : 'openai-completions';
        return endpoint('zhipu', `coding-${region}`, protocol, path, REASONS.coding);
      }
      break;
    }
    case 'generativelanguage.googleapis.com':
      if (at('', '/v1', '/v1beta')) return endpoint('google', 'gemini', 'generative', path || '/v1beta');
      if (at('/v1beta/openai')) return endpoint('google', 'gemini', 'openai-completions', '/v1beta');
      break;
    case 'api.x.ai':
      if (at('', '/v1')) return endpoint('xai', 'api', 'openai-completions', '/v1');
      break;
    case 'api.meta.ai':
      if (at('', '/v1')) return endpoint('meta', 'model-api', 'openai-completions', '/v1');
      break;
    case 'api.llama.com':
      if (at('', '/v1')) return endpoint('meta', 'llama-api', 'openai-completions', '/v1', REASONS.llama);
      break;
  }
  return undefined;
}

class DirectoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OfficialDirectoryError';
    this.code = code;
    this.safe = true;
    this.publicMessage = message;
  }
}
const fail = (code, message) => { throw new DirectoryError(code, message); };
const invalid = () => fail('INVALID_CATALOG', '官方模型目录格式不完整或非法；保留上次成功目录。');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const idText = value => text(value) && !/\s/u.test(value);
const optional = value => value === undefined || value === null;

function stringField(value) {
  if (optional(value)) return undefined;
  if (!text(value) || value.trim() !== value) invalid();
  return value;
}
function tokenLimit(value) {
  if (optional(value)) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}
function strings(value) {
  if (optional(value)) return undefined;
  if (!Array.isArray(value) || value.some(item => !idText(item))) invalid();
  return [...new Set(value)];
}
function booleanField(value) {
  if (optional(value)) return undefined;
  if (typeof value !== 'boolean') invalid();
  return value;
}

// An explicit conservative classification policy, NOT an API-supplied capability.
// Unknown IDs are retained, disabled: neither capabilities nor deletions are inferred.
const SPECIALIZED = /(?:embed|moderation|dall-e|whisper|transcrib|(?:^|[-_.])(?:audio|tts|speech|realtime|image|imagine|video|sora|instruct|search-api)(?:$|[-_.]))/iu;
function isKnownTextModel(vendor, id, row) {
  if (SPECIALIZED.test(id)) return false;
  if ((vendor === 'deepseek' || vendor === 'xai')
    && ((!optional(row.input_modalities) && !row.input_modalities.includes('text'))
      || (!optional(row.output_modalities) && !row.output_modalities.includes('text')))) return false;
  const baseID = id.startsWith('ft:') ? id.slice(3).split(':')[0] : id;
  switch (vendor) {
    case 'openai':
      return /^(?:gpt-(?:3\.5-turbo|4(?:\.\d+)?o?|[5-9](?:\.\d+)?)(?:-|$)|chatgpt-(?:4o|[5-9](?:\.\d+)?)(?:-|$)|o[134](?:-|$)|codex-mini(?:-|$))/u.test(baseID);
    case 'anthropic':
      return /^claude-/u.test(id) && row.lifecycle !== 'retired';
    case 'deepseek':
      return /^deepseek-(?:chat|reasoner|coder)(?:-|$)/u.test(id)
        || /^deepseek-v[234](?:[.-]|$)/u.test(id)
        || (row.input_modalities?.includes('text') === true && row.output_modalities?.includes('text') === true);
    case 'kimi':
      return /^(?:kimi-(?:k\d|latest|for-coding)|moonshot-v\d|k[\d]+(?:[.-]|$))/u.test(id);
    case 'google':
      return row.supportedGenerationMethods?.includes('generateContent') === true
        && /^(?:gemini-(?:\d|pro|flash)|gemma-\d)/u.test(id);
    case 'xai':
      // /language-models is expressly the chat + image-understanding directory.
      return optional(row.output_modalities) || row.output_modalities.includes('text');
    case 'meta':
      return /^muse-(?:wonder|spark|ember)-\d/u.test(id);
    default:
      return false;
  }
}

function normalizeModel(vendor, row) {
  if (!record(row)) invalid();
  let id = row.id;
  if (vendor === 'google') {
    if (!idText(row.name) || !/^models\/[^/]+$/u.test(row.name)) invalid();
    id = row.name.slice('models/'.length);
    strings(row.supportedGenerationMethods);
    stringField(row.baseModelId);
    stringField(row.version);
  }
  if (!idText(id)) invalid();
  if (vendor === 'anthropic') {
    if (row.type !== 'model') invalid();
    if (!optional(row.lifecycle) && !['active', 'deprecated', 'retired'].includes(row.lifecycle)) invalid();
    if (!optional(row.capabilities) && !record(row.capabilities)) invalid();
  } else if (vendor === 'kimi' || vendor === 'xai') {
    if (!optional(row.object) && row.object !== 'model') invalid();
  } else if (vendor !== 'google' && row.object !== 'model') {
    invalid();
  }
  if (!optional(row.created) && (!Number.isSafeInteger(row.created) || row.created < 0)) invalid();
  stringField(row.owned_by);
  let name;
  let contextWindow;
  let maxTokens;
  let input;
  switch (vendor) {
    case 'anthropic':
      name = stringField(row.display_name);
      // These are advertised INPUT and OUTPUT limits; do not add them together.
      contextWindow = tokenLimit(row.max_input_tokens);
      maxTokens = tokenLimit(row.max_tokens);
      if (row.capabilities) {
        const image = row.capabilities.image_input;
        if (!optional(image) && !record(image)) invalid();
        const supported = booleanField(image?.supported);
        if (supported === true) input = ['text', 'image'];
        else if (supported === false) input = ['text'];
      }
      break;
    case 'deepseek':
      name = stringField(row.name);
      contextWindow = tokenLimit(row.context_window);
      maxTokens = tokenLimit(row.max_output_tokens);
      input = strings(row.input_modalities);
      strings(row.output_modalities);
      break;
    case 'kimi': {
      name = stringField(row.display_name);
      contextWindow = tokenLimit(row.context_length);
      const image = booleanField(row.supports_image_in);
      const video = booleanField(row.supports_video_in);
      booleanField(row.supports_reasoning);
      if (image !== undefined || video !== undefined) {
        input = ['text', ...(image ? ['image'] : []), ...(video ? ['video'] : [])];
      }
      break;
    }
    case 'google':
      name = stringField(row.displayName);
      contextWindow = tokenLimit(row.inputTokenLimit);
      maxTokens = tokenLimit(row.outputTokenLimit);
      break;
    case 'xai':
      input = strings(row.input_modalities);
      strings(row.output_modalities);
      // /language-models does not document context_length. Do not copy guessed limits.
      break;
    // OpenAI/Meta expose IDs, not a generic typed context/capability contract.
  }
  const selectable = isKnownTextModel(vendor, id, row);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    selectable,
    ...(!selectable ? { reason: row.lifecycle === 'retired' ? '上游标记为 retired。' : '非通用聊天模型，或官方目录未提供足够的聊天能力证据。' } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(input === undefined ? {} : { input }),
  };
}

function requestHeaders(vendor, apiKey, extra) {
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 16_384 || !/^[\x21-\x7e]+$/u.test(apiKey)) {
    fail('INVALID_CREDENTIAL', '缺少有效的官方 API 凭据；未请求模型目录。');
  }
  let headers;
  try { headers = new Headers(extra); } catch { fail('INVALID_HEADERS', '目录请求头格式非法。'); }
  const allowed = new Set(['accept', 'user-agent']);
  if (vendor === 'anthropic') ['anthropic-version', 'anthropic-workspace-id', 'anthropic-beta'].forEach(key => allowed.add(key));
  if (vendor === 'openai') ['openai-organization', 'openai-project'].forEach(key => allowed.add(key));
  for (const key of headers.keys()) {
    if (!allowed.has(key)) fail('INVALID_HEADERS', '目录请求包含未经允许的请求头；不会覆盖凭据或发送跨服务商请求头。');
  }
  headers.set('accept', 'application/json');
  if (vendor === 'google') headers.set('x-goog-api-key', apiKey);
  else headers.set('authorization', `Bearer ${apiKey}`);
  if (vendor === 'anthropic' && !headers.has('anthropic-version')) headers.set('anthropic-version', ANTHROPIC_VERSION);
  return headers;
}

function ensureNoUndocumentedContinuation(body, count) {
  for (const key of ['has_more', 'hasMore']) {
    if (body[key] !== undefined && body[key] !== false) invalid();
  }
  for (const value of [body.nextPageToken, body.next_page_token, body.next_page, body.next, body.next_cursor, body.nextCursor,
    body.next_url, body.nextUrl, body.continuation_token, body.continuationToken, body.pagination, body.paging, body.page_info, body.links?.next]) {
    if (value !== undefined && value !== null && value !== '') invalid();
  }
  if (body.total !== undefined && (!Number.isSafeInteger(body.total) || body.total !== count)) invalid();
}

// The international documentation exposes OpenAPI as a fenced YAML block, not a
// JSON download. This deliberately parses ONLY the observed structural subset.
// Changed indentation, references, enums or ambiguity fail closed; it is not a
// general YAML parser and never scrapes model-looking words from prose/examples.
function yamlSection(lines, key, indent) {
  const prefix = `${' '.repeat(indent)}${key}:`;
  const indexes = lines.flatMap((line, index) => line.trimEnd() === prefix ? [index] : []);
  if (indexes.length !== 1) invalid();
  const start = indexes[0] + 1;
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/u) <= indent) break;
    end++;
  }
  return lines.slice(start, end);
}
function yamlScalar(lines, key, indent) {
  const prefix = `${' '.repeat(indent)}${key}: `;
  const values = lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim());
  if (values.length !== 1) invalid();
  const value = values[0];
  if (/^[A-Za-z0-9_./:#-]+$/u.test(value)) return value;
  if (/^'[A-Za-z0-9_./:#-]+'$/u.test(value) || /^"[A-Za-z0-9_./:#-]+"$/u.test(value)) return value.slice(1, -1);
  invalid();
}
function parseZaiMarkdown(document) {
  if (typeof document !== 'string' || document.length > 8 * 1024 * 1024) invalid();
  const blocks = [...document.matchAll(/^(`{3,})yaml POST \/paas\/v4\/chat\/completions[ \t]*\r?\n([\s\S]*?)^\1[ \t]*\r?$/gmu)];
  if (blocks.length !== 1) invalid();
  const lines = blocks[0][2].split(/\r?\n/u);
  if (!/^3\./u.test(yamlScalar(lines, 'openapi', 0))) invalid();
  const serverLines = yamlSection(lines, 'servers', 0).filter(line => line.trim());
  if (serverLines.length < 1 || serverLines.length > 2 || !/^  - url: https:\/\/api\.z\.ai\/api\/?$/u.test(serverLines[0])
    || (serverLines.length === 2 && !/^ {4}description: [^\r\n]+$/u.test(serverLines[1]))) invalid();
  let request = yamlSection(lines, 'paths', 0);
  for (const [key, indent] of [
    ['/paas/v4/chat/completions', 2], ['post', 4], ['requestBody', 6], ['content', 8],
    ['application/json', 10], ['schema', 12], ['oneOf', 14],
  ]) request = yamlSection(request, key, indent);
  const refs = request.filter(line => /^ {16}- /u.test(line)).map(line => {
    const match = /^ {16}- \$ref: ['"]?(#\/components\/schemas\/ChatCompletion(?:Text|Vision)Request)['"]?$/u.exec(line);
    if (!match) invalid();
    return { $ref: match[1] };
  });
  if (refs.length !== 2 || new Set(refs.map(ref => ref.$ref)).size !== 2) invalid();
  const componentSchemas = yamlSection(yamlSection(lines, 'components', 0), 'schemas', 2);
  const schemas = {};
  for (const ref of refs) {
    const name = ref.$ref.split('/').at(-1);
    const properties = yamlSection(yamlSection(componentSchemas, name, 4), 'properties', 6);
    const model = yamlSection(properties, 'model', 8);
    if (yamlScalar(model, 'type', 10) !== 'string') invalid();
    const enumeration = yamlSection(model, 'enum', 10).filter(line => line.trim()).map(line => {
      const match = /^ {12}- ([a-zA-Z0-9][a-zA-Z0-9._:/-]*)$/u.exec(line);
      if (!match) invalid();
      return match[1];
    });
    schemas[name] = { properties: { model: { type: 'string', enum: enumeration } } };
  }
  return {
    openapi: '3.0.1', servers: [{ url: 'https://api.z.ai/api' }],
    paths: { '/paas/v4/chat/completions': { post: { requestBody: {
      content: { 'application/json': { schema: { oneOf: refs } } },
    } } } },
    components: { schemas },
  };
}
function normalizePublicSchema(document, schemaSource) {
  if (!record(document) || typeof document.openapi !== 'string' || !/^3\./u.test(document.openapi)
    || !Array.isArray(document.servers) || !document.servers.some(server => server?.url?.replace(/\/$/u, '') === schemaSource.server)) invalid();
  const composition = document.paths?.['/paas/v4/chat/completions']?.post?.requestBody?.content?.['application/json']?.schema?.oneOf;
  if (!Array.isArray(composition) || composition.length < 2 || composition.length > 3) invalid();
  const groups = new Set();
  const byID = new Map();
  for (const branch of composition) {
    const match = /^#\/components\/schemas\/ChatCompletion(Text|Vision|Audio)Request$/u.exec(branch?.$ref || '');
    if (!match || groups.has(match[1])) invalid();
    const group = match[1];
    groups.add(group);
    const spec = document.components?.schemas?.[`ChatCompletion${group}Request`]?.properties?.model;
    if (spec?.type !== 'string' || !Array.isArray(spec.enum) || spec.enum.length === 0) invalid();
    const seen = new Set();
    for (const id of spec.enum) {
      // One documented CN enum contains this non-model sentinel. Do not turn it
      // into a model or silently skip any other malformed/unfamiliar value.
      if (id === '禁用仅占位' && group === 'Audio' && schemaSource.server === 'https://open.bigmodel.cn/api') continue;
      if (!idText(id) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(id) || seen.has(id)) invalid();
      seen.add(id);
      const selectable = group !== 'Audio' && !SPECIALIZED.test(id) && !/^autoglm-/u.test(id);
      const input = group === 'Vision' ? ['text', 'image'] : group === 'Audio' ? ['audio'] : ['text'];
      const previous = byID.get(id);
      if (previous) {
        previous.selectable ||= selectable;
        previous.input = [...new Set([...previous.input, ...input])];
        if (previous.selectable) delete previous.reason;
      } else {
        byID.set(id, { id, selectable, input, ...(!selectable ? { reason: '官方请求 schema 中的音频或专用模型，不作为通用聊天模型。' } : {}) });
      }
    }
    if (seen.size === 0) invalid();
  }
  if (!groups.has('Text') || !groups.has('Vision') || byID.size === 0 || byID.size > MAX_MODELS) invalid();
  return [...byID.values()];
}

/**
 * Atomically obtain a complete, nonempty catalog within its declared source, or
 * throw a sanitized Error. A public schema is explicit, NOT a failed-API fallback.
 * All valid IDs survive classification; never filter disabled IDs before storing
 * or comparing. A public schema cannot prove account access or API-wide removal.
 */
export async function discoverOfficialModels(endpoint, {
  apiKey, fetchImpl = globalThis.fetch, signal, timeoutMs = 20_000, headers = {},
} = {}) {
  const trusted = identifyOfficialEndpoint(endpoint?.baseURL);
  if (!trusted || ['vendor', 'product', 'discoveryBase'].some(key => endpoint[key] !== trusted[key])) {
    fail('UNSUPPORTED_ENDPOINT', '不是已核实的官方模型目录端点。');
  }
  if (trusted.status === 'unsupported') fail('UNSUPPORTED_DIRECTORY', trusted.reason);
  if (typeof fetchImpl !== 'function') fail('INVALID_TRANSPORT', '模型目录请求器不可用。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) fail('INVALID_TIMEOUT', '目录请求超时参数非法。');
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    fail('INVALID_SIGNAL', '目录请求取消信号非法。');
  }
  if (signal?.aborted) fail('ABORTED', '模型目录请求已取消；保留上次成功目录。');
  const schemaSource = trusted.vendor === 'zhipu' ? PUBLIC_SCHEMAS[trusted.product] : undefined;
  // Public documentation requests intentionally ignore apiKey AND every supplied
  // extra header (including workspace/project/user-agent identifiers).
  const outgoingHeaders = schemaSource
    ? new Headers({ accept: schemaSource.format === 'json' ? 'application/json' : 'text/markdown,text/plain' })
    : requestHeaders(trusted.vendor, apiKey, headers);
  const controller = new AbortController();
  let rejectStop;
  let timedOut = false;
  const stop = new Promise((_, reject) => { rejectStop = reject; });
  const onAbort = () => {
    controller.abort();
    rejectStop(new DirectoryError('ABORTED', '模型目录请求已取消；保留上次成功目录。'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectStop(new DirectoryError('TIMEOUT', '模型目录请求或响应正文读取超时；保留上次成功目录。'));
  }, timeoutMs);
  const checkAbort = () => {
    if (controller.signal.aborted) fail(timedOut ? 'TIMEOUT' : 'ABORTED', '模型目录请求未完成；保留上次成功目录。');
  };
  const readDocument = async (url, format = 'json') => {
    checkAbort();
    const response = await fetchImpl(url, {
      method: 'GET', headers: new Headers(outgoingHeaders), redirect: 'error',
      credentials: 'omit', signal: controller.signal,
    });
    checkAbort();
    if (!response || !Number.isInteger(response.status)) invalid();
    if (response.redirected || (response.url && response.url !== url)) {
      fail('REDIRECT_REFUSED', '官方目录请求发生重定向或目标变化；已拒绝继续。');
    }
    if (response.status !== 200) {
      const status = response.status >= 100 && response.status <= 599 ? response.status : '异常';
      // The numeric status stays internal so the caller can distinguish
      // "this product has no list endpoint" from an auth or transport failure.
      const error = new DirectoryError('HTTP_ERROR', `官方目录请求失败（HTTP ${status}）；保留上次成功目录。`);
      if (Number.isInteger(response.status)) error.status = response.status;
      throw error;
    }
    const contentType = response.headers?.get?.('content-type');
    if (format === 'json') {
      if (contentType && !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)) invalid();
    } else if (contentType && !/^text\/(?:markdown|plain)(?:\s*;|$)/iu.test(contentType)) invalid();
    const body = await (format === 'json' ? response.json() : response.text());
    checkAbort();
    return body;
  };
  const run = async () => {
    const { vendor, discoveryBase } = trusted;
    if (schemaSource) {
      const body = await readDocument(schemaSource.url, schemaSource.format);
      const schema = schemaSource.format === 'markdown' ? parseZaiMarkdown(body) : body;
      const models = normalizePublicSchema(schema, schemaSource);
      return {
        models, base: schemaSource.url, pages: 1, source: 'official-schema',
        notice: SCHEMA_NOTICE, scope: 'chat-completions-model-enum',
      };
    }
    const models = [];
    const seenIDs = new Set();
    const seenCursors = new Set();
    let cursor;
    for (let page = 1; page <= MAX_PAGES; page++) {
      checkAbort();
      const url = new URL(`${discoveryBase}/${vendor === 'xai' ? 'language-models' : 'models'}`);
      if (vendor === 'anthropic') {
        url.searchParams.set('limit', '1000');
        if (cursor !== undefined) url.searchParams.set('after_id', cursor);
      } else if (vendor === 'google') {
        url.searchParams.set('pageSize', '1000');
        if (cursor !== undefined) url.searchParams.set('pageToken', cursor);
      }
      const body = await readDocument(url.href);
      if (!record(body) || !optional(body.error)) invalid();
      const rows = vendor === 'google' || vendor === 'xai' ? body.models : body.data;
      if (!Array.isArray(rows)) invalid();
      if (!['anthropic', 'google', 'xai', 'kimi'].includes(vendor) && body.object !== 'list') invalid();
      if (vendor === 'kimi' && !optional(body.object) && body.object !== 'list') invalid();
      const normalized = rows.map(row => normalizeModel(vendor, row));
      let next;
      if (vendor === 'anthropic') {
        if (typeof body.has_more !== 'boolean') invalid();
        if (rows.length === 0) {
          if (body.first_id !== null || body.last_id !== null || body.has_more) invalid();
        } else if (body.first_id !== normalized[0].id || body.last_id !== normalized.at(-1).id) {
          invalid();
        }
        if (body.has_more) next = body.last_id;
      } else if (vendor === 'google') {
        if (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') invalid();
        if (body.nextPageToken) {
          if (!text(body.nextPageToken) || body.nextPageToken.trim() !== body.nextPageToken) invalid();
          next = body.nextPageToken;
        }
      } else {
        ensureNoUndocumentedContinuation(body, rows.length);
      }
      if (next !== undefined && rows.length === 0) invalid();
      for (const model of normalized) {
        if (seenIDs.has(model.id)) fail('DUPLICATE_MODEL', '官方目录含重复模型 ID；保留上次成功目录。');
        seenIDs.add(model.id);
        models.push(model);
        if (models.length > MAX_MODELS) fail('CATALOG_LIMIT', '官方目录超过安全读取上限；不能提交不完整目录。');
      }
      if (next === undefined) {
        if (models.length === 0) fail('EMPTY_CATALOG', '官方模型目录为空；保留上次成功目录。');
        return { models, base: discoveryBase, pages: page, source: 'official-api' };
      }
      if (seenCursors.has(next)) fail('CURSOR_LOOP', '官方目录分页游标重复；不能提交不完整目录。');
      seenCursors.add(next);
      cursor = next;
    }
    fail('PAGE_LIMIT', '官方目录分页超过安全读取上限；不能提交不完整目录。');
  };
  try {
    return await Promise.race([run(), stop]);
  } catch (error) {
    if (error instanceof DirectoryError) throw error;
    // Never expose server bodies, URLs, API keys, upstream exceptions or causes.
    if (timedOut) fail('TIMEOUT', '模型目录请求或响应正文读取超时；保留上次成功目录。');
    if (signal?.aborted) fail('ABORTED', '模型目录请求已取消；保留上次成功目录。');
    fail('REQUEST_FAILED', '官方目录请求或响应解析失败；保留上次成功目录。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
