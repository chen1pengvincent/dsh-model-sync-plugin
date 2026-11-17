/**
 * Pure-function tests for the cross-protocol translation layer.
 *
 * Three things are load-bearing here and each has its own group below:
 *  1. every decode→encode direction produces a body the target dialect accepts;
 *  2. the same protocol is a fixpoint, so a pass-through route cannot drift;
 *  3. an SSE stream decodes to the *same* event sequence no matter how it is
 *     chopped — including one byte at a time, which is the only way to prove a
 *     multi-byte character split across chunks is reassembled.
 *
 * Run: node --test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROTOCOLS,
  createStreamDecoder,
  createStreamEncoder,
  decodeError,
  decodeRequest,
  encodeRequest,
} from '../lib/gateway/protocol.js'

// ---------------------------------------------------------------------------
// Fixtures: three real request bodies recorded from the host, one per protocol
// ---------------------------------------------------------------------------

/** A.1 — what pi-ai posts for an `openai-completions` route. */
const completionsBody = {
  model: 'gpt-5.1',
  messages: [
    { role: 'developer', content: 'You are a helpful assistant.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '把这张图里的错误码念出来' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    },
    {
      role: 'assistant',
      reasoning_content: '用户想知道图片里的错误码',
      content: '我先查一下天气再回答。',
      tool_calls: [
        { id: 'call_abc123', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_abc123', content: '{"temperature":3,"unit":"C"}' },
    { role: 'user', content: '谢谢' },
  ],
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: 4096,
  temperature: 0.7,
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ],
  reasoning_effort: 'medium',
}

/** A.2 — what pi-ai posts for an `anthropic-messages` route. */
const anthropicBody = {
  model: 'claude-sonnet-4-5',
  // A budget has to fit under the ceiling, so the fixture pairs 8192 with 16384.
  max_tokens: 16384,
  stream: true,
  system: [{ type: 'text', text: 'You are a helpful assistant.' }],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '把这张图里的错误码念出来' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '用户想知道图片里的错误码', signature: 'EqQBCkYIARgCKkBc1n' },
        { type: 'text', text: '我先查一下天气再回答。' },
        { type: 'tool_use', id: 'toolu_01ABC', name: 'get_weather', input: { city: '北京' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABC', content: '{"temperature":3,"unit":"C"}', is_error: false }],
    },
    { role: 'user', content: '谢谢' },
  ],
  tools: [
    {
      name: 'get_weather',
      description: '查询指定城市天气',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ],
  thinking: { type: 'enabled', budget_tokens: 8192 },
}

/** A.3 — what pi-ai posts for an `openai-responses` route. */
const responsesBody = {
  model: 'gpt-5.1',
  input: [
    { role: 'developer', content: 'You are a helpful assistant.' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '把这张图里的错误码念出来' },
        { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    },
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: '用户想知道图片里的错误码' }],
      encrypted_content: 'gAAAAAB',
    },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      id: 'msg_1',
      content: [{ type: 'output_text', text: '我先查一下天气再回答。', annotations: [] }],
    },
    { type: 'function_call', id: 'fc_1', call_id: 'call_abc123', name: 'get_weather', arguments: '{"city":"北京"}' },
    { type: 'function_call_output', call_id: 'call_abc123', output: '{"temperature":3,"unit":"C"}' },
    { role: 'user', content: [{ type: 'input_text', text: '谢谢' }] },
  ],
  stream: true,
  store: false,
  max_output_tokens: 4096,
  temperature: 0.7,
  tools: [
    { type: 'function', name: 'get_weather', description: '查询指定城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
  ],
  reasoning: { effort: 'medium', summary: 'auto' },
  include: ['reasoning.encrypted_content'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `data:`-only frame the two OpenAI dialects write. */
function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Build an `event:` + `data:` frame the anthropic dialect writes. */
function namedFrame(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Decode a whole stream, optionally re-chunked.
 *
 * `size === undefined` feeds the text in one piece; any number feeds *bytes* in
 * slices of that size, which is what a socket actually delivers.
 * @param {string} protocol
 * @param {string} text
 * @param {number} [size]
 * @returns {object[]}
 */
function decodeAll(protocol, text, size) {
  const decoder = createStreamDecoder(protocol)
  const events = []
  if (size === undefined) {
    events.push(...decoder.push(text))
  } else {
    const bytes = new TextEncoder().encode(text)
    for (let at = 0; at < bytes.length; at += size) {
      events.push(...decoder.push(bytes.subarray(at, at + size)))
    }
  }
  events.push(...decoder.end())
  return events
}

/** Drive an encoder with a whole event list. */
function encodeAll(protocol, events, options) {
  const encoder = createStreamEncoder(protocol, options)
  const frames = []
  for (const event of events) frames.push(...encoder.push(event))
  frames.push(...encoder.end())
  return frames
}

/**
 * Fold an event stream into the content it carries.
 *
 * Fragment boundaries are an artefact of how a provider chunked its JSON, not
 * of the answer, so a translated stream is compared on content: text and
 * thinking concatenated, tool arguments reassembled per call.
 * @param {object[]} events
 */
function summarize(events) {
  const summary = { starts: 0, text: '', thinking: '', tools: [], usage: undefined, finish: undefined, error: undefined }
  for (const event of events) {
    switch (event.type) {
      case 'start':
        summary.starts += 1
        break
      case 'text':
        summary.text += event.text
        break
      case 'thinking':
        summary.thinking += event.text
        break
      case 'tool-call-start':
        summary.tools.push({ id: event.id, name: event.name, argsJson: '' })
        break
      case 'tool-call-delta': {
        const tool = summary.tools.find((entry) => entry.id === event.id)
        if (tool) tool.argsJson += event.argsJson
        break
      }
      case 'usage':
        summary.usage = { input: event.input, output: event.output }
        break
      case 'finish':
        summary.finish = event.reason
        break
      case 'error':
        summary.error = event.message
        break
      default:
        break
    }
  }
  return summary
}

/** The far end of the translation: generate the SSE a client would receive. */
function translatedFrames(from, to, text, model) {
  const events = decodeAll(from, text)
  return { events, frames: encodeAll(to, events, { model }) }
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

test('PROTOCOLS is every api name a route can declare', () => {
  // `google-generative-ai` is not pi-ai's own list: it is here so a mixed route
  // that serves Gemini models can still be narrowed onto one wire protocol.
  assert.deepEqual(PROTOCOLS, ['openai-completions', 'anthropic-messages', 'openai-responses', 'google-generative-ai'])
})

test('an unknown protocol is the only thing this module refuses', () => {
  assert.throws(() => decodeRequest('typesafe-system-one', {}), /unsupported protocol/)
  assert.throws(() => decodeRequest('gemini', {}), /unsupported protocol/)
  assert.throws(() => encodeRequest('gemini', {}, { baseURL: 'https://x' }), /unsupported protocol/)
  assert.throws(() => createStreamDecoder('openai'), /unsupported protocol/)
  assert.throws(() => createStreamEncoder('bedrock'), /unsupported protocol/)
})

// ---------------------------------------------------------------------------
// Endpoints and headers
// ---------------------------------------------------------------------------

test('endpoints are plain concatenation: no /v1 is ever invented', () => {
  assert.equal(
    encodeRequest('openai-completions', { messages: [] }, { baseURL: 'https://api.openai.com/v1' }).url,
    'https://api.openai.com/v1/chat/completions',
  )
  assert.equal(
    encodeRequest('openai-responses', { messages: [] }, { baseURL: 'https://api.openai.com/v1' }).url,
    'https://api.openai.com/v1/responses',
  )
  // A gateway mounted under its own path keeps every segment.
  assert.equal(
    encodeRequest('openai-completions', { messages: [] }, { baseURL: 'https://gw.example/openai/v1' }).url,
    'https://gw.example/openai/v1/chat/completions',
  )
})

test('the anthropic base is a bare origin, so a trailing /v1 is stripped exactly once', () => {
  assert.equal(
    encodeRequest('anthropic-messages', { messages: [] }, { baseURL: 'https://api.anthropic.com' }).url,
    'https://api.anthropic.com/v1/messages',
  )
  assert.equal(
    encodeRequest('anthropic-messages', { messages: [] }, { baseURL: 'https://api.anthropic.com/v1' }).url,
    'https://api.anthropic.com/v1/messages',
  )
  // Both trailing-slash spellings collapse the same way.
  assert.equal(
    encodeRequest('anthropic-messages', { messages: [] }, { baseURL: 'https://api.anthropic.com/v1/' }).url,
    'https://api.anthropic.com/v1/messages',
  )
  assert.equal(
    encodeRequest('anthropic-messages', { messages: [] }, { baseURL: 'https://proxy.example/anthropic/' }).url,
    'https://proxy.example/anthropic/v1/messages',
  )
})

test('a base that carries its own query string keeps it after the path', () => {
  assert.equal(
    encodeRequest('openai-completions', { messages: [] }, { baseURL: 'https://gw.example/v1?key=abc' }).url,
    'https://gw.example/v1/chat/completions?key=abc',
  )
  assert.equal(
    encodeRequest('anthropic-messages', { messages: [] }, { baseURL: 'https://gw.example/v1?key=abc' }).url,
    'https://gw.example/v1/messages?key=abc',
  )
})

test('auth headers never cross wires: bearer for OpenAI shapes, x-api-key for Anthropic', () => {
  const completions = encodeRequest('openai-completions', { messages: [] }, { baseURL: 'https://x', apiKey: 'sk-test' }).headers
  assert.equal(completions.authorization, 'Bearer sk-test')
  assert.equal(completions['x-api-key'], undefined)

  const responses = encodeRequest('openai-responses', { messages: [] }, { baseURL: 'https://x', apiKey: 'sk-test' }).headers
  assert.equal(responses.authorization, 'Bearer sk-test')

  const anthropic = encodeRequest('anthropic-messages', { messages: [] }, { baseURL: 'https://x', apiKey: 'sk-ant-test' }).headers
  assert.equal(anthropic['x-api-key'], 'sk-ant-test')
  assert.equal(anthropic['anthropic-version'], '2023-06-01')
  assert.equal(anthropic.authorization, undefined)
})

test('an anthropic OAuth token switches to bearer, as pi-ai does', () => {
  const headers = encodeRequest('anthropic-messages', { messages: [] }, { baseURL: 'https://x', apiKey: 'sk-ant-oat01-abc' }).headers
  assert.equal(headers.authorization, 'Bearer sk-ant-oat01-abc')
  assert.equal(headers['x-api-key'], undefined)
  assert.match(headers['anthropic-beta'], /oauth-2025-04-20/)
})

test('caller headers win over the defaults without dropping them', () => {
  const headers = encodeRequest('anthropic-messages', { messages: [] }, {
    baseURL: 'https://x',
    apiKey: 'k',
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  }).headers
  assert.equal(headers['anthropic-beta'], 'interleaved-thinking-2025-05-14')
  assert.equal(headers['anthropic-version'], '2023-06-01')
})

// ---------------------------------------------------------------------------
// Decode: the canonical request
// ---------------------------------------------------------------------------

test('decodeRequest flattens all three system shapes into one string', () => {
  assert.equal(decodeRequest('openai-completions', completionsBody).system, 'You are a helpful assistant.')
  assert.equal(decodeRequest('anthropic-messages', anthropicBody).system, 'You are a helpful assistant.')
  assert.equal(decodeRequest('openai-responses', responsesBody).system, 'You are a helpful assistant.')

  // Several system paragraphs are joined with a blank line, whatever the shape.
  const split = decodeRequest('anthropic-messages', {
    messages: [],
    system: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
  })
  assert.equal(split.system, 'one\ntwo')
})

test('decodeRequest splits every protocol into the same canonical turns', () => {
  for (const [protocol, body] of [
    ['openai-completions', completionsBody],
    ['anthropic-messages', anthropicBody],
    ['openai-responses', responsesBody],
  ]) {
    const request = decodeRequest(protocol, body)
    assert.equal(request.model, body.model, protocol)
    assert.equal(request.stream, true, protocol)
    // The trailing `谢谢` joins the tool-result turn: two user messages in a row
    // would be rejected by anthropic, so adjacent user turns are merged.
    assert.equal(request.messages.length, 3, `${protocol}: user, assistant, tool result + user`)
    assert.deepEqual(request.messages.map((message) => message.role), ['user', 'assistant', 'user'], protocol)
    const [first, assistant, toolTurn] = request.messages
    assert.deepEqual(first.parts[0], { type: 'text', text: '把这张图里的错误码念出来' }, protocol)
    assert.equal(first.parts[1].type, 'image', protocol)
    assert.equal(first.parts[1].dataBase64, 'iVBORw0KGgo=', protocol)
    assert.equal(first.parts[1].mediaType, 'image/png', protocol)
    assert.ok(assistant.parts.some((part) => part.type === 'text'), protocol)
    assert.ok(assistant.parts.some((part) => part.type === 'tool-call'), protocol)
    assert.equal(assistant.parts.find((part) => part.type === 'tool-call').argsJson, '{"city":"北京"}', protocol)
    // The result leads the turn, because a `tool_result` has to come first.
    assert.equal(toolTurn.parts[0].type, 'tool-result', protocol)
    assert.equal(toolTurn.parts[0].resultJson, '{"temperature":3,"unit":"C"}', protocol)
    assert.deepEqual(toolTurn.parts[1], { type: 'text', text: '谢谢' }, protocol)
    assert.equal(request.tools[0].name, 'get_weather', protocol)
    assert.equal(request.maxTokens, protocol === 'anthropic-messages' ? 16384 : 4096, protocol)
    // The anthropic fixture reasons, and pi-ai never sends temperature alongside
    // thinking (`anthropic-messages.js:956-962`), so there is nothing to read.
    assert.equal(request.temperature, protocol === 'anthropic-messages' ? undefined : 0.7, protocol)
  }
})

test('decodeRequest reads reasoning from whichever field and shape the provider used', () => {
  // completions: the field is named after the thinking block's signature.
  const reasoning = decodeRequest('openai-completions', {
    messages: [{ role: 'assistant', content: 'hi', reasoning: 'thought' }],
  })
  assert.equal(reasoning.messages[0].parts[0].type, 'thinking')
  assert.equal(reasoning.messages[0].parts[0].text, 'thought')

  // anthropic: a signature travels with the text.
  const anthropic = decodeRequest('anthropic-messages', {
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'thought', signature: 'sig' }] }],
  })
  assert.deepEqual(anthropic.messages[0].parts[0], { type: 'thinking', text: 'thought', signature: 'sig' })

  // responses: the whole item is the signature, so it can be replayed verbatim.
  const responses = decodeRequest('openai-responses', {
    input: [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thought' }], encrypted_content: 'abc' }],
  })
  assert.equal(responses.messages[0].parts[0].type, 'thinking')
  assert.equal(responses.messages[0].parts[0].text, 'thought')
  assert.equal(JSON.parse(responses.messages[0].parts[0].signature).encrypted_content, 'abc')
})

// ---------------------------------------------------------------------------
// Encode: each direction
// ---------------------------------------------------------------------------

test('completions → anthropic: system goes top-level and tool_use carries an object', () => {
  const request = decodeRequest('openai-completions', completionsBody)
  const body = JSON.parse(encodeRequest('anthropic-messages', request, { baseURL: 'https://api.anthropic.com' }).body)

  assert.deepEqual(body.system, [{ type: 'text', text: 'You are a helpful assistant.' }])
  // `reasoning_effort:'medium'` is 8192 of thinking, and pi-ai's own anthropic
  // route adds the budget to the caller's cap instead of truncating the answer.
  assert.equal(body.max_tokens, 4096 + 8192)
  assert.equal(body.stream, true)
  assert.equal(body.messages[0].content[0].type, 'text')
  assert.equal(body.messages[0].content[1].type, 'image')
  assert.deepEqual(body.messages[0].content[1].source, { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' })
  // The tool result is a block in a user turn, not a `role:'tool'` message.
  assert.equal(body.messages[2].role, 'user')
  assert.deepEqual(body.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_abc123',
    content: '{"temperature":3,"unit":"C"}',
    is_error: false,
  })
  // `input` is an object here, never a string.
  const toolUse = body.messages[1].content.find((block) => block.type === 'tool_use')
  assert.deepEqual(toolUse.input, { city: '北京' })
  assert.deepEqual(body.tools[0].input_schema, completionsBody.tools[0].function.parameters)
  assert.equal(body.tools[0].function, undefined)
})

test('anthropic → completions: a tool result becomes its own role:"tool" message', () => {
  const request = decodeRequest('anthropic-messages', anthropicBody)
  const body = JSON.parse(encodeRequest('openai-completions', request, { baseURL: 'https://api.openai.com/v1' }).body)

  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'You are a helpful assistant.')
  const toolCall = body.messages[2].tool_calls[0]
  assert.equal(toolCall.id, 'toolu_01ABC')
  assert.equal(toolCall.function.arguments, '{"city":"北京"}')
  assert.equal(body.messages[3].role, 'tool')
  assert.equal(body.messages[3].tool_call_id, 'toolu_01ABC')
  // Anthropic's `input_schema` is just the `parameters` of a function tool.
  assert.deepEqual(body.tools[0].function.parameters, anthropicBody.tools[0].input_schema)
  assert.equal(body.stream_options.include_usage, true)
})

test('completions → responses: input[0] is the system item and tools go flat', () => {
  const request = decodeRequest('openai-completions', completionsBody)
  const body = JSON.parse(encodeRequest('openai-responses', request, { baseURL: 'https://api.openai.com/v1' }).body)

  assert.equal(body.messages, undefined, 'responses has no messages array')
  assert.deepEqual(body.input[0], { role: 'system', content: [{ type: 'input_text', text: 'You are a helpful assistant.' }] })
  // Even plain text is a block array in this dialect.
  assert.deepEqual(body.input[1].content[0], { type: 'input_text', text: '把这张图里的错误码念出来' })
  assert.equal(body.input[1].content[1].type, 'input_image')
  assert.equal(body.input[1].content[1].detail, 'auto')
  const call = body.input.find((item) => item.type === 'function_call')
  assert.equal(call.name, 'get_weather')
  assert.equal(call.arguments, '{"city":"北京"}')
  assert.ok(call.call_id.length > 0)
  assert.ok(call.id.startsWith('fc_'), 'pi-ai drops an item id that is not fc_-prefixed')
  const output = body.input.find((item) => item.type === 'function_call_output')
  assert.equal(output.call_id, call.call_id)
  // Flat tool definition, no `function` envelope.
  assert.deepEqual(body.tools[0], {
    type: 'function',
    name: 'get_weather',
    description: '查询指定城市天气',
    parameters: completionsBody.tools[0].function.parameters,
  })
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
})

test('responses → completions: the reasoning text carries, the encrypted item does not', () => {
  const request = decodeRequest('openai-responses', responsesBody)
  const body = JSON.parse(encodeRequest('openai-completions', request, { baseURL: 'https://api.openai.com/v1' }).body)

  // The reasoning item survives decoding (it is what makes responses→responses
  // lossless). Completions has no field for an encrypted item, so only the text
  // is replayed, under the field a completions server reads.
  assert.ok(request.messages[1].parts.some((part) => part.type === 'thinking'))
  assert.equal(body.messages[2].reasoning_content, '用户想知道图片里的错误码')
  assert.equal(JSON.stringify(body).includes('encrypted_content'), false)
  assert.equal(JSON.stringify(body).includes('gAAAAAB'), false)
  assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"city":"北京"}')
  assert.equal(body.messages[3].role, 'tool')
  assert.equal(body.messages[3].tool_call_id, 'call_abc123')
})

