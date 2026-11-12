import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyOfficialEndpoint as identify, discoverOfficialModels as discover } from '../lib/official.js';

const KEY = 'unit-test-not-a-real-key';
const model = (id, extra = {}) => ({ id, object: 'model', ...extra });
const list = (...data) => ({ object: 'list', data });
const anthropic = (id, extra = {}) => ({ id, type: 'model', ...extra });
const google = (id, extra = {}) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'], ...extra });
const page = (data, has_more = false) => ({ data, has_more, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
const CN = 'https://docs.bigmodel.cn/openapi/openapi.json';
const INTL = 'https://docs.z.ai/api-reference/llm/chat-completion.md';
function response(body, overrides = {}) {
  return { status: 200, redirected: false, url: '', headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => structuredClone(body), text: async () => String(body), ...overrides };
}
function queued(...responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, 'unexpected extra request');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { fetchImpl, calls };
}
async function run(base, bodies, extra = {}) {
  const transport = queued(...bodies.map(body => response(body)));
  const result = await discover(identify(base), { apiKey: KEY, fetchImpl: transport.fetchImpl, ...extra });
  return { ...transport, result };
}
const rejects = (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.name, 'OfficialDirectoryError');
  assert.equal(error.code, code);
  assert.equal(error.safe, true);
  assert.equal(error.publicMessage, error.message);
  assert.ok(!error.message.includes(KEY));
  return true;
});
function schema(server = 'https://open.bigmodel.cn/api/', audio = true) {
  const groups = { Text: ['glm-5.3', 'glm-4.7'], Vision: ['glm-5.3-flash', 'autoglm-phone'], ...(audio ? { Audio: ['glm-4-voice', '禁用仅占位'] } : {}) };
  return { openapi: '3.0.1', servers: [{ url: server }], paths: { '/paas/v4/chat/completions': { post: { requestBody: { content: {
    'application/json': { schema: { oneOf: Object.keys(groups).map(group => ({ $ref: `#/components/schemas/ChatCompletion${group}Request` })) } },
  } } } } }, components: { schemas: Object.fromEntries(Object.entries(groups).map(([group, ids]) => [
    `ChatCompletion${group}Request`, { properties: { model: { type: 'string', enum: ids }, max_tokens: { maximum: 131072 } } },
  ])) } };
}
const INTL_MARKDOWN = `# Chat Completion
Prose/example models are not a catalog: glm-fake.
\`\`\`\`yaml POST /paas/v4/chat/completions
openapi: 3.0.1
servers:
  - url: https://api.z.ai/api
    description: Production server
paths:
  /paas/v4/chat/completions:
    post:
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: '#/components/schemas/ChatCompletionTextRequest'
                  title: Text Model
                - $ref: '#/components/schemas/ChatCompletionVisionRequest'
                  title: Vision Model
components:
  schemas:
    ChatCompletionTextRequest:
      type: object
      properties:
        model:
          type: string
          enum:
            - glm-5.3
            - glm-4.7
          example: glm-5.3
        max_tokens:
          maximum: 131072
    ChatCompletionVisionRequest:
      type: object
      properties:
        model:
          type: string
          enum:
            - glm-5.3-flash
\`\`\`\`
`;

