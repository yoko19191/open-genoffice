import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CasMismatchError } from '../src/repository.mjs'
import { S3ObjectStore } from '../src/s3-store.mjs'

const bytes = (value) => new TextEncoder().encode(value)

const body = (value) => ({ transformToByteArray: async () => bytes(value) })
const httpError = (status, name = 'Error') =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

test('validates S3 configuration and encryption modes', () => {
  assert.throws(() => new S3ObjectStore({ client: null, bucket: 'bucket' }), /client/u)
  assert.throws(() => new S3ObjectStore({ client: { send() {} }, bucket: '' }), /bucket/u)
  assert.throws(
    () =>
      new S3ObjectStore({
        client: { send() {} },
        bucket: 'bucket',
        encryption: { algorithm: 'bad' },
      }),
    /encryption/u,
  )
  assert.throws(
    () =>
      new S3ObjectStore({
        client: { send() {} },
        bucket: 'bucket',
        encryption: { algorithm: 'aws:kms' },
      }),
    /encryption/u,
  )
})

test('gets S3 objects with ETag and handles both not-found forms', async () => {
  const responses = [
    { ETag: '"v1"', Body: body('data') },
    httpError(404),
    Object.assign(new Error('missing'), { name: 'NoSuchKey' }),
    { Body: body('bad') },
    new Error('network'),
  ]
  const calls = []
  const store = new S3ObjectStore({
    client: {
      async send(command) {
        calls.push(command.input)
        const response = responses.shift()
        if (response instanceof Error) throw response
        return response
      },
    },
    bucket: 'bucket',
    prefix: '/root/',
  })
  assert.deepEqual(await store.get('head.json'), { bytes: bytes('data'), versionToken: '"v1"' })
  assert.deepEqual(calls[0], { Bucket: 'bucket', Key: 'root/head.json' })
  assert.equal(await store.get('missing-a'), null)
  assert.equal(await store.get('missing-b'), null)
  await assert.rejects(() => store.get('bad-etag'), /ETag/u)
  await assert.rejects(() => store.get('network'), /network/u)
})

test('creates immutable S3 objects conditionally and passes SSE parameters', async () => {
  const calls = []
  const responses = [
    {},
    httpError(412),
    Object.assign(new Error('precondition'), { name: 'PreconditionFailed' }),
    new Error('network'),
  ]
  const store = new S3ObjectStore({
    client: {
      async send(command) {
        calls.push(command.input)
        const response = responses.shift()
        if (response instanceof Error) throw response
        return response
      },
    },
    bucket: 'bucket',
    encryption: { algorithm: 'AES256' },
  })
  assert.deepEqual(await store.putIfAbsent('blob', bytes('x')), { created: true })
  assert.equal(calls[0].IfNoneMatch, '*')
  assert.equal(calls[0].ServerSideEncryption, 'AES256')
  assert.deepEqual(await store.putIfAbsent('blob', bytes('x')), { created: false })
  assert.deepEqual(await store.putIfAbsent('blob', bytes('x')), { created: false })
  await assert.rejects(() => store.putIfAbsent('blob', bytes('x')), /network/u)
})

test('uses S3 If-None-Match and If-Match for manifest CAS including KMS', async () => {
  const calls = []
  const responses = [
    { ETag: '"v1"' },
    { ETag: '"v2"' },
    httpError(412),
    { ETag: null },
    new Error('network'),
  ]
  const store = new S3ObjectStore({
    client: {
      async send(command) {
        calls.push(command.input)
        const response = responses.shift()
        if (response instanceof Error) throw response
        return response
      },
    },
    bucket: 'bucket',
    encryption: { algorithm: 'aws:kms', kmsKeyId: 'key-1' },
  })
  assert.deepEqual(await store.compareAndSwap('head', bytes('one'), null), {
    versionToken: '"v1"',
  })
  assert.equal(calls[0].IfNoneMatch, '*')
  assert.equal(calls[0].SSEKMSKeyId, 'key-1')
  assert.deepEqual(await store.compareAndSwap('head', bytes('two'), '"v1"'), {
    versionToken: '"v2"',
  })
  assert.equal(calls[1].IfMatch, '"v1"')
  await assert.rejects(() => store.compareAndSwap('head', bytes('x'), '"old"'), CasMismatchError)
  await assert.rejects(() => store.compareAndSwap('head', bytes('x'), '"v2"'), /ETag/u)
  await assert.rejects(() => store.compareAndSwap('head', bytes('x'), '"v2"'), /network/u)
})