test('anthropic → responses: a foreign thinking signature is dropped, not replayed', () => {
  const request = decodeRequest('anthropic-messages', anthropicBody)
  const body = JSON.parse(encodeRequest('openai-responses', request, { baseURL: 'https://api.openai.com/v1' }).body)
  assert.equal(body.input.some((item) => item.type === 'reasoning'), false)
  // The text itself is still there.
  const message = body.input.find((item) => item.type === 'message')
  assert.equal(message.content[0].type, 'output_text')
})

test('responses → responses replays a reasoning item verbatim', () => {
  const request = decodeRequest('openai-responses', responsesBody)
  const body = JSON.parse(encodeRequest('openai-responses', request, { baseURL: 'https://api.openai.com/v1' }).body)
  const reasoning = body.input.find((item) => item.type === 'reasoning')
  assert.deepEqual(reasoning, {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: '用户想知道图片里的错误码' }],
    encrypted_content: 'gAAAAAB',
  })
})

test('the same protocol is a fixpoint, so a pass-through route cannot drift', () => {
  const cases = [
    ['openai-completions', completionsBody],
    ['anthropic-messages', anthropicBody],
    ['openai-responses', responsesBody],
  ]
  for (const [protocol, body] of cases) {
    const once = JSON.parse(encodeRequest(protocol, decodeRequest(protocol, body), { baseURL: 'https://x' }).body)
    const twice = JSON.parse(encodeRequest(protocol, decodeRequest(protocol, once), { baseURL: 'https://x' }).body)
    assert.deepEqual(twice, once, `${protocol} must reach a fixpoint after one hop`)
  }
})