for (const [base, vendor, product, discoveryBase] of [
  ['https://api.openai.com/v1/', 'openai', 'api', 'https://api.openai.com/v1'],
  ['https://api.anthropic.com', 'anthropic', 'api', 'https://api.anthropic.com/v1'],
  ['https://api.deepseek.com/anthropic', 'deepseek', 'api', 'https://api.deepseek.com'],
  ['https://api.moonshot.cn/anthropic', 'kimi', 'moonshot-cn', 'https://api.moonshot.cn/v1'],
  ['https://api.moonshot.ai/v1', 'kimi', 'moonshot-intl', 'https://api.moonshot.ai/v1'],
  ['https://api.kimi.com/coding', 'kimi', 'coding-cn', 'https://api.kimi.com/coding/v1'],
  ['https://api.kimi.ai/coding/v1', 'kimi', 'coding-intl', 'https://api.kimi.ai/coding/v1'],
  ['https://open.bigmodel.cn/api/paas/v4', 'zhipu', 'api-cn', 'https://open.bigmodel.cn/api/paas/v4'],
  ['https://api.z.ai/api/paas/v4', 'zhipu', 'api-intl', 'https://api.z.ai/api/paas/v4'],
  ['https://generativelanguage.googleapis.com/v1beta/openai', 'google', 'gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  ['https://api.x.ai/v1', 'xai', 'api', 'https://api.x.ai/v1'],
  ['https://api.meta.ai/v1', 'meta', 'model-api', 'https://api.meta.ai/v1'],
]) test(`recognizes exact official product ${base}`, () => {
  const result = identify(base);
  assert.equal(result.vendor, vendor);
  assert.equal(result.product, product);
  assert.equal(result.discoveryBase, discoveryBase);
  assert.equal(result.status, 'supported');
});

test('normalizes harmless HTTPS case/default port; recognizes native Google transport', () => {
  assert.equal(identify('HTTPS://API.OPENAI.COM:443/v1').baseURL, 'https://api.openai.com/v1');
  assert.equal(identify('https://generativelanguage.googleapis.com/v1').protocol, 'generative');
});
for (const base of [undefined, '', 7, 'http://api.openai.com/v1', 'https://api.openai.com.evil.test/v1',
  'https://evil.test/api.openai.com/v1', 'https://key@api.openai.com/v1', 'https://api.openai.com:8443/v1',
  'https://api.openai.com/v1?key=secret', 'https://api.openai.com/v1#fragment', 'https://api.openai.com/v1?',
  'https://api.openai.com/a/../v1', 'https://api.openai.com/%76%31', 'https://api.openai.com/v1//',
  'https://api.openai.com/v1/models', 'https://api.openai.com./v1', ' https://api.openai.com/v1',
  'https://api.openai.com\\evil', 'https://openrouter.ai/api/v1', 'https://generativelanguage.googleapis.com/v9',
]) test(`refuses unproven or unsafe base ${String(base)}`, () => assert.equal(identify(base), undefined));

test('unsupported Llama and Zhipu Coding never fetch or migrate', async () => {
  for (const base of ['https://api.llama.com/v1', 'https://api.z.ai/api/anthropic', 'https://open.bigmodel.cn/api/coding/paas/v4']) {
    const endpoint = identify(base);
    assert.equal(endpoint.status, 'unsupported');
    await rejects(discover(endpoint, { fetchImpl: () => assert.fail('must not fetch') }), 'UNSUPPORTED_DIRECTORY');
  }
});
test('revalidates descriptors and never trusts a caller-controlled discovery destination', async () => {
  const endpoint = { ...identify('https://api.openai.com/v1'), discoveryBase: 'https://evil.test' };
  await rejects(discover(endpoint, { apiKey: KEY, fetchImpl: () => assert.fail('must not fetch') }), 'UNSUPPORTED_ENDPOINT');
});

test('OpenAI retains nonchat/unknown rows, does not invent context, has no pagination', async () => {
  const { result, calls } = await run('https://api.openai.com/v1', [list(
    model('gpt-5.3'), model('o3'), model('text-embedding-3-large'), model('gpt-image-1'),
    model('gpt-4o-audio-preview'), model('gpt-realtime'), model('unknown-model'),
  )], { headers: { 'OpenAI-Project': 'unit-project' } });
  assert.equal(result.models.length, 7);
  assert.deepEqual(result.models.map(row => row.selectable), [true, true, false, false, false, false, false]);
  assert.ok(result.models.every(row => !('contextWindow' in row)));
  assert.equal(result.source, 'official-api');
  assert.equal(result.pages, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  const options = calls[0].options;
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(options.headers.get('openai-project'), 'unit-project');
});
test('Anthropic follows explicit has_more, including short pages, and preserves actual metadata', async () => {
  const { result, calls } = await run('https://api.anthropic.com/v1', [
    page([anthropic('claude-one', { display_name: 'Claude One', max_input_tokens: 200000, max_tokens: 64000, capabilities: { image_input: { supported: true } } })], true),
    page([anthropic('claude-two', { lifecycle: 'retired' })]),
  ], { headers: { 'anthropic-workspace-id': 'workspace-test' } });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '1000');
  assert.equal(new URL(calls[1].url).searchParams.get('after_id'), 'claude-one');
  assert.equal(calls[0].options.headers.get('anthropic-version'), '2026-10-21');
  assert.equal(calls[0].options.headers.get('anthropic-workspace-id'), 'workspace-test');
  assert.deepEqual(result.models[0], { id: 'claude-one', name: 'Claude One', selectable: true, contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] });
  assert.equal(result.models[1].selectable, false);
});
test('DeepSeek discovery stays /models even for Anthropic inference base', async () => {
  const { result, calls } = await run('https://api.deepseek.com/anthropic', [list(model('deepseek-v4', {
    name: 'DeepSeek V4', context_window: 1000000, max_output_tokens: 128000,
    input_modalities: ['text'], output_modalities: ['text'],
  }))]);
  assert.equal(calls[0].url, 'https://api.deepseek.com/models');
  assert.equal(result.models[0].contextWindow, 1000000);
  assert.equal(result.models[0].maxTokens, 128000);
});
test('explicit modality evidence overrides a recognizable model family', async () => {
  const deepseek = await run('https://api.deepseek.com', [list(model('deepseek-chat', { input_modalities: ['text'], output_modalities: ['audio'] }))]);
  const xai = await run('https://api.x.ai/v1', [{ models: [model('grok-4', { input_modalities: ['audio'], output_modalities: ['text'] })] }]);
  assert.equal(deepseek.result.models[0].selectable, false);
  assert.equal(xai.result.models[0].selectable, false);
});
test('Kimi SDK-backed CN/international/Coding schema accepts id-only and real booleans', async () => {
  for (const base of ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1', 'https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1']) {
    const { result, calls } = await run(base, [{ data: [
      { id: 'kimi-for-coding', display_name: 'Kimi Coding', context_length: 262144, supports_image_in: true, supports_video_in: false, supports_reasoning: true },
      { id: 'k2.5' }, { id: 'mystery' },
    ] }]);
    assert.equal(calls[0].url, `${base}/models`);
    assert.deepEqual(result.models[0].input, ['text', 'image']);
    assert.equal(result.models[0].name, 'Kimi Coding');
    assert.equal(result.models[1].selectable, true);
    assert.equal(result.models[1].contextWindow, undefined);
    assert.equal(result.models[2].selectable, false);
  }
});
test('Google follows tokens, strips only models/, filters method plus specialized family', async () => {
  const { result, calls } = await run('https://generativelanguage.googleapis.com/v1beta/openai', [
    { models: [google('gemini-3-flash', { inputTokenLimit: 1048576, outputTokenLimit: 65536 })], nextPageToken: 'page+two/=' },
    { models: [google('gemini-embedding-001', { supportedGenerationMethods: ['embedContent'] }), google('gemini-2.5-flash-preview-tts'), google('future-unknown')] },
  ]);
  assert.deepEqual(result.models.map(row => row.selectable), [true, false, false, false]);
  assert.equal(result.models[0].id, 'gemini-3-flash');
  assert.equal(result.models[0].contextWindow, 1048576);
  assert.equal(new URL(calls[1].url).searchParams.get('pageToken'), 'page+two/=');
  assert.equal(new URL(calls[1].url).searchParams.get('pageSize'), '1000');
  assert.ok(!calls[0].url.includes('/openai/'));
  assert.equal(calls[0].options.headers.get('x-goog-api-key'), KEY);
  assert.equal(calls[0].options.headers.has('authorization'), false);
});
test('xAI uses dedicated language catalog rather than all-modality /models', async () => {
  const { result, calls } = await run('https://api.x.ai/v1', [{ models: [model('grok-4', { input_modalities: ['text', 'image'], output_modalities: ['text'] })] }]);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/language-models');
  assert.equal(result.models[0].selectable, true);
  assert.equal(result.models[0].contextWindow, undefined);
});
test('current Meta Muse is explicit and distinct from historic Llama', async () => {
  const { result } = await run('https://api.meta.ai/v1', [list(model('muse-wonder-1'), model('muse-image-1'), model('llama-4'), model('muse-future'))]);
  assert.deepEqual(result.models.map(row => row.selectable), [true, false, false, false]);
});

