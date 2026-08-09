import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MineruError,
  assertHttpsUrl,
  classifyMineruError,
  createMineruClient,
  waitForMineruResult,
} from '../src/mineru-client.mjs'

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('classifies documented error families without exposing credentials', () => {
  assert.deepEqual(classifyMineruError('A0202'), {
    code: 'A0202',
    kind: 'authentication',
    retriable: false,
  })
  assert.equal(classifyMineruError('A0211').kind, 'authentication')
  assert.equal(classifyMineruError(-60012).kind, 'not_found')
  assert.equal(classifyMineruError(-60013).kind, 'permission')
  assert.equal(classifyMineruError(-60015).kind, 'conversion')
  assert.equal(classifyMineruError(-60016).retriable, true)
  assert.equal(classifyMineruError(-60018).kind, 'quota')
  assert.equal(classifyMineruError(-500).kind, 'request')
  assert.equal(classifyMineruError(-10002).kind, 'request')
  assert.equal(classifyMineruError(-10001).kind, 'service')
  assert.equal(classifyMineruError(-60001).kind, 'service')
  assert.equal(classifyMineruError(-60011).kind, 'service')
  assert.equal(classifyMineruError(-60020).kind, 'service')
  assert.equal(classifyMineruError('new-code').kind, 'unknown')
})

test('accepts HTTPS URLs and rejects invalid or plaintext URLs', () => {
  assert.equal(assertHttpsUrl('https://example.com/a', 'result').hostname, 'example.com')
  assert.throws(() => assertHttpsUrl('not a URL', 'result'), /valid URL/u)
  assert.throws(() => assertHttpsUrl('http://example.com/a', 'result'), /HTTPS/u)
})

test('requires a token and fixes the API origin and version', () => {
  assert.throws(() => createMineruClient({ token: '' }), /token is required/u)
  assert.throws(
    () => createMineruClient({ token: 'secret', baseUrl: 'https://example.com/api/v4' }),
    /not allowed/u,
  )
  assert.throws(
    () => createMineruClient({ token: 'secret', baseUrl: 'https://mineru.net/api/v3' }),
    /not allowed/u,
  )
})

test('allocates exactly one local DOCX upload without logging signed data', async () => {
  const calls = []
  const client = createMineruClient({
    token: 'top-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({
        code: 0,
        data: {
          batch_id: 'batch-1',
          file_urls: ['https://signed.example/upload?secret=hidden'],
        },
      })
    },
  })
  const allocation = await client.requestLocalUpload('fixture.pdf', { dataId: 'fixture-01' })
  assert.deepEqual(allocation, {
    batchId: 'batch-1',
    uploadUrl: 'https://signed.example/upload?secret=hidden',
  })
  assert.equal(calls[0].url, 'https://mineru.net/api/v4/file-urls/batch')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer top-secret')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    files: [{ name: 'fixture.pdf', data_id: 'fixture-01' }],
    model_version: 'vlm',
    extra_formats: ['docx'],
  })
})

test('omits optional data id and rejects malformed upload allocations', async () => {
  let requestBody
  const client = createMineruClient({
    token: 'secret',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body)
      return jsonResponse({ code: 0, data: { batch_id: 'batch', file_urls: [] } })
    },
  })
  await assert.rejects(() => client.requestLocalUpload('fixture.pdf'), /allocation is malformed/u)
  assert.deepEqual(requestBody.files, [{ name: 'fixture.pdf' }])
})

test('uploads to the exact signed URL without adding headers', async () => {
  let call
  const client = createMineruClient({
    token: 'secret',
    fetchImpl: async (url, init) => {
      call = { url, init }
      return new Response(null, { status: 200 })
    },
  })
  const bytes = new Uint8Array([1, 2, 3])
  await client.upload('https://signed.example/put?signature=opaque', bytes)
  assert.equal(call.url, 'https://signed.example/put?signature=opaque')
  assert.equal(call.init.method, 'PUT')
  assert.equal(call.init.body, bytes)
  assert.equal(call.init.headers, undefined)
})

test('maps upload failures without including the signed URL', async () => {
  const client = createMineruClient({
    token: 'secret',
    fetchImpl: async () => new Response(null, { status: 403 }),
  })
  await assert.rejects(
    () => client.upload('https://signed.example/put?signature=do-not-log', new Uint8Array()),
    (error) =>
      error instanceof MineruError &&
      error.kind === 'upload' &&
      error.retriable &&
      !error.message.includes('do-not-log'),
  )
  const serverClient = createMineruClient({
    token: 'secret',
    fetchImpl: async () => new Response(null, { status: 503 }),
  })
  await assert.rejects(() => serverClient.upload('https://signed.example/put', new Uint8Array()), {
    kind: 'service',
    retriable: true,
  })
})