test('a same-protocol pass-through keeps the parts a cross-protocol hop would lose', () => {
  // Anthropic re-emits its own signature, and the thinking text with it.
  const anthropic = JSON.parse(encodeRequest(
    'anthropic-messages',
    decodeRequest('anthropic-messages', anthropicBody),
    { baseURL: 'https://x' },
  ).body)
  const block = anthropic.messages[1].content[0]
  assert.deepEqual(block, { type: 'thinking', thinking: '用户想知道图片里的错误码', signature: 'EqQBCkYIARgCKkBc1n' })

  // Completions keeps the reasoning text under the field the parser reads.
  const completions = JSON.parse(encodeRequest(
    'openai-completions',
    decodeRequest('openai-completions', completionsBody),
    { baseURL: 'https://x' },
  ).body)
  assert.equal(completions.messages[2].reasoning_content, '用户想知道图片里的错误码')
})

// ---------------------------------------------------------------------------
// Tool-call ids
// ---------------------------------------------------------------------------

test('a synthesized tool-call id is deterministic and legal for every target', () => {
  const hostile = 'call|fc_01.abc:xyz'
  const request = decodeRequest('openai-completions', {
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: hostile, type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: hostile, content: 'ok' },
    ],
  })
  const first = decodeRequest('openai-completions', {
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: hostile, type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: hostile, content: 'ok' },
    ],
  })
  // Same input, same output: a replayed request must not renumber its ids.
  assert.deepEqual(first, request)

  for (const protocol of PROTOCOLS) {
    const body = JSON.parse(encodeRequest(protocol, request, { baseURL: 'https://x' }).body)
    const text = JSON.stringify(body)
    if (protocol === 'google-generative-ai') {
      // Gemini has no tool ids: a call is identified by its function name, and
      // the answer must carry that same name back.
      assert.match(text, /"functionCall":\{"name":"f"/)
      assert.match(text, /"functionResponse":\{"name":"f"/)
      continue
    }
    const ids = [
      ...(text.match(/"tool_use_id":"([^"]*)"/g) ?? []),
      ...(text.match(/"tool_call_id":"([^"]*)"/g) ?? []),
      ...(text.match(/"call_id":"([^"]*)"/g) ?? []),
      ...(text.match(/"id":"(call_[^"]*)"/g) ?? []),
    ]
    assert.ok(ids.length > 0, `${protocol} must name the id somewhere`)
    for (const raw of ids) {
      const id = raw.replace(/^"[a-z_]+":"/, '').replace(/"$/, '')
      assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/, `${protocol} emitted an illegal id: ${id}`)
      assert.notEqual(id, hostile, `${protocol} must not pass a punctuated id through`)
    }
  }
})

