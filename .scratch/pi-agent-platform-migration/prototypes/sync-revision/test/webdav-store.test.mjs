import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CasMismatchError } from '../src/repository.mjs'
import {
  WebDavObjectStore,
  createAuthenticatedWebDavObjectStore,
  webDavClientOptions,
} from '../src/webdav-store.mjs'

const bytes = (value) => new TextEncoder().encode(value)

test('requires HTTPS except explicit loopback probes and encodes keys', () => {
  assert.throws(() => new WebDavObjectStore({ baseUrl: 'http://example.com/root/' }), /HTTPS/u)
  const store = new WebDavObjectStore({
    baseUrl: 'http://127.0.0.1:19000/root/',
    allowInsecureLoopback: true,
  })
  assert.equal(
    store.url('space dir/head.json'),
    'http://127.0.0.1:19000/root/space%20dir/head.json',
  )
})

test('reuses the webdav client authentication stack for basic, digest and bearer', () => {
  assert.equal(
    webDavClientOptions({ type: 'basic', username: 'u', password: 'p' }).authType,
    'password',
  )
  assert.deepEqual(
    webDavClientOptions({ type: 'digest', username: 'u', password: 'p', ha1: 'h' }),
    {
      authType: 'digest',
      username: 'u',
      password: 'p',
      ha1: 'h',
    },
  )
  assert.equal(webDavClientOptions({ type: 'digest', username: 'u', password: 'p' }).ha1, undefined)
  assert.deepEqual(webDavClientOptions({ type: 'bearer', token: 'hidden' }).headers, {
    Authorization: 'Bearer hidden',
  })
  assert.deepEqual(webDavClientOptions(), {})
  assert.throws(() => webDavClientOptions({ type: 'unknown' }), /basic, digest or bearer/u)
  assert.ok(
    createAuthenticatedWebDavObjectStore({
      baseUrl: 'https://dav.example/root/',
      auth: { type: 'basic', username: 'u', password: 'p' },
    }) instanceof WebDavObjectStore,
  )
})

test('routes authenticated conditional requests through webdav customRequest', async () => {
  const calls = []
  const responses = [
    new Response(null, { status: 201 }),
    Object.assign(new Error('precondition'), { response: new Response(null, { status: 412 }) }),
    new Error('network'),
  ]
  const store = createAuthenticatedWebDavObjectStore({
    baseUrl: 'https://dav.example/root/',
    auth: { type: 'digest', username: 'u', password: 'p' },
    clientFactory: (baseUrl, options) => {
      assert.equal(baseUrl, 'https://dav.example/root/')
      assert.equal(options.authType, 'digest')
      return {
        async customRequest(path, request) {
          calls.push({ path, request })
          const response = responses.shift()
          if (response instanceof Error) throw response
          return response
        },
      }
    },
  })
  assert.deepEqual(await store.putIfAbsent('a blob', bytes('x')), { created: true })
  assert.equal(calls[0].path, '/a blob')
  assert.equal(calls[0].request.method, 'PUT')
  assert.deepEqual(calls[0].request.data, Buffer.from(bytes('x')))
  assert.deepEqual(await store.putIfAbsent('a blob', bytes('x')), { created: false })
  await assert.rejects(() => store.putIfAbsent('a blob', bytes('x')), /network/u)
})

test('gets bytes with a strong ETag, auth and handles missing or failed objects', async () => {
  const calls = []
  const responses = [
    new Response(bytes('data'), { status: 200, headers: { etag: '"v1"' } }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 500 }),
    new Response(bytes('data'), { status: 200, headers: { etag: 'W/"weak"' } }),
  ]
  const store = new WebDavObjectStore({
    baseUrl: 'https://dav.example/root/',
    authorization: 'Bearer hidden',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return responses.shift()
    },
  })
  assert.deepEqual(await store.get('head.json'), {
    bytes: bytes('data'),
    versionToken: '"v1"',
  })
  assert.equal(calls[0].init.headers.Authorization, 'Bearer hidden')
  assert.equal(await store.get('missing'), null)
  await assert.rejects(() => store.get('failed'), /HTTP 500/u)
  await assert.rejects(() => store.get('weak'), /strong ETag/u)
})

test('uses If-None-Match for immutable WebDAV objects', async () => {
  const calls = []
  const responses = [
    new Response(null, { status: 201 }),
    new Response(null, { status: 412 }),
    new Response(null, { status: 507 }),
  ]
  const store = new WebDavObjectStore({
    baseUrl: 'https://dav.example/root/',
    fetchImpl: async (_url, init) => {
      calls.push(init)
      return responses.shift()
    },
  })
  assert.deepEqual(await store.putIfAbsent('blob', bytes('x')), { created: true })
  assert.equal(calls[0].headers['If-None-Match'], '*')
  assert.deepEqual(await store.putIfAbsent('blob', bytes('x')), { created: false })
  await assert.rejects(() => store.putIfAbsent('blob', bytes('x')), /HTTP 507/u)
})

test('uses conditional PUT for WebDAV head creation and replacement', async () => {
  const calls = []
  const responses = [
    new Response(null, { status: 201, headers: { etag: '"v1"' } }),
    new Response(null, { status: 204, headers: { etag: '"v2"' } }),
    new Response(null, { status: 412 }),
    new Response(null, { status: 500 }),
  ]
  const store = new WebDavObjectStore({
    baseUrl: 'https://dav.example/root/',
    fetchImpl: async (_url, init) => {
      calls.push(init)
      return responses.shift()
    },
  })
  assert.deepEqual(await store.compareAndSwap('head', bytes('one'), null), {
    versionToken: '"v1"',
  })
  assert.equal(calls[0].headers['If-None-Match'], '*')
  assert.deepEqual(await store.compareAndSwap('head', bytes('two'), '"v1"'), {
    versionToken: '"v2"',
  })
  assert.equal(calls[1].headers['If-Match'], '"v1"')
  await assert.rejects(() => store.compareAndSwap('head', bytes('x'), '"old"'), CasMismatchError)
  await assert.rejects(() => store.compareAndSwap('head', bytes('x'), '"old"'), /HTTP 500/u)
})

test('falls back to HEAD when a successful WebDAV PUT omits ETag', async () => {
  const responses = [
    new Response(null, { status: 204 }),
    new Response(null, { status: 200, headers: { etag: '"from-head"' } }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 500 }),
  ]
  const store = new WebDavObjectStore({
    baseUrl: 'https://dav.example/root/',
    fetchImpl: async () => responses.shift(),
  })
  assert.deepEqual(await store.compareAndSwap('head', bytes('x'), '"old"'), {
    versionToken: '"from-head"',
  })
  await assert.rejects(() => store.compareAndSwap('head', bytes('x'), '"old"'), /HEAD failed/u)
})