test('normalizes active and done batch states', async () => {
  const responses = [
    jsonResponse({
      code: 0,
      data: {
        batch_id: 'batch',
        extract_result: [
          {
            file_name: 'fixture.pdf',
            state: 'running',
            extract_progress: { extracted_pages: 1, total_pages: 2 },
          },
        ],
      },
    }),
    jsonResponse({
      code: 0,
      data: {
        batch_id: 'batch',
        extract_result: [
          {
            file_name: 'fixture.pdf',
            state: 'done',
            full_zip_url: 'https://cdn.example/result.zip',
          },
        ],
      },
    }),
  ]
  const client = createMineruClient({
    token: 'secret',
    fetchImpl: async () => responses.shift(),
  })
  assert.deepEqual(await client.getBatchResult('batch/id', 'fixture.pdf'), {
    state: 'running',
    progress: { extracted_pages: 1, total_pages: 2 },
  })
  assert.deepEqual(await client.getBatchResult('batch/id', 'fixture.pdf'), {
    state: 'done',
    resultUrl: 'https://cdn.example/result.zip',
  })
})

test('rejects malformed, missing, duplicate, unknown and failed batch results', async () => {
  const payloads = [
    { code: 0, data: {} },
    { code: 0, data: { extract_result: [] } },
    {
      code: 0,
      data: {
        extract_result: [
          { file_name: 'fixture.pdf', state: 'pending' },
          { file_name: 'fixture.pdf', state: 'pending' },
        ],
      },
    },
    { code: 0, data: { extract_result: [{ file_name: 'fixture.pdf', state: 'surprise' }] } },
    {
      code: 0,
      data: {
        extract_result: [
          { file_name: 'fixture.pdf', state: 'failed', err_code: -60016, err_msg: 'failed' },
        ],
      },
    },
    {
      code: 0,
      data: { extract_result: [{ file_name: 'fixture.pdf', state: 'done', full_zip_url: 'bad' }] },
    },
  ]
  const client = createMineruClient({
    token: 'secret',
    fetchImpl: async () => jsonResponse(payloads.shift()),
  })
  for (const pattern of [
    /malformed/u,
    /exactly one/u,
    /exactly one/u,
    /unknown task state/u,
    /failed/u,
    /valid URL/u,
  ]) {
    await assert.rejects(() => client.getBatchResult('batch', 'fixture.pdf'), pattern)
  }
})

test('maps HTTP, invalid JSON and API envelope errors', async () => {
  const responses = [
    new Response(null, { status: 503 }),
    new Response('not-json', { status: 200 }),
    jsonResponse(null),
    jsonResponse({ code: 'A0202', msg: 'bad token' }),
    jsonResponse({ success: false, msgCode: 'A0211', msg: 'expired token' }),
  ]
  const client = createMineruClient({
    token: 'secret',
    fetchImpl: async () => responses.shift(),
  })
  await assert.rejects(() => client.getBatchResult('batch', 'fixture.pdf'), {
    kind: 'service',
    retriable: true,
  })
  await assert.rejects(() => client.getBatchResult('batch', 'fixture.pdf'), /invalid JSON/u)
  await assert.rejects(
    () => client.getBatchResult('batch', 'fixture.pdf'),
    /invalid JSON envelope/u,
  )
  await assert.rejects(() => client.getBatchResult('batch', 'fixture.pdf'), {
    kind: 'authentication',
    retriable: false,
  })
  await assert.rejects(() => client.getBatchResult('batch', 'fixture.pdf'), {
    code: 'A0211',
    kind: 'authentication',
    retriable: false,
  })
})

test('waits through active states and returns the result URL', async () => {
  const states = [
    { state: 'waiting-file', progress: null },
    { state: 'converting', progress: null },
    { state: 'done', resultUrl: 'https://cdn.example/result.zip' },
  ]
  const waits = []
  const client = {
    async getBatchResult() {
      return states.shift()
    },
  }
  const result = await waitForMineruResult(client, 'batch', 'fixture.pdf', {
    wait: async (state, poll) => waits.push({ state: state.state, poll }),
  })
  assert.equal(result, 'https://cdn.example/result.zip')
  assert.deepEqual(waits, [
    { state: 'waiting-file', poll: 0 },
    { state: 'converting', poll: 1 },
  ])
})

test('local abort and timeout never claim remote cancellation', async () => {
  const controller = new AbortController()
  controller.abort(new Error('user stopped local work'))
  const client = createMineruClient({ token: 'secret', fetchImpl: async () => assert.fail() })
  await assert.rejects(
    () => client.requestLocalUpload('fixture.pdf', { signal: controller.signal }),
    {
      message: 'user stopped local work',
    },
  )
  await assert.rejects(
    () =>
      client.upload('https://signed.example/put', new Uint8Array(), { signal: controller.signal }),
    /user stopped local work/u,
  )
  await assert.rejects(
    () => client.getBatchResult('batch', 'fixture.pdf', { signal: controller.signal }),
    /user stopped local work/u,
  )
  await assert.rejects(
    () =>
      waitForMineruResult(
        { getBatchResult: async () => ({ state: 'pending' }) },
        'batch',
        'fixture.pdf',
        { maxPolls: 1 },
      ),
    (error) => error.kind === 'timeout' && /remote task may still run/u.test(error.message),
  )
  await assert.rejects(
    () => waitForMineruResult(client, 'batch', 'fixture.pdf', { signal: controller.signal }),
    /user stopped local work/u,
  )
})