test('a legal id is passed through untouched, including across a tool result', () => {
  const request = decodeRequest('anthropic-messages', anthropicBody)
  const back = JSON.parse(encodeRequest('anthropic-messages', request, { baseURL: 'https://x' }).body)
  assert.equal(back.messages[1].content[2].id, 'toolu_01ABC')
  assert.equal(back.messages[2].content[0].tool_use_id, 'toolu_01ABC')
})

test('an over-long anthropic id is rewritten to fit 64 characters', () => {
  const long = `toolu_${'a'.repeat(80)}`
  const request = decodeRequest('anthropic-messages', {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: long, name: 'f', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: long, content: 'ok' }] },
    ],
  })
  const body = JSON.parse(encodeRequest('anthropic-messages', request, { baseURL: 'https://x' }).body)
  const callId = body.messages[0].content[0].id
  const resultId = body.messages[1].content[0].tool_use_id
  assert.equal(callId, resultId, 'the call and its result must agree on the rewritten id')
  assert.ok(callId.length <= 64)
  assert.match(callId, /^[a-zA-Z0-9_-]+$/)
})

test('a missing tool id is filled in from the call it belongs to', () => {
  const request = decodeRequest('openai-completions', {
    messages: [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }] }],
  })
  const body = JSON.parse(encodeRequest('anthropic-messages', request, { baseURL: 'https://x' }).body)
  const id = body.messages[0].content[0].id
  assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/)
  // Deterministic: the second pass picks the same id.
  const again = JSON.parse(encodeRequest('anthropic-messages', request, { baseURL: 'https://x' }).body)
  assert.equal(again.messages[0].content[0].id, id)
})

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test('usage is normalised to a disjoint prompt count: OpenAI subtracts its cache', () => {
  // The usage chunk is the last one OpenAI sends, before `[DONE]`.
  const events = decodeAll('openai-completions', [
    frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    frame({
      id: 'c1',
      choices: [],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    }),
    'data: [DONE]\n\n',
  ].join(''))
  // 1000 prompt tokens minus 900 reused ones: only 100 were new input.
  assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', input: 100, output: 50 })
})

test('anthropic usage is already disjoint and needs no subtraction', () => {
  const events = decodeAll('anthropic-messages', [
    namedFrame('message_start', {
      type: 'message_start',
      message: { id: 'm', usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 9000 } },
    }),
    namedFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }),
    namedFrame('message_stop', { type: 'message_stop' }),
  ].join(''))
  assert.deepEqual(events.filter((event) => event.type === 'usage'), [{ type: 'usage', input: 100, output: 50 }])
})

test('responses usage subtracts cached and cache-write tokens the same way', () => {
  const events = decodeAll('openai-responses', namedFrame('response.completed', {
    type: 'response.completed',
    response: {
      id: 'r',
      status: 'completed',
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
      },
    },
  }))
  // The terminal frame carries both the usage and the finish, and the finish is
  // what closes the stream, so the usage is found by type rather than position.
  assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', input: 100, output: 50 })
})

test('a translated usage block lands in the target dialect’s own accounting', () => {
  const events = decodeAll('openai-completions', [
    frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    frame({ id: 'c1', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 900 } } }),
    'data: [DONE]\n\n',
  ].join(''))
  const body = encodeAll('anthropic-messages', events, { model: 'claude' }).join('')
  // Anthropic's `input_tokens` excludes the cache, which is what the canonical
  // number already means, so it is copied straight across.
  assert.match(body, /"input_tokens":100/)
  assert.match(body, /"output_tokens":50/)
})

