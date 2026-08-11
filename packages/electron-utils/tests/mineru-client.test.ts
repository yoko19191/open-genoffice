import { describe, expect, it, vi } from 'vitest'
import {
  MineruError,
  assertMineruHttpsUrl,
  classifyMineruError,
  createMineruClient,
  waitForMineruResult,
} from '../src/mineru-client'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('MinerU Standard API client', () => {
  it('classifies stable provider errors without exposing raw response bodies', () => {
    expect(classifyMineruError('A0202')).toEqual({
      code: 'A0202',
      kind: 'authentication',
      retriable: false,
    })
    expect(classifyMineruError(-60018)).toMatchObject({ kind: 'quota', retriable: true })
    expect(classifyMineruError(-60015)).toMatchObject({ kind: 'conversion', retriable: true })
    expect(classifyMineruError(-10001)).toMatchObject({ kind: 'service', retriable: true })
    expect(classifyMineruError(-500)).toMatchObject({ kind: 'request', retriable: false })
    expect(classifyMineruError('new-code')).toMatchObject({ kind: 'unknown', retriable: false })
  })

  it('maps HTTP, JSON and provider envelope failures to stable redacted errors', async () => {
    expect(() => assertMineruHttpsUrl('not a URL')).toThrow('mineru_url_invalid')
    for (const [response, expected] of [
      [new Response(null, { status: 401 }), { kind: 'request', retriable: false }],
      [new Response(null, { status: 503 }), { kind: 'service', retriable: true }],
      [new Response('not-json', { status: 200 }), { kind: 'protocol' }],
      [jsonResponse([]), { kind: 'protocol' }],
      [jsonResponse({ code: 'A0202' }), { kind: 'authentication', retriable: false }],
      [jsonResponse({ code: 0, data: [] }), { kind: 'protocol' }],
    ] as const) {
      const client = createMineruClient({
        token: 'secret',
        fetch: vi.fn(async () => response),
      })
      await expect(client.requestLocalUpload('fixture.pdf')).rejects.toMatchObject(expected)
    }
  })

  it('allocates exactly one VLM DOCX upload and PUTs bytes without auth headers', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            batch_id: 'private-batch-id',
            file_urls: ['https://signed.example/upload?private=signature'],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const client = createMineruClient({ token: 'private-token', fetch })

    const allocation = await client.requestLocalUpload('fixture.pdf')
    await client.upload(allocation.uploadUrl, new Uint8Array([1, 2, 3]))

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://mineru.net/api/v4/file-urls/batch',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer private-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [{ name: 'fixture.pdf' }],
          model_version: 'vlm',
          extra_formats: ['docx'],
        }),
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://signed.example/upload?private=signature',
      expect.objectContaining({ method: 'PUT', body: new Uint8Array([1, 2, 3]) }),
    )
    expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('headers')
  })

  it('normalizes every active state and returns only an internal result URL', async () => {
    const states = ['waiting-file', 'pending', 'running', 'converting', 'uploading']
    const responses = [
      ...states.map((state) =>
        jsonResponse({
          code: 0,
          data: { extract_result: [{ file_name: 'fixture.pdf', state }] },
        }),
      ),
      jsonResponse({
        code: 0,
        data: {
          extract_result: [
            {
              file_name: 'fixture.pdf',
              state: 'done',
              full_zip_url: 'https://result.example/archive.zip?private=result',
            },
          ],
        },
      }),
    ]
    const client = createMineruClient({
      token: 'private-token',
      fetch: vi.fn(async () => responses.shift()!),
    })
    const observed: string[] = []
    const resultUrl = await waitForMineruResult(client, 'private-batch-id', 'fixture.pdf', {
      wait: async (projection) => {
        observed.push(projection.state)
      },
    })

    expect(observed).toEqual(states)
    expect(resultUrl).toBe('https://result.example/archive.zip?private=result')
  })

  it('fails closed on plaintext URLs, malformed envelopes, duplicates, failed state and timeout', async () => {
    expect(() => createMineruClient({ token: '' })).toThrow('mineru_credential_missing')
    expect(() =>
      createMineruClient({ token: 'secret', baseUrl: 'https://example.com/api/v4' }),
    ).toThrow('mineru_api_origin_invalid')

    const responses = [
      jsonResponse({ code: 0, data: { batch_id: 'batch', file_urls: ['http://unsafe/upload'] } }),
      jsonResponse({ code: 0, data: {} }),
      jsonResponse({
        code: 0,
        data: {
          extract_result: [
            { file_name: 'fixture.pdf', state: 'pending' },
            { file_name: 'fixture.pdf', state: 'pending' },
          ],
        },
      }),
      jsonResponse({
        code: 0,
        data: {
          extract_result: [
            {
              file_name: 'fixture.pdf',
              state: 'failed',
              err_code: -60016,
              err_msg: 'private provider detail',
            },
          ],
        },
      }),
    ]
    const client = createMineruClient({
      token: 'secret',
      fetch: vi.fn(async () => responses.shift()!),
    })
    await expect(client.requestLocalUpload('fixture.pdf')).rejects.toMatchObject({
      code: 'mineru_url_invalid',
    })
    await expect(client.getBatchResult('batch', 'fixture.pdf')).rejects.toMatchObject({
      code: 'mineru_response_invalid',
    })
    await expect(client.getBatchResult('batch', 'fixture.pdf')).rejects.toMatchObject({
      code: 'mineru_response_invalid',
    })
    await expect(client.getBatchResult('batch', 'fixture.pdf')).rejects.toMatchObject({
      code: 'mineru_conversion_failed',
      message: 'mineru_conversion_failed',
    })
    await expect(
      waitForMineruResult(
        { getBatchResult: async () => ({ state: 'pending' as const }) },
        'batch',
        'fixture.pdf',
        { maxPolls: 1 },
      ),
    ).rejects.toEqual(new MineruError('mineru_timeout', 'timeout', true))
  })

  it('rejects malformed allocation and result projections', async () => {
    const responses = [
      jsonResponse({ code: 0, data: { batch_id: 1, file_urls: [] } }),
      jsonResponse({ code: 0, data: { extract_result: [null, []] } }),
      jsonResponse({
        code: 0,
        data: { extract_result: [{ file_name: 'fixture.pdf', state: 3 }] },
      }),
      jsonResponse({
        code: 0,
        data: { extract_result: [{ file_name: 'fixture.pdf', state: 'unknown' }] },
      }),
      jsonResponse({
        code: 0,
        data: {
          extract_result: [{ file_name: 'fixture.pdf', state: 'done', full_zip_url: 'not a URL' }],
        },
      }),
    ]
    const client = createMineruClient({
      token: 'secret',
      fetch: vi.fn(async () => responses.shift()!),
    })
    await expect(client.requestLocalUpload('fixture.pdf')).rejects.toThrow(
      'mineru_response_invalid',
    )
    for (let index = 0; index < 4; index += 1) {
      await expect(client.getBatchResult('batch', 'fixture.pdf')).rejects.toBeInstanceOf(
        MineruError,
      )
    }
  })

  it.each([
    [400, 'upload', false],
    [403, 'upload', true],
    [503, 'service', true],
  ])('classifies upload status %s without response detail', async (status, kind, retriable) => {
    const client = createMineruClient({
      token: 'secret',
      fetch: vi.fn(async () => new Response('private detail', { status })),
    })
    await expect(
      client.upload('https://signed.example/private', new Uint8Array([1])),
    ).rejects.toMatchObject({
      message: 'mineru_upload_failed',
      kind,
      retriable,
    })
  })

  it('stops local work on Abort without claiming the remote operation was cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('local_cancelled'))
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createMineruClient({ token: 'secret', fetch })

    await expect(
      client.requestLocalUpload('fixture.pdf', { signal: controller.signal }),
    ).rejects.toThrow('local_cancelled')
    await expect(
      client.upload('https://signed.example/upload', new Uint8Array([1]), {
        signal: controller.signal,
      }),
    ).rejects.toThrow('local_cancelled')
    await expect(
      client.getBatchResult('batch', 'fixture.pdf', { signal: controller.signal }),
    ).rejects.toThrow('local_cancelled')
    await expect(
      waitForMineruResult(client, 'batch', 'fixture.pdf', { signal: controller.signal }),
    ).rejects.toThrow('local_cancelled')
    expect(fetch).not.toHaveBeenCalled()
  })
})
