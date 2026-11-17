/**
 * `google-generative-ai` translation.
 *
 * Gemini is the odd one out on every axis the other three protocols agree on:
 * `contents` instead of `messages`, `model` instead of `assistant`, tool answers
 * as user parts instead of a `tool` role, no tool ids, thinking as a flagged
 * text part, and the method stitched into the path. Each of those has a test
 * below because each one, if wrong, produces a 400 at request time rather than a
 * subtly bad answer.
 *
 * Run: node --test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PROTOCOLS, createStreamDecoder, createStreamEncoder, decodeRequest, encodeRequest } from '../lib/gateway/protocol.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

test('gemini is a declared protocol, so a mixed route can be narrowed onto it', () => {
  assert.ok(PROTOCOLS.includes('google-generative-ai'))
})

test('a gemini request decodes to the canonical shape every other dialect produces', () => {
  const request = decodeRequest('google-generative-ai', {
    systemInstruction: { parts: [{ text: 'You are terse.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ],
    tools: [{ functionDeclarations: [{ name: 'lookup', description: 'look things up', parameters: { type: 'object' } }] }],
    generationConfig: { maxOutputTokens: 64, temperature: 0.2, topP: 0.9, stopSequences: ['END'], thinkingConfig: { thinkingBudget: 2048 } },
  })

  assert.equal(request.system, 'You are terse.')
  assert.deepEqual(request.messages, [
    { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
  ])
  assert.deepEqual(request.tools, [{ name: 'lookup', description: 'look things up', parameters: { type: 'object' } }])
  assert.equal(request.maxTokens, 64)
  assert.equal(request.temperature, 0.2)
  assert.equal(request.topP, 0.9)
  assert.deepEqual(request.stop, ['END'])
  // `budgetTokens` is the canonical field the anthropic and responses encoders
  // read; `budget` used to be dropped, silently downgrading every request.
  assert.deepEqual(request.thinking, { budgetTokens: 2048 })
})

test('the canonical transcript encodes to a gemini body with model roles and one systemInstruction', () => {
  const request = decodeRequest('openai-completions', {
    model: 'gpt-x',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    max_tokens: 32,
  })
  const encoded = encodeRequest('google-generative-ai', request, { baseURL: BASE, apiKey: 'k-123' })

  // The method lives in the path, and without `alt=sse` the provider buffers.
  assert.equal(encoded.url, `${BASE}/models/gpt-x:streamGenerateContent?alt=sse`)
  assert.equal(encoded.headers['x-goog-api-key'], 'k-123')
  assert.equal(encoded.headers.authorization, undefined)
  const body = JSON.parse(encoded.body)
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }] })
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'hello' }] },
  ])
  assert.equal(body.generationConfig.maxOutputTokens, 32)
  // Gemini has no `stream` flag: the endpoint decides.
  assert.equal(body.stream, undefined)
})

test('a base that already carries a query keeps it and still appends alt=sse', () => {
  const request = decodeRequest('openai-completions', { model: 'm', messages: [{ role: 'user', content: 'x' }] })
  const encoded = encodeRequest('google-generative-ai', request, { baseURL: 'https://gw.example/v1beta?key=abc' })
  assert.equal(encoded.url, 'https://gw.example/v1beta/models/m:streamGenerateContent?key=abc&alt=sse')
})

test('a tool call gets a synthesized id, and the tool answer carries its name back', () => {
  const call = {
    id: 'call-1',
    type: 'function',
    function: { name: 'lookup', arguments: '{"q":"x"}' },
  }
  const request = decodeRequest('openai-completions', {
    model: 'm',
    messages: [
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call-1', content: 'found it' },
    ],
  })
  const body = JSON.parse(encodeRequest('google-generative-ai', request, { baseURL: BASE }).body)
  const answer = body.contents.at(-1)
  assert.equal(answer.role, 'user')
  assert.deepEqual(answer.parts, [{ functionResponse: { name: 'lookup', response: { content: 'found it' } } }])
})

test('gemini thinking parts and images survive both directions', () => {
  const request = decodeRequest('google-generative-ai', {
    contents: [{
      role: 'model',
      parts: [
        { text: 'weighing options', thought: true },
        { text: 'done' },
        { inlineData: { mimeType: 'image/webp', data: 'QUJD' } },
      ],
    }],
  })
  assert.deepEqual(request.messages[0].parts, [
    { type: 'thinking', text: 'weighing options' },
    { type: 'text', text: 'done' },
    { type: 'image', mediaType: 'image/webp', dataBase64: 'QUJD' },
  ])
  const body = JSON.parse(encodeRequest('google-generative-ai', request, { baseURL: BASE }).body)
  assert.deepEqual(body.contents[0].parts[0], { text: 'weighing options', thought: true })
  assert.deepEqual(body.contents[0].parts[2], { inlineData: { mimeType: 'image/webp', data: 'QUJD' } })
})

test('a gemini stream decodes to text, a tool call, usage with the cache subtracted, and a finish', () => {
  const decoder = createStreamDecoder('google-generative-ai')
  const frames = [
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"po"}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"ng"}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":"x"}}}]}}]}',
    'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":7,"cachedContentTokenCount":40}}',
  ]
  const events = []
  for (const frame of frames) events.push(...decoder.push(`${frame}\n\n`))
  events.push(...decoder.end())

  assert.deepEqual(events.filter((event) => event.type === 'text'), [
    { type: 'text', text: 'po' },
    { type: 'text', text: 'ng' },
  ])
  const call = events.find((event) => event.type === 'tool-call-start')
  assert.equal(call.name, 'lookup')
  const delta = events.find((event) => event.type === 'tool-call-delta')
  assert.deepEqual(JSON.parse(delta.argsJson), { q: 'x' })
  // `promptTokenCount` includes the cached prefix; the canonical input does not.
  assert.deepEqual(events.find((event) => event.type === 'usage'), { type: 'usage', input: 60, output: 7 })
  assert.deepEqual(events.find((event) => event.type === 'finish'), { type: 'finish', reason: 'stop' })
})

test('MAX_TOKENS is a length finish and thought parts are thinking, not text', () => {
  const decoder = createStreamDecoder('google-generative-ai')
  const events = decoder.push('data: {"candidates":[{"content":{"parts":[{"text":"hmm","thought":true},{"text":"answer"}]},"finishReason":"MAX_TOKENS"}]}\n\n')
  assert.deepEqual(events.find((event) => event.type === 'thinking'), { type: 'thinking', text: 'hmm' })
  assert.deepEqual(events.find((event) => event.type === 'text'), { type: 'text', text: 'answer' })
  assert.deepEqual(events.find((event) => event.type === 'finish'), { type: 'finish', reason: 'length' })
})

test('a truncated gemini stream reports an error instead of a silent finish', () => {
  const decoder = createStreamDecoder('google-generative-ai')
  decoder.push('data: {"candidates":[{"content":{"parts":[{"text":"half"}]}}]}\n\n')
  const events = decoder.end()
  assert.equal(events.at(-1).type, 'error')
})

test('gemini in an error payload becomes a retryable error event, not a crash', () => {
  const decoder = createStreamDecoder('google-generative-ai')
  const events = decoder.push('data: {"error":{"code":503,"message":"upstream unavailable","status":"UNAVAILABLE"}}\n\n')
  const error = events.find((event) => event.type === 'error')
  assert.equal(error.message, 'upstream unavailable')
  assert.equal(error.retryable, true)
})

test('the gemini writer emits candidates frames and a finish reason', () => {
  const encoder = createStreamEncoder('google-generative-ai', { model: 'gemini-x' })
  const frames = []
  for (const event of [
    { type: 'start' },
    { type: 'text', text: 'po' },
    { type: 'text', text: 'ng' },
    { type: 'usage', input: 3, output: 2 },
    { type: 'finish', reason: 'length' },
  ]) frames.push(...encoder.push(event))
  frames.push(...encoder.end())

  const payloads = frames.map((frame) => JSON.parse(frame.replace(/^data: /, '')))
  // Text arrives as one frame per delta, in order, under `candidates[].content.parts`.
  assert.deepEqual(
    payloads.flatMap((payload) => payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text),
    ['po', 'ng'],
  )
  const finished = payloads.map((payload) => payload.candidates?.[0]).find((candidate) => candidate?.finishReason !== undefined)
  assert.equal(finished.finishReason, 'MAX_TOKENS')
  // Gemini reports usage last, carrying no candidate of its own.
  assert.deepEqual(payloads.at(-1), { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 }, candidates: [] })
  assert.ok(encoder.headers['content-type'].startsWith('text/event-stream'))
})

test('a gemini thinking budget reaches the target as tokens, not as minimal effort', async () => {
  const { decodeRequest, encodeRequest } = await import('../lib/gateway/protocol.js')
  const request = decodeRequest('google-generative-ai', {
    contents: [{ role: 'user', parts: [{ text: 'think hard' }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 24576 } },
  })
  const body = JSON.parse(encodeRequest('anthropic-messages', { ...request, model: 'claude-haiku-5-5' }, { baseURL: 'https://api.anthropic.com', apiKey: 'k' }).body)
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 24576 }, 'the budget must survive translation')
  assert.ok(body.max_tokens > 24576, `max_tokens must leave room for the budget, saw ${String(body.max_tokens)}`)
})

test('two parallel calls to the same function keep two ids and two results', async () => {
  const { decodeRequest, createStreamDecoder } = await import('../lib/gateway/protocol.js')

  const request = decodeRequest('google-generative-ai', {
    contents: [
      { role: 'user', parts: [{ text: 'read both' }] },
      { role: 'model', parts: [
        { functionCall: { name: 'read_file', args: { path: 'a.txt' } } },
        { functionCall: { name: 'read_file', args: { path: 'b.txt' } } },
      ] },
      { role: 'user', parts: [
        { functionResponse: { name: 'read_file', response: { content: 'A' } } },
        { functionResponse: { name: 'read_file', response: { content: 'B' } } },
      ] },
    ],
  })
  const calls = request.messages.flatMap((message) => message.parts.filter((part) => part.type === 'tool-call'))
  const results = request.messages.flatMap((message) => message.parts.filter((part) => part.type === 'tool-result'))
  assert.equal(calls.length, 2)
  assert.equal(new Set(calls.map((call) => call.id)).size, 2, 'same-name calls must not share an id')
  assert.deepEqual(results.map((result) => result.id), calls.map((call) => call.id), 'each result pairs with its own call')

  const decoder = createStreamDecoder('google-generative-ai')
  const frame = JSON.stringify({
    candidates: [{ content: { parts: [
      { functionCall: { name: 'read_file', args: { path: 'a.txt' } } },
      { functionCall: { name: 'read_file', args: { path: 'b.txt' } } },
    ] } }],
  })
  const events = decoder.push(Buffer.from(`data: ${frame}\n\n`))
  const starts = events.filter((event) => event.type === 'tool-call-start')
  assert.equal(starts.length, 2)
  assert.equal(new Set(starts.map((event) => event.id)).size, 2, 'the stream must not reuse an id either')
})

test('a Gemini thinking budget keeps its size instead of collapsing to minimal', () => {
  const canonical = decodeRequest('google-generative-ai', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 24576 } },
  })
  assert.deepEqual(canonical.thinking, { budgetTokens: 24576 })
  // The same number has to come back out in the target protocol's unit.
  const anthropic = JSON.parse(encodeRequest('anthropic-messages', canonical, { baseURL: 'https://x/v1', apiKey: 'k' }).body)
  assert.deepEqual(anthropic.thinking, { type: 'enabled', budget_tokens: 24576 })
})

test('a Gemini thought signature is carried onto the call and replayed', () => {
  const canonical = decodeRequest('google-generative-ai', {
    contents: [
      { role: 'user', parts: [{ text: 'read a.txt' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'sig-abc' }] },
    ],
  })
  const call = canonical.messages.at(-1).parts.find((part) => part.type === 'tool-call')
  assert.equal(call.signature, 'sig-abc')

  const body = JSON.parse(encodeRequest('google-generative-ai', canonical, { baseURL: 'https://x/v1beta', apiKey: 'k' }).body)
  const part = body.contents.at(-1).parts.find((entry) => entry.functionCall !== undefined)
  assert.equal(part.thoughtSignature, 'sig-abc', 'the signature has to come back with the call')
})

test('two parallel calls to the same function get distinct ids', () => {
  const canonical = decodeRequest('google-generative-ai', {
    contents: [{
      role: 'model',
      parts: [
        { functionCall: { name: 'read_file', args: { path: 'a.txt' } } },
        { functionCall: { name: 'read_file', args: { path: 'b.txt' } } },
      ],
    }],
  })
  const ids = canonical.messages.at(-1).parts.filter((part) => part.type === 'tool-call').map((part) => part.id)
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
})