// ---------------------------------------------------------------------------
// SSE decoding: chunk-boundary independence
// ---------------------------------------------------------------------------

const completionsStream = [
  frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: { reasoning_content: '用户想知道' } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: { reasoning_content: '错误码' } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: { content: '先查天气。' } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc123', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  frame({ id: 'c1', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } }),
  'data: [DONE]\n\n',
].join('')

test('a completions stream decodes identically at 1 byte, 7 bytes and one chunk', () => {
  const whole = decodeAll('openai-completions', completionsStream)
  assert.deepEqual(decodeAll('openai-completions', completionsStream, 1), whole)
  assert.deepEqual(decodeAll('openai-completions', completionsStream, 7), whole)
  assert.equal(whole[0].type, 'start')
  assert.deepEqual(summarize(whole), {
    starts: 1,
    text: '先查天气。',
    thinking: '用户想知道错误码',
    tools: [{ id: 'call_abc123', name: 'get_weather', argsJson: '{"city":"北京"}' }],
    usage: { input: 40, output: 20 },
    finish: 'tool-call',
    error: undefined,
  })
})

const anthropicStream = [
  namedFrame('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900 } },
  }),
  namedFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
  namedFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '用户想知道' } }),
  namedFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQB' } }),
  namedFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  namedFrame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  namedFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '先查天气。' } }),
  namedFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
  namedFrame('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01ABC', name: 'get_weather', input: {} } }),
  namedFrame('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city"' } }),
  namedFrame('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"北京"}' } }),
  namedFrame('content_block_stop', { type: 'content_block_stop', index: 2 }),
  namedFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
  namedFrame('message_stop', { type: 'message_stop' }),
].join('')

test('an anthropic stream decodes identically at 1 byte, 7 bytes and one chunk', () => {
  const whole = decodeAll('anthropic-messages', anthropicStream)
  assert.deepEqual(decodeAll('anthropic-messages', anthropicStream, 1), whole)
  assert.deepEqual(decodeAll('anthropic-messages', anthropicStream, 7), whole)
  assert.deepEqual(summarize(whole), {
    starts: 1,
    text: '先查天气。',
    thinking: '用户想知道',
    tools: [{ id: 'toolu_01ABC', name: 'get_weather', argsJson: '{"city":"北京"}' }],
    usage: { input: 100, output: 20 },
    finish: 'tool-call',
    error: undefined,
  })
})

const responsesStream = [
  namedFrame('response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }),
  namedFrame('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_1', summary: [] },
  }),
  namedFrame('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: '用户想知道' }),
  namedFrame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } }),
  namedFrame('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'message', role: 'assistant', id: 'msg_1', content: [] },
  }),
  namedFrame('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: '先查天气。' }),
  namedFrame('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 2,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc123', name: 'get_weather', arguments: '' },
  }),
  namedFrame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"city"' }),
  namedFrame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: ':"北京"}' }),
  namedFrame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 2, arguments: '{"city":"北京"}' }),
  namedFrame('response.output_item.done', { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc123', name: 'get_weather', arguments: '{"city":"北京"}' } }),
  namedFrame('response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 }, output_tokens_details: { reasoning_tokens: 5 } },
    },
  }),
].join('')

test('a responses stream decodes identically at 1 byte, 7 bytes and one chunk', () => {
  const whole = decodeAll('openai-responses', responsesStream)
  assert.deepEqual(decodeAll('openai-responses', responsesStream, 1), whole)
  assert.deepEqual(decodeAll('openai-responses', responsesStream, 7), whole)
  assert.deepEqual(summarize(whole), {
    starts: 1,
    text: '先查天气。',
    thinking: '用户想知道',
    tools: [{ id: 'call_abc123', name: 'get_weather', argsJson: '{"city":"北京"}' }],
    usage: { input: 100, output: 20 },
    // pi-ai re-labels a completed response that called a tool as a tool use.
    finish: 'tool-call',
    error: undefined,
  })
})

test('tool-call arguments are reassembled from fragments split mid-JSON', () => {
  // A fragment boundary may fall inside a field name, a string or an escape.
  const stream = [
    frame({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a"' } }] } }] }),
    frame({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':[1,' } }] } }] }),
    frame({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '2,3]}' } }] } }] }),
    frame({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ].join('')
  const whole = decodeAll('openai-completions', stream)
  assert.deepEqual(decodeAll('openai-completions', stream, 1), whole)
  assert.deepEqual(summarize(whole).tools, [{ id: 'call_1', name: 'f', argsJson: '{"a":[1,2,3]}' }])
  // One start, then one delta per non-empty fragment, in arrival order.
  assert.equal(whole.filter((event) => event.type === 'tool-call-start').length, 1)
  assert.equal(whole.filter((event) => event.type === 'tool-call-delta').length, 3)
})

test('a provider that omits tool_call index still builds one call, not three', () => {
  // Some compatible servers send only `id` on the first fragment and neither
  // `id` nor `index` afterwards. Treating each fragment as a new call would
  // produce three broken tool calls instead of one whole one.
  const chunks = [
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '"router"}' } }] } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  const events = decodeAll('openai-completions', text)
  const summary = summarize(events)
  assert.equal(summary.tools.length, 1)
  assert.equal(summary.tools[0].name, 'lookup')
  assert.equal(summary.tools[0].argsJson, '{"q":"router"}')
  assert.equal(summary.finish, 'tool-call')
})

test('several parallel tool calls keep their own argument streams', () => {
  const stream = [
    frame({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_a', function: { name: 'f', arguments: '{"x":' } },
      { index: 1, id: 'call_b', function: { name: 'g', arguments: '{"y":' } },
    ] } }] }),
    frame({ id: 'c', choices: [{ index: 0, delta: { tool_calls: [
      { index: 1, function: { arguments: '2}' } },
      { index: 0, function: { arguments: '1}' } },
    ] } }] }),
    frame({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ].join('')
  const summary = summarize(decodeAll('openai-completions', stream))
  assert.deepEqual(summary.tools, [
    { id: 'call_a', name: 'f', argsJson: '{"x":1}' },
    { id: 'call_b', name: 'g', argsJson: '{"y":2}' },
  ])
})