test('CN public schema is unauthenticated, scoped and labelled; ignores only exact known placeholder', async () => {
  const { result, calls } = await run('https://open.bigmodel.cn/api/paas/v4', [schema()], {
    apiKey: undefined, headers: { authorization: `Bearer ${KEY}`, 'x-private-project': KEY },
  });
  assert.equal(calls[0].url, CN);
  assert.deepEqual([...calls[0].options.headers.keys()], ['accept']);
  assert.equal(result.source, 'official-schema');
  assert.equal(result.base, CN);
  assert.equal(result.scope, 'chat-completions-model-enum');
  assert.equal(result.notice, '官方公开目录，非账号可用性验证');
  assert.deepEqual(result.models.map(row => row.id), ['glm-5.3', 'glm-4.7', 'glm-5.3-flash', 'autoglm-phone', 'glm-4-voice']);
  assert.deepEqual(result.models.map(row => row.selectable), [true, true, true, false, false]);
  assert.ok(result.models.every(row => row.contextWindow === undefined && row.maxTokens === undefined));
});
test('international public schema parses only structurally-scoped enums, never prose or CN data', async () => {
  const transport = queued(response(INTL_MARKDOWN, { headers: new Headers({ 'content-type': 'text/markdown' }) }));
  const result = await discover(identify('https://api.z.ai/api/paas/v4'), { fetchImpl: transport.fetchImpl, apiKey: KEY, headers: { 'x-private': KEY } });
  assert.equal(transport.calls[0].url, INTL);
  assert.deepEqual([...transport.calls[0].options.headers.keys()], ['accept']);
  assert.deepEqual(result.models.map(row => row.id), ['glm-5.3', 'glm-4.7', 'glm-5.3-flash']);
  assert.equal(result.source, 'official-schema');
});
for (const [name, change] of [
  ['wrong region', data => { data.servers[0].url = 'https://api.z.ai/api'; }],
  ['unknown request branch', data => { data.paths['/paas/v4/chat/completions'].post.requestBody.content['application/json'].schema.oneOf.push({ $ref: '#/components/schemas/Surprise' }); }],
  ['missing enum', data => { delete data.components.schemas.ChatCompletionVisionRequest.properties.model.enum; }],
  ['empty enum', data => { data.components.schemas.ChatCompletionTextRequest.properties.model.enum = []; }],
  ['duplicate enum', data => { data.components.schemas.ChatCompletionTextRequest.properties.model.enum.push('glm-5.3'); }],
  ['unrecognized placeholder', data => { data.components.schemas.ChatCompletionAudioRequest.properties.model.enum.push('另一占位'); }],
]) test(`public schema rejects ${name} atomically`, async () => {
  const data = schema(); change(data);
  const transport = queued(response(data));
  await rejects(discover(identify('https://open.bigmodel.cn/api/paas/v4'), { fetchImpl: transport.fetchImpl }), 'INVALID_CATALOG');
  assert.equal(transport.calls.length, 1);
});
for (const [name, markdown] of [
  ['wrong region', INTL_MARKDOWN.replace('https://api.z.ai/api', 'https://open.bigmodel.cn/api')],
  ['duplicate OpenAPI blocks', INTL_MARKDOWN + INTL_MARKDOWN],
  ['missing required model enum', INTL_MARKDOWN.replace('          enum:', '          enumChanged:')],
  ['no OpenAPI block', '# Models\nglm-5.3'],
]) test(`international markdown fails closed: ${name}`, async () => {
  const transport = queued(response(markdown, { headers: new Headers({ 'content-type': 'text/plain' }) }));
  await rejects(discover(identify('https://api.z.ai/api/paas/v4'), { fetchImpl: transport.fetchImpl }), 'INVALID_CATALOG');
});

