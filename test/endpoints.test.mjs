/**
 * Tests for the address table.
 *
 * A route like `opencode` keeps its address on each model instead of on the
 * route, so the settings document has no `baseURL` to read. The old plugin knew
 * those addresses from a table of its own; this module is that table, minus the
 * guesswork.
 *
 * Run: node --test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ENDPOINT_HINTS, endpointFor, hintedBaseURL } from '../lib/endpoints.js'

test('an address configured on the route always wins', () => {
  // The hint exists to fill a hole, never to overrule the user.
  assert.deepEqual(endpointFor({ provider: 'opencode', baseURL: 'https://proxy.example/v1' }), {
    baseURL: 'https://proxy.example/v1',
    source: 'route',
  })
})

test('a route without an address falls back to the table', () => {
  assert.deepEqual(endpointFor({ provider: 'opencode' }), { baseURL: ENDPOINT_HINTS.opencode.baseURL, source: 'hint' })
  assert.deepEqual(endpointFor({ provider: 'opencode-go' }), { baseURL: ENDPOINT_HINTS['opencode-go'].baseURL, source: 'hint' })
})

test('a provider the table does not know stays unknown', () => {
  // Guessing an address would ask the wrong server and report its 404 as the
  // user's problem, which is exactly what `no-endpoint` exists to avoid.
  assert.deepEqual(endpointFor({ provider: 'who-knows' }), { baseURL: undefined, source: 'unknown' })
  assert.equal(hintedBaseURL('who-knows'), undefined)
  assert.equal(hintedBaseURL(undefined), undefined)
})

test('every hint is an https address without a trailing slash', () => {
  for (const [provider, hint] of Object.entries(ENDPOINT_HINTS)) {
    assert.match(hint.baseURL, /^https:\/\//, `${provider} must be https`)
    assert.doesNotMatch(hint.baseURL, /\/$/, `${provider} must not end with a slash`)
    assert.equal(typeof hint.note, 'string')
  }
})