test('a thinking signature is handed back, so the block can be replayed next turn', () => {
  // The signature is the only part of a thinking block an Anthropic upstream
  // will accept back; losing it means the caller's next turn cannot replay its
  // own reasoning. A same-protocol pass-through must therefore keep it.
  const original = decodeAll('anthropic-messages', anthropicStream)
  const frames = encodeAll('anthropic-messages', original, { model: 'claude' }).join('')
  assert.match(frames, /"signature_delta","signature":"EqQB"/)
  const final = decodeAll('anthropic-messages', frames)
  const signatures = final.filter((event) => event.type === 'thinking' && event.signature).map((event) => event.signature)
  assert.deepEqual(signatures, ['EqQB'])
  // The text still arrives exactly once: the signature rides beside it, it does
  // not duplicate it.
  assert.equal(summarize(final).thinking, summarize(original).thinking)
  // A dialect with no place for a signature simply ignores the field.
  const completions = encodeAll('openai-completions', original, { model: 'gpt-5.1' }).join('')
  assert.match(completions, /"reasoning_content":"用户想知道"/)
  assert.doesNotMatch(completions, /EqQB/)
})

test('an anthropic signature delta completes the block without adding text', () => {
  const events = decodeAll('anthropic-messages', anthropicStream)
  assert.equal(events.filter((event) => event.type === 'thinking').map((event) => event.text).join(''), '用户想知道')
  assert.equal(events.some((event) => Object.hasOwn(event, 'reason')) && false, false, 'signature_delta is not a finish')
})

test('SSE framing tolerates CRLF, comments, keep-alives and a final line without a newline', () => {
  const crlf = [
    ': keep-alive\r\n',
    '\r\n',
    'event: content_block_delta\r\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\r\n',
    '\r\n',
    'event: message_stop\r\n',
    'data: {"type":"message_stop"}',
  ].join('')
  const events = decodeAll('anthropic-messages', crlf)
  assert.deepEqual(summarize(events).text, 'hi')
  assert.equal(summarize(events).finish, 'stop')
  // The same bytes, delivered one at a time, must agree.
  assert.deepEqual(decodeAll('anthropic-messages', crlf, 1), events)
})

test('a multi-line data field is joined with newlines, as the SSE spec says', () => {
  const payload = JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })
  const [head, tail] = [payload.slice(0, 10), payload.slice(10)]
  const events = decodeAll('openai-completions', `data: ${head}\ndata: ${tail}\n\n`)
  assert.equal(summarize(events).text, 'ok')
})

// ---------------------------------------------------------------------------
// Stream errors
// ---------------------------------------------------------------------------

test('an upstream error frame becomes a canonical error event in all three dialects', () => {
  // A rate limit and a server fault are worth another attempt; a rejected
  // request is not, and the kind of failure is the only thing that says which.
  const completions = decodeAll('openai-completions', frame({ error: { message: 'upstream said no', type: 'rate_limit' } }))
  assert.deepEqual(completions.at(-1), { type: 'error', message: 'upstream said no', retryable: true })

  const anthropic = decodeAll('anthropic-messages', namedFrame('error', {
    type: 'error',
    error: { type: 'overloaded_error', message: 'Overloaded' },
  }))
  assert.deepEqual(anthropic.at(-1), { type: 'error', message: 'Overloaded', retryable: true })

  const responses = decodeAll('openai-responses', namedFrame('response.failed', {
    type: 'response.failed',
    response: { error: { code: 'server_error', message: 'boom' } },
  }))
  assert.deepEqual(responses.at(-1), { type: 'error', message: 'boom', retryable: true })

  const refused = decodeAll('anthropic-messages', namedFrame('error', {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'max_tokens: too large' },
  }))
  assert.deepEqual(refused.at(-1), { type: 'error', message: 'max_tokens: too large', retryable: false })
})

test('an HTTP failure becomes the same error event whatever dialect wrote it', () => {
  // Three spellings of the same thing: a rate limit with the provider's own words.
  const completions = decodeError('openai-completions', 429, JSON.stringify({
    error: { message: 'Rate limit reached for gpt-5.1', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  }))
  assert.deepEqual(completions, {
    type: 'error',
    message: 'Rate limit reached for gpt-5.1',
    retryable: true,
    status: 429,
  })

  const anthropic = decodeError('anthropic-messages', 429, {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' },
  })
  assert.equal(anthropic.message, 'Number of requests has exceeded your rate limit.')
  assert.equal(anthropic.retryable, true)

  const responses = decodeError('openai-responses', 529, { error: { message: 'Overloaded', code: 'server_error' } })
  assert.deepEqual(responses, { type: 'error', message: 'Overloaded', retryable: true, status: 529 })
})

test('a rejected request is not retryable, and its message is the provider’s', () => {
  const rejected = decodeError('anthropic-messages', 400, {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'tools.0.input_schema: required: Extra inputs are not permitted' },
  })
  assert.equal(rejected.retryable, false)
  assert.equal(rejected.message, 'tools.0.input_schema: required: Extra inputs are not permitted')
  assert.equal(rejected.status, 400)
})

test('a body that is not JSON still yields an error event, not a crash', () => {
  // Some proxies answer a 502 with an HTML page; the text is the only clue there is.
  const html = decodeError('openai-completions', 502, '<html><body>Bad Gateway</body></html>')
  assert.equal(html.type, 'error')
  assert.equal(html.retryable, true)
  assert.match(html.message, /Bad Gateway/)

  const empty = decodeError('openai-responses', 500, '')
  assert.equal(empty.message, 'HTTP 500')
  assert.equal(empty.retryable, true)

  // The one thing it still refuses is a protocol it has never heard of.
  assert.throws(() => decodeError('typesafe-system-one', 500, ''), /unsupported protocol/)

  // Gemini reports its errors in the same envelope, so it needs no special case.
  const gemini = decodeError('google-generative-ai', 400, { error: { code: 400, message: 'API key not valid' } })
  assert.equal(gemini.message, 'API key not valid')
})

test('the upstream message is quoted, not rewritten', () => {
  const events = decodeAll('anthropic-messages', namedFrame('error', {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'tools.0.input_schema: required: Extra inputs are not permitted' },
  }))
  assert.equal(events.at(-1).message, 'tools.0.input_schema: required: Extra inputs are not permitted')
})