test('all-disabled nonempty catalogs are retained, never silently converted to empty', async () => {
  const { result } = await run('https://api.openai.com/v1', [list(model('text-embedding-3-small'))]);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].selectable, false);
});
for (const [name, data, code = 'INVALID_CATALOG'] of [
  ['missing envelope', {}], ['wrong data type', { object: 'list', data: {} }], ['null row', list(null)],
  ['missing id', list({ object: 'model' })], ['padded id', list(model(' gpt-5'))],
  ['error object', { ...list(model('gpt-5')), error: { message: KEY } }],
  ['duplicate id', list(model('gpt-5'), model('gpt-5')), 'DUPLICATE_MODEL'],
  ['empty', list(), 'EMPTY_CATALOG'], ['unknown continuation', { ...list(model('gpt-5')), next: 'next-page' }],
  ['total mismatch', { ...list(model('gpt-5')), total: 2 }],
  ['nested pagination', { ...list(model('gpt-5')), pagination: { has_more: true } }],
  ['undocumented continuation token', { ...list(model('gpt-5')), next_page_token: 'page-two' }],
]) test(`invalid/partial OpenAI catalog: ${name}`, async () => {
  const transport = queued(response(data));
  await rejects(discover(identify('https://api.openai.com/v1'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), code);
});
for (const [base, data] of [
  ['https://api.anthropic.com/v1', { data: [anthropic('claude-one')] }],
  ['https://api.anthropic.com/v1', { ...page([anthropic('claude-one')], true), last_id: 'wrong-id' }],
  ['https://api.anthropic.com/v1', page([], true)],
  ['https://api.deepseek.com', list(model('deepseek-chat', { context_window: '128000' }))],
  ['https://api.kimi.com/coding/v1', { data: [{ id: 'kimi-for-coding', supports_image_in: 'true' }] }],
  ['https://api.kimi.com/coding/v1', { object: 'unexpected', data: [{ id: 'kimi-for-coding' }] }],
  ['https://generativelanguage.googleapis.com/v1beta', { models: [google('gemini-3', { supportedGenerationMethods: 'generateContent' })] }],
]) test(`rejects malformed vendor metadata ${base} ${JSON.stringify(data)}`, async () => {
  const transport = queued(response(data));
  await rejects(discover(identify(base), { apiKey: KEY, fetchImpl: transport.fetchImpl }), 'INVALID_CATALOG');
});
test('later page failure never returns a partially accumulated catalog', async () => {
  const transport = queued(response(page([anthropic('claude-one')], true)), response({}, { status: 401 }));
  await rejects(discover(identify('https://api.anthropic.com/v1'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), 'HTTP_ERROR');
  assert.equal(transport.calls.length, 2);
});
test('Google repeated cursor is detected without requesting an unbounded loop', async () => {
  const transport = queued(response({ models: [google('gemini-one')], nextPageToken: 'same' }), response({ models: [google('gemini-two')], nextPageToken: 'same' }));
  await rejects(discover(identify('https://generativelanguage.googleapis.com/v1beta'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), 'CURSOR_LOOP');
  assert.equal(transport.calls.length, 2);
});
test('duplicate across pages is atomic failure', async () => {
  const transport = queued(response(page([anthropic('claude-one')], true)), response(page([anthropic('claude-one')])));
  await rejects(discover(identify('https://api.anthropic.com/v1'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), 'DUPLICATE_MODEL');
});
for (const status of [204, 206, 301, 401, 403, 429, 500]) test(`HTTP ${status} is never a deletion-authoritative empty list`, async () => {
  const transport = queued(response(list(), { status }));
  await rejects(discover(identify('https://api.openai.com/v1'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), 'HTTP_ERROR');
});
test('redirect evidence is refused even if a mocked fetch ignores redirect:error', async () => {
  for (const override of [{ redirected: true }, { url: 'https://evil.test/models' }]) {
    const transport = queued(response(list(model('gpt-5')), override));
    await rejects(discover(identify('https://api.openai.com/v1'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), 'REDIRECT_REFUSED');
  }
});
test('no credential/header override, failed request leak, or body/parser detail leaks', async () => {
  const endpoint = identify('https://api.openai.com/v1');
  for (const apiKey of ['', 'not a key', 'unicode-密钥', 'nul\u0000key', 'line\nkey', 'del\u007fkey']) {
    await rejects(discover(endpoint, { apiKey, fetchImpl: () => assert.fail('must not fetch') }), 'INVALID_CREDENTIAL');
  }
  await rejects(discover(endpoint, { apiKey: KEY, headers: { authorization: KEY }, fetchImpl: () => assert.fail('must not fetch') }), 'INVALID_HEADERS');
  for (const fetchImpl of [async () => { throw new Error(`private detail ${KEY}`); }, async () => response(null, { json: async () => { throw new SyntaxError(KEY); } })]) {
    await rejects(discover(endpoint, { apiKey: KEY, fetchImpl }), 'REQUEST_FAILED');
  }
});
test('overall deadline covers a hung response body; abort reasons stay private', async () => {
  let observedSignal;
  const fetchImpl = async (url, options) => {
    observedSignal = options.signal;
    return response(null, { json: () => new Promise(() => {}) });
  };
  await rejects(discover(identify('https://api.openai.com/v1'), { apiKey: KEY, fetchImpl, timeoutMs: 10 }), 'TIMEOUT');
  assert.equal(observedSignal.aborted, true);
  const controller = new AbortController(); controller.abort(new Error(KEY));
  await rejects(discover(identify('https://api.openai.com/v1'), { apiKey: KEY, fetchImpl: () => assert.fail('must not fetch'), signal: controller.signal }), 'ABORTED');
});
test('bounded pagination refuses an endless but nonrepeating Google cursor stream', async () => {
  let calls = 0;
  const fetchImpl = async () => response({ models: [google(`gemini-3-${++calls}`)], nextPageToken: `page-${calls}` });
  await rejects(discover(identify('https://generativelanguage.googleapis.com/v1beta'), { apiKey: KEY, fetchImpl }), 'PAGE_LIMIT');
  assert.equal(calls, 100);
});
test('active abort stops a pending request without exposing the caller abort reason', async () => {
  const controller = new AbortController();
  const fetchImpl = async () => { queueMicrotask(() => controller.abort(new Error(KEY))); return new Promise(() => {}); };
  await rejects(discover(identify('https://api.openai.com/v1'), { apiKey: KEY, fetchImpl, signal: controller.signal }), 'ABORTED');
});
test('public markdown body is included in the same overall deadline', async () => {
  const fetchImpl = async () => response(null, { headers: new Headers({ 'content-type': 'text/markdown' }), text: () => new Promise(() => {}) });
  await rejects(discover(identify('https://api.z.ai/api/paas/v4'), { fetchImpl, timeoutMs: 10 }), 'TIMEOUT');
});
test('public schema failure never falls back to guessed /models or another region', async () => {
  const transport = queued(response({}, { status: 503 }));
  await rejects(discover(identify('https://api.z.ai/api/paas/v4'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), 'HTTP_ERROR');
  assert.deepEqual(transport.calls.map(call => call.url), [INTL]);
  assert.deepEqual([...transport.calls[0].options.headers.keys()], ['accept']);
});

test('a missing list endpoint exposes its HTTP status so callers can distinguish it from auth failures', async () => {
  const transport = queued(response({ error: { message: 'not found' } }, { status: 404 }));
  await assert.rejects(discover(identify('https://api.kimi.com/coding/v1'), { apiKey: KEY, fetchImpl: transport.fetchImpl }), (error) => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 404);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  const unauthorized = queued(response({ error: { message: 'unauthorized' } }, { status: 401 }));
  await assert.rejects(discover(identify('https://api.kimi.com/coding/v1'), { apiKey: KEY, fetchImpl: unauthorized.fetchImpl }), (error) => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 401);
    return true;
  });
});
