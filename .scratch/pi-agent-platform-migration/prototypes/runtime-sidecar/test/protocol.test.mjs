import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PROTOCOL_VERSION,
  createJsonLineDecoder,
  encodeMessage,
  errorEnvelope,
  secureTokenEqual,
  validateBootstrap,
} from '../src/protocol.mjs'

const validBootstrap = {
  protocolVersion: PROTOCOL_VERSION,
  parentPid: 42,
  endpoint: '/tmp/runtime.sock',
  token: 'a'.repeat(64),
}

test('encodes one newline-delimited JSON message', () => {
  assert.equal(encodeMessage({ ok: true }), '{"ok":true}\n')
})

test('compares bearer tokens without accepting types or lengths that differ', () => {
  assert.equal(secureTokenEqual('secret', 'secret'), true)
  assert.equal(secureTokenEqual('secret', 'other!'), false)
  assert.equal(secureTokenEqual('short', 'longer'), false)
  assert.equal(secureTokenEqual(null, 'secret'), false)
})

test('validates a bootstrap tied to the actual parent', () => {
  assert.equal(validateBootstrap(validBootstrap, 42), validBootstrap)
})

test('rejects malformed bootstrap records', () => {
  assert.throws(() => validateBootstrap(null, 42), /object/u)
  assert.throws(
    () => validateBootstrap({ ...validBootstrap, protocolVersion: '0' }, 42),
    /unsupported bootstrap protocol/u,
  )
  assert.throws(
    () => validateBootstrap({ ...validBootstrap, parentPid: 0 }, 42),
    /positive integer/u,
  )
  assert.throws(() => validateBootstrap(validBootstrap, 43), /does not match/u)
  assert.throws(() => validateBootstrap({ ...validBootstrap, endpoint: '' }, 42), /endpoint/u)
  assert.throws(() => validateBootstrap({ ...validBootstrap, token: 'bad' }, 42), /256-bit/u)
})

test('decodes split and batched JSON lines', () => {
  const messages = []
  const errors = []
  const decoder = createJsonLineDecoder(
    (message) => messages.push(message),
    (error) => errors.push(error.message),
  )
  decoder.push('{"a":')
  decoder.push('1}\n\n{"b":2}\n')
  decoder.end()
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }])
  assert.deepEqual(errors, [])
})

test('reports invalid and unterminated JSON without throwing from the decoder', () => {
  const errors = []
  const decoder = createJsonLineDecoder(
    () => assert.fail('invalid JSON must not be emitted'),
    (error) => errors.push(error.message),
  )
  decoder.push('{bad}\n{"unfinished":')
  decoder.end()
  assert.equal(errors.length, 2)
  decoder.end()
})

test('creates stable error envelopes', () => {
  assert.deepEqual(errorEnvelope(undefined, 'bad', 'broken'), {
    id: null,
    error: { code: 'bad', message: 'broken' },
  })
  assert.equal(errorEnvelope(7, 'bad', 'broken').id, 7)
})