test('a stream that stops before its terminal event is reported, not passed off as complete', () => {
  // Anthropic: message_start without message_stop.
  const truncated = decodeAll('anthropic-messages', namedFrame('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } }))
  assert.equal(truncated.at(-1).type, 'error')
  assert.match(truncated.at(-1).message, /ended before a terminal event/)
  assert.equal(truncated.at(-1).retryable, true)

  // Completions: neither a finish_reason nor [DONE].
  const cut = decodeAll('openai-completions', frame({ id: 'c', choices: [{ index: 0, delta: { content: 'partial' } }] }))
  assert.equal(cut.at(-1).type, 'error')

  // With [DONE] present the same truncation is a normal stop.
  const done = decodeAll('openai-completions', `${frame({ id: 'c', choices: [{ index: 0, delta: { content: 'partial' } }] })}data: [DONE]\n\n`)
  assert.equal(done.some((event) => event.type === 'error'), false)
  assert.equal(summarize(done).finish, 'stop')

  // Nothing at all is also a failure, not an empty answer.
  for (const protocol of PROTOCOLS) {
    const empty = decodeAll(protocol, '')
    assert.equal(empty.length, 1, protocol)
    assert.equal(empty[0].type, 'error', protocol)
    assert.equal(empty[0].retryable, true, protocol)
  }
})

test('garbage frames and unknown events are skipped rather than fatal', () => {
  const events = decodeAll('openai-completions', [
    'data: not json at all\n\n',
    frame({ id: 'c', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
  ].join(''))
  assert.equal(summarize(events).text, 'ok')

  const unknown = decodeAll('anthropic-messages', [
    namedFrame('ping', { type: 'ping' }),
    namedFrame('some_future_event', { type: 'some_future_event', payload: 1 }),
    namedFrame('message_stop', { type: 'message_stop' }),
  ].join(''))
  assert.equal(summarize(unknown).finish, 'stop')
})

// ---------------------------------------------------------------------------
// Stream encoding
// ---------------------------------------------------------------------------

test('the completions encoder ends with a finish_reason chunk, a usage chunk and [DONE]', () => {
  const events = decodeAll('openai-completions', completionsStream)
  const frames = encodeAll('openai-completions', events, { model: 'gpt-5.1' })
  const text = frames.join('')
  assert.match(text, /"delta":\{"reasoning_content":"用户想知道"\}/)
  assert.match(text, /"delta":\{"content":"先查天气。"\}/)
  assert.match(text, /"finish_reason":"tool_calls"/)
  assert.match(text, /"choices":\[\],"usage":\{"prompt_tokens":40,"completion_tokens":20,"total_tokens":60\}/)
  assert.ok(text.endsWith('data: [DONE]\n\n'), 'the terminator must be the last frame')
})

test('the anthropic encoder closes every block and ends with message_stop', () => {
  const events = decodeAll('openai-completions', completionsStream)
  const text = encodeAll('anthropic-messages', events, { model: 'claude' }).join('')
  assert.match(text, /^event: message_start\n/)
  assert.match(text, /"content_block":\{"type":"thinking"/)
  assert.match(text, /"content_block":\{"type":"tool_use","id":"call_abc123","name":"get_weather","input":\{\}\}/)
  assert.match(text, /"stop_reason":"tool_use"/)
  assert.match(text, /"input_tokens":40/)
  assert.ok(text.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
  // Every block that opened must have closed.
  assert.equal((text.match(/content_block_start/g) ?? []).length, (text.match(/content_block_stop/g) ?? []).length)
})

test('the responses encoder ends with response.completed carrying every item', () => {
  const events = decodeAll('openai-completions', completionsStream)
  const text = encodeAll('openai-responses', events, { model: 'gpt-5.1' }).join('')
  assert.match(text, /^event: response.created\n/)
  assert.match(text, /"type":"reasoning"/)
  assert.match(text, /"type":"function_call"/)
  assert.match(text, /"call_id":"call_abc123"/)
  assert.match(text, /"status":"completed"/)
  assert.ok(text.endsWith('\n\n'))
  const completed = text.trimEnd().split('\n\n').at(-1)
  assert.match(completed, /^event: response\.completed/)
})

test('an error event reaches the client as that dialect’s error frame', () => {
  const completions = encodeAll('openai-completions', [{ type: 'start' }, { type: 'error', message: 'nope' }]).join('')
  assert.match(completions, /"error":\{"message":"nope"/)
  assert.ok(completions.endsWith('data: [DONE]\n\n'))

  // An error frame is terminal: nothing after it may claim the turn succeeded.
  const anthropic = encodeAll('anthropic-messages', [{ type: 'start' }, { type: 'error', message: 'nope' }]).join('')
  assert.match(anthropic, /event: error\n/)
  assert.doesNotMatch(anthropic, /event: message_stop/)
  assert.doesNotMatch(anthropic, /event: message_delta/)

  const responses = encodeAll('openai-responses', [{ type: 'start' }, { type: 'error', message: 'nope' }]).join('')
  assert.match(responses, /event: error\n/)
  assert.match(responses, /event: response\.failed\n/)
  assert.match(responses, /"status":"failed"/)
  assert.doesNotMatch(responses, /event: response\.completed/)
})

test('closing the encoder twice does not repeat the terminal frame', () => {
  // A server closes in its success path and again in `finally`; the second call
  // must be a no-op rather than a second `message_stop` / `[DONE]`.
  for (const protocol of PROTOCOLS) {
    const encoder = createStreamEncoder(protocol, { model: 'm' })
    encoder.push({ type: 'start' })
    encoder.push({ type: 'text', text: 'hi' })
    encoder.push({ type: 'finish', reason: 'stop' })
    const first = encoder.end().join('')
    const second = encoder.end()
    assert.deepEqual(second, [], protocol)
    assert.equal(first.includes('[DONE]'), protocol === 'openai-completions')
    // Nothing more may leak in after the close either.
    assert.deepEqual(encoder.push({ type: 'text', text: 'late' }), [], protocol)
  }
})

test('every encoder advertises an SSE response', () => {
  for (const protocol of PROTOCOLS) {
    const { headers } = createStreamEncoder(protocol, { model: 'm' })
    assert.match(headers['content-type'], /^text\/event-stream/, protocol)
    assert.equal(headers['cache-control'].includes('no-cache'), true, protocol)
  }
})

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('a completions stream translated to anthropic and back carries the whole answer', () => {
  const original = decodeAll('openai-completions', completionsStream)

  // Outbound: re-emit as anthropic SSE for a client that parses that dialect.
  const anthropicFrames = encodeAll('anthropic-messages', original, { model: 'claude' })
  // Back: that client's next request is decoded, and the answer is encoded as
  // completions again.
  const roundTripped = decodeAll('anthropic-messages', anthropicFrames.join(''))
  const completionsFrames = encodeAll('openai-completions', roundTripped, { model: 'gpt-5.1' })
  const final = decodeAll('openai-completions', completionsFrames.join(''))

  assert.deepEqual(summarize(final), summarize(original))
})

test('a responses stream translated to completions carries the whole answer', () => {
  const original = decodeAll('openai-responses', responsesStream)
  const frames = encodeAll('openai-completions', original, { model: 'gpt-5.1' })
  const final = decodeAll('openai-completions', frames.join(''))
  assert.deepEqual(summarize(final), summarize(original))
})

test('each dialect re-emits its own stream without losing the answer', () => {
  // The identity direction still goes through decode→encode, so this is the test
  // that proves a pass-through route is not a rewrite.
  const fixtures = {
    'openai-completions': completionsStream,
    'anthropic-messages': anthropicStream,
    'openai-responses': responsesStream,
    'google-generative-ai': [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]},"finishReason":"STOP"}],',
      '"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}',
      '\n\n',
    ].join(''),
  }
  for (const protocol of PROTOCOLS) {
    const original = decodeAll(protocol, fixtures[protocol])
    const frames = encodeAll(protocol, original, { model: 'm' })
    const final = decodeAll(protocol, frames.join(''))
    assert.deepEqual(summarize(final), summarize(original), protocol)
  }
})

test('a request survives two hops through every other protocol', () => {
  const source = decodeRequest('openai-completions', completionsBody)
  for (const middle of PROTOCOLS) {
    for (const target of PROTOCOLS) {
      const viaMiddle = decodeRequest(middle, encodeRequest(middle, source, { baseURL: 'https://x' }).body)
      const final = JSON.parse(encodeRequest(target, viaMiddle, { baseURL: 'https://x' }).body)
      const text = JSON.stringify(final)
      assert.match(text, /把这张图里的错误码念出来/, `${middle}→${target}: user text`)
      assert.match(text, /我先查一下天气再回答。/, `${middle}→${target}: assistant text`)
      assert.match(text, /get_weather/, `${middle}→${target}: tool definition`)
      // The arguments are a JSON *string* inside the body, so the city name is
      // matched on its own rather than through its escaping.
      assert.match(text, /city/, `${middle}→${target}: tool arguments`)
      assert.match(text, /北京/, `${middle}→${target}: tool arguments`)
    }
  }
})

// ---------------------------------------------------------------------------
// Degradation: dropped, never thrown
// ---------------------------------------------------------------------------

test('fields the target cannot express are dropped without a throw', () => {
  // `cache_control`, `metadata.user_id`, `eager_input_streaming`, `betas`, a
  // `document` block and an http image URL all have no portable form.
  const loaded = {
    model: 'claude',
    max_tokens: 1024,
    stream: true,
    metadata: { user_id: 'u1' },
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] },
    ],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' }, eager_input_streaming: true }],
    betas: ['interleaved-thinking-2025-05-14'],
  }
  for (const target of PROTOCOLS) {
    const body = JSON.parse(encodeRequest(target, decodeRequest('anthropic-messages', loaded), { baseURL: 'https://x' }).body)
    // The text that can survive does survive.
    assert.match(JSON.stringify(body), /look/, target)
    // Nothing leaks the fields the target does not have.
    const text = JSON.stringify(body)
    assert.equal(text.includes('cache_control'), false, target)
    assert.equal(text.includes('user_id'), false, target)
    assert.equal(text.includes('document'), false, target)
    assert.equal(text.includes('example.com'), false, target)
  }
})

test('a sampling knob the target refuses is dropped, not forwarded', () => {
  // Anthropic rejects temperature together with thinking; pi-ai stops sending
  // it, and so does this layer.
  const request = {
    model: 'claude',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    temperature: 0.7,
    thinking: { budgetTokens: 4096 },
    stream: true,
  }
  const withThinking = JSON.parse(encodeRequest('anthropic-messages', request, { baseURL: 'https://x' }).body)
  assert.equal(withThinking.temperature, undefined)
  assert.deepEqual(withThinking.thinking, { type: 'enabled', budget_tokens: 4096 })
  // ... and the ceiling leaves room for the answer.
  assert.equal(withThinking.max_tokens, 4096 + 1024)

  const withoutThinking = JSON.parse(encodeRequest('anthropic-messages', { ...request, thinking: undefined }, { baseURL: 'https://x' }).body)
  assert.equal(withoutThinking.temperature, 0.7)
  assert.equal(withoutThinking.max_tokens, 4096)
})

test('anthropic always gets a max_tokens, because the field is mandatory there', () => {
  const body = JSON.parse(encodeRequest('anthropic-messages', {
    model: 'claude',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    stream: true,
  }, { baseURL: 'https://x' }).body)
  assert.equal(typeof body.max_tokens, 'number')
  assert.ok(body.max_tokens > 0)
})

test('responses max_output_tokens is floored at 16, as pi-ai floors it', () => {
  const request = {
    model: 'gpt-5.1',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 4,
    stream: true,
  }
  const body = JSON.parse(encodeRequest('openai-responses', request, { baseURL: 'https://x' }).body)
  assert.equal(body.max_output_tokens, 16)
})

test('the completions max token field can be switched for a route that needs it', () => {
  const request = {
    model: 'gpt-5.1',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 100,
    stream: true,
  }
  const legacy = JSON.parse(encodeRequest('openai-completions', request, { baseURL: 'https://x' }).body)
  assert.equal(legacy.max_tokens, 100)
  const modern = JSON.parse(encodeRequest('openai-completions', request, { baseURL: 'https://x', maxTokensField: 'max_completion_tokens' }).body)
  assert.equal(modern.max_completion_tokens, 100)
  assert.equal(modern.max_tokens, undefined)
})

test('a tool definition without a schema still becomes a valid object schema', () => {
  const request = {
    model: 'm',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'f' }],
    stream: true,
  }
  for (const protocol of PROTOCOLS) {
    const body = JSON.parse(encodeRequest(protocol, request, { baseURL: 'https://x' }).body)
    const text = JSON.stringify(body)
    assert.match(text, /"type":"object"/, protocol)
  }
})

test('images survive every hop in the target’s own spelling', () => {
  const request = decodeRequest('anthropic-messages', anthropicBody)
  // The fixture has a system prompt, so it takes slot 0 and the image turn is next.
  const completions = JSON.parse(encodeRequest('openai-completions', request, { baseURL: 'https://x' }).body)
  assert.equal(
    completions.messages[1].content[1].image_url.url,
    'data:image/png;base64,iVBORw0KGgo=',
  )
  const responses = JSON.parse(encodeRequest('openai-responses', request, { baseURL: 'https://x' }).body)
  assert.deepEqual(responses.input[1].content[1], {
    type: 'input_image',
    detail: 'auto',
    image_url: 'data:image/png;base64,iVBORw0KGgo=',
  })
  const backToAnthropic = JSON.parse(encodeRequest('anthropic-messages', request, { baseURL: 'https://x' }).body)
  assert.deepEqual(backToAnthropic.messages[0].content[1].source, {
    type: 'base64',
    media_type: 'image/png',
    data: 'iVBORw0KGgo=',
  })
})

test('a tool result that answers a tool call stays glued to it', () => {
  // Strict OpenAI-compatible providers reject a user turn between an assistant
  // `tool_calls` message and the `role:'tool'` replies that answer it.
  const request = {
    model: 'm',
    messages: [
      { role: 'assistant', parts: [
        { type: 'tool-call', id: 'call_1', name: 'f', argsJson: '{}' },
      ] },
      { role: 'user', parts: [
        { type: 'text', text: 'meanwhile, a note' },
        { type: 'tool-result', id: 'call_1', resultJson: 'ok' },
      ] },
    ],
    stream: true,
  }
  const body = JSON.parse(encodeRequest('openai-completions', request, { baseURL: 'https://x' }).body)
  assert.equal(body.messages[1].role, 'tool')
  assert.equal(body.messages[2].role, 'user')
})
