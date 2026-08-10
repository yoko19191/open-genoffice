import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScopedArtifactStore } from '@genoffice/agent-resource'
import { PlatformToolService, PlatformToolServiceError } from '../src/platform-tool-service'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function response(input: {
  status?: number
  json?: unknown
  text?: string
  bytes?: Uint8Array
  contentType?: string
  contentLength?: number | null
}): Response {
  const bytes = input.bytes ?? Buffer.from(input.text ?? '', 'utf8')
  const headers = new Headers({ 'content-type': input.contentType ?? 'application/json' })
  if (input.contentLength !== null) {
    headers.set('content-length', String(input.contentLength ?? bytes.byteLength))
  }
  return {
    ok: (input.status ?? 200) >= 200 && (input.status ?? 200) < 300,
    status: input.status ?? 200,
    headers,
    json: async () => input.json,
    text: async () => input.text ?? '',
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as Response
}

async function fixture(options: {
  fetch: typeof fetch
  serperKey?: string
  randomUUID?: () => `${string}-${string}-${string}-${string}-${string}`
}) {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-platform-tools-'))
  roots.push(root)
  const artifactStore = new ScopedArtifactStore({ rootDirectory: root })
  const service = new PlatformToolService({
    artifactStore,
    fetch: options.fetch,
    credentials: {
      read: vi.fn(async () =>
        options.serperKey ? { type: 'api_key' as const, key: options.serperKey } : undefined,
      ),
    },
    randomUUID: options.randomUUID ?? (() => ARTIFACT_ID),
  })
  return { artifactStore, service }
}

const context = { documentId: DOCUMENT_ID, runId: RUN_ID }

describe('PlatformToolService', () => {
  it('uses a credential reference for Serper web search and returns bounded source text', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://google.serper.dev/search')
      expect((init?.headers as Record<string, string>)['X-API-KEY']).toBe('secret-key')
      return response({
        json: {
          answerBox: { answer: 'Current answer' },
          organic: [
            { title: 'Source', link: 'https://example.test/page', snippet: 'Evidence' },
            { title: 'Unsafe', link: 'http://127.0.0.1/private', snippet: 'drop me' },
          ],
        },
      })
    }) as typeof fetch
    const { service } = await fixture({ fetch: fetchMock, serperKey: 'secret-key' })

    const result = await service.execute(
      'platform:web_search',
      { query: 'current fact', maxResults: 4 },
      context,
      new AbortController().signal,
    )

    expect(JSON.parse(result.content)).toEqual({
      provider: 'serper',
      answer: 'Current answer',
      results: [{ title: 'Source', url: 'https://example.test/page', snippet: 'Evidence' }],
    })
    expect(result.details).toEqual({
      kind: 'web_search',
      provider: 'serper',
      results: [{ title: 'Source', url: 'https://example.test/page', snippet: 'Evidence' }],
    })
    expect(JSON.stringify(result)).not.toContain('secret-key')
  })

  it('uses explicit DuckDuckGo provider state without a key and decodes safe links', async () => {
    const fetchMock = vi.fn(async () =>
      response({
        contentType: 'text/html',
        text: '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.test%2Fpage">A &amp; B</a>',
      }),
    ) as typeof fetch
    const { service } = await fixture({ fetch: fetchMock })
    const result = await service.execute(
      'platform:web_search',
      { query: 'fallback' },
      context,
      new AbortController().signal,
    )
    expect(JSON.parse(result.content)).toMatchObject({
      provider: 'duckduckgo',
      results: [{ title: 'A & B', url: 'https://example.test/page' }],
    })
  })

  it('drops malformed and local search results while preserving bounded public fallbacks', async () => {
    const unsafeLinks = [
      'not a URL',
      'http://example.test/plain',
      'https://user@example.test/private',
      'https://user:pass@example.test/private',
      'https://example.test:444/private',
      'https://localhost/private',
      'https://sub.localhost/private',
      'https://printer.local/private',
      'https://10.0.0.1/private',
      'https://127.0.0.1/private',
      'https://169.254.1.1/private',
      'https://172.16.0.1/private',
      'https://192.168.0.1/private',
      'https://[::1]/private',
      'https://[fc00::1]/private',
      'https://[fd00::1]/private',
    ]
    const publicIps = [
      'https://169.1.1.1/public',
      'https://172.15.0.1/public',
      'https://172.32.0.1/public',
      'https://192.1.0.1/public',
    ]
    const organic = [
      ...unsafeLinks.map((link) => ({ title: 'Unsafe', link })),
      ...publicIps.map((url) => ({ title: 'Public', url })),
      { title: 123, link: 'https://example.test/no-title' },
      null,
      [],
      'bad',
      { title: ` ${'a'.repeat(2_100)}\0 `, link: 'https://example.test/page#fragment' },
    ]
    const fetchMock = vi.fn(async () =>
      response({
        json: {
          answerBox: { snippet: 'Snippet answer' },
          organic,
        },
      }),
    ) as typeof fetch
    const { service } = await fixture({ fetch: fetchMock, serperKey: 'secret-key' })

    const result = await service.execute(
      'platform:web_search',
      { query: 'sanitize', maxResults: 10 },
      context,
      new AbortController().signal,
    )
    const content = JSON.parse(result.content) as {
      answer: string
      results: Array<{ title: string; url: string }>
    }
    expect(content.answer).toBe('Snippet answer')
    expect(content.results).toHaveLength(5)
    expect(content.results.at(-1)).toMatchObject({
      title: 'a'.repeat(1_999),
      url: 'https://example.test/page',
    })
  })

  it('accepts an answer from the knowledge graph and handles non-array provider data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({ json: { answerBox: null, knowledgeGraph: { description: 'Graph answer' } } }),
      )
      .mockResolvedValueOnce(response({ json: null })) as typeof fetch
    const { service } = await fixture({ fetch: fetchMock, serperKey: 'secret-key' })
    const first = await service.execute(
      'platform:web_search',
      { query: 'graph' },
      context,
      new AbortController().signal,
    )
    const second = await service.execute(
      'platform:web_search',
      { query: 'empty' },
      context,
      new AbortController().signal,
    )
    expect(JSON.parse(first.content)).toMatchObject({ answer: 'Graph answer', results: [] })
    expect(JSON.parse(second.content)).toEqual({ provider: 'serper', results: [] })
  })

  it('bounds DuckDuckGo results and rejects broken redirects and empty titles', async () => {
    const html = [
      '<a class="result__a" href="/l/?uddg=%E0%A4%A">Broken</a>',
      '<a class="result__a" href="https://example.test/empty"><span></span></a>',
      '<a class="result__a" href="https://example.test/direct"><b>Direct</b> &#x27;A&#x27; &quot;B&quot;</a>',
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.test%2Flast">Last</a>',
    ].join('')
    const { service } = await fixture({
      fetch: vi.fn(async () => response({ contentType: 'text/html', text: html })) as typeof fetch,
    })
    const result = await service.execute(
      'platform:web_search',
      { query: 'fallback', maxResults: 1 },
      context,
      new AbortController().signal,
    )
    expect(JSON.parse(result.content).results).toEqual([
      { title: 'Direct \'A\' "B"', url: 'https://example.test/direct', snippet: '' },
    ])
  })

  it('artifacts safe PNG image results and keeps remote image URLs out of content/details', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === 'https://google.serper.dev/images') {
        return response({
          json: {
            images: [
              {
                title: 'Red panda',
                imageUrl: 'https://cdn.example.test/red-panda.png',
                link: 'https://example.test/red-panda',
                source: 'Example',
              },
              {
                title: 'Private',
                imageUrl: 'https://127.0.0.1/private.png',
                link: 'https://example.test/private',
              },
            ],
          },
        })
      }
      expect(String(url)).toBe('https://cdn.example.test/red-panda.png')
      return response({ bytes: PNG, contentType: 'image/png' })
    }) as typeof fetch
    const { artifactStore, service } = await fixture({
      fetch: fetchMock,
      serperKey: 'secret-key',
    })
    const result = await service.execute(
      'platform:image_search',
      { query: 'red panda', maxResults: 4 },
      context,
      new AbortController().signal,
    )

    expect(JSON.parse(result.content)).toMatchObject({
      provider: 'serper',
      images: [
        {
          artifactId: ARTIFACT_ID,
          title: 'Red panda',
          sourceUrl: 'https://example.test/red-panda',
        },
      ],
    })
    expect(result.details).toMatchObject({
      kind: 'image_search',
      images: [{ artifactId: ARTIFACT_ID, width: 1, height: 1 }],
    })
    expect(JSON.stringify(result)).not.toContain('cdn.example.test')
    await expect(
      artifactStore.openImage({ artifactId: ARTIFACT_ID, ...context }),
    ).resolves.toMatchObject({ width: 1, height: 1 })
  })

  it('uses DuckDuckGo image discovery and skips invalid candidates and downloads', async () => {
    const oversized = 20 * 1024 * 1024 + 1
    const fetchMock = vi.fn(async (url: string | URL) => {
      const value = String(url)
      if (value.startsWith('https://duckduckgo.com/?q=')) {
        return response({ contentType: 'text/html', text: '<script>vqd="123-456"</script>' })
      }
      if (value.startsWith('https://duckduckgo.com/i.js?')) {
        return response({
          json: {
            results: [
              { title: 'Copyright', image: 'https://gettyimages.example.test/one.png' },
              { title: '', image: 'https://cdn.example.test/not-png.jpg', url: 'bad source' },
              { original: 'https://cdn.example.test/too-large.png' },
              { image: 'https://cdn.example.test/bad-signature.png' },
              {
                title: 'Good',
                image: 'https://cdn.example.test/good.png',
                url: 'https://example.test/source',
              },
            ],
          },
        })
      }
      if (value.endsWith('not-png.jpg')) {
        return response({ bytes: PNG, contentType: 'image/jpeg', contentLength: null })
      }
      if (value.endsWith('too-large.png')) {
        return response({ bytes: PNG, contentType: 'image/png', contentLength: oversized })
      }
      if (value.endsWith('bad-signature.png')) {
        return response({ bytes: Buffer.alloc(24), contentType: 'image/png' })
      }
      return response({ bytes: PNG, contentType: 'image/png' })
    }) as typeof fetch
    const { service } = await fixture({ fetch: fetchMock })

    const result = await service.execute(
      'platform:image_search',
      { query: 'duck images' },
      context,
      new AbortController().signal,
    )
    expect(JSON.parse(result.content)).toMatchObject({
      provider: 'duckduckgo',
      images: [{ title: 'Good', artifactId: ARTIFACT_ID }],
    })
  })

  it('returns search_unavailable when DuckDuckGo omits its image token or results', async () => {
    const missingToken = await fixture({
      fetch: vi.fn(async () =>
        response({ contentType: 'text/html', text: '<html></html>' }),
      ) as typeof fetch,
    })
    await expect(
      missingToken.service.execute(
        'platform:image_search',
        { query: 'no token' },
        context,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new PlatformToolServiceError('search_unavailable'))

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ contentType: 'text/html', text: 'vqd=123-456' }))
      .mockResolvedValueOnce(response({ json: { results: null } })) as typeof fetch
    const empty = await fixture({ fetch: fetchMock })
    await expect(
      empty.service.execute(
        'platform:image_search',
        { query: 'empty' },
        context,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      details: { kind: 'image_search', provider: 'duckduckgo', images: [] },
    })
  })

  it('skips failed image downloads but propagates cancellation', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) === 'https://google.serper.dev/images') {
        return response({
          json: {
            images: [
              { imageUrl: 'https://cdn.example.test/offline.png' },
              { imageUrl: 'https://cdn.example.test/abort.png' },
            ],
          },
        })
      }
      if (String(url).endsWith('offline.png')) throw new Error('offline')
      controller.abort()
      expect(init?.signal?.aborted).toBe(true)
      throw new Error('aborted')
    }) as typeof fetch
    const { service } = await fixture({ fetch: fetchMock, serperKey: 'secret-key' })
    await expect(
      service.execute('platform:image_search', { query: 'cancel' }, context, controller.signal),
    ).rejects.toEqual(new PlatformToolServiceError('platform_tool_aborted'))
  })

  it('reads text attachment pages through the current document/run scope', async () => {
    const { artifactStore, service } = await fixture({
      fetch: vi.fn() as unknown as typeof fetch,
    })
    await artifactStore.registerText({
      artifactId: ARTIFACT_ID,
      ...context,
      text: `${'x'.repeat(24_000)}tail`,
      mediaType: 'text/plain',
      displayName: 'notes.txt',
    })
    const result = await service.execute(
      'platform:artifact:read_text',
      { artifactId: ARTIFACT_ID, offset: 24_000 },
      context,
      new AbortController().signal,
    )
    expect(result.content).toBe('tail')
    expect(result.details).toEqual({
      kind: 'artifact_text',
      artifactId: ARTIFACT_ID,
      displayName: 'notes.txt',
      offset: 24_000,
      totalCharacters: 24_004,
    })
  })

  it('returns attachment pagination and maps invalid or cancelled reads', async () => {
    const controller = new AbortController()
    const readText = vi
      .fn()
      .mockResolvedValueOnce({
        artifact: { artifactId: ARTIFACT_ID },
        text: 'page',
        offset: 0,
        nextOffset: 4,
        totalCharacters: 8,
      })
      .mockRejectedValueOnce(new Error('scope mismatch'))
      .mockImplementationOnce(async () => {
        controller.abort()
        return {
          artifact: { artifactId: ARTIFACT_ID },
          text: 'late',
          offset: 0,
          totalCharacters: 4,
        }
      })
    const service = new PlatformToolService({
      artifactStore: { readText, registerImage: vi.fn() },
      credentials: { read: vi.fn() },
      fetch: vi.fn() as unknown as typeof fetch,
    })
    const signal = new AbortController().signal
    await expect(
      service.execute('platform:artifact:read_text', { artifactId: ARTIFACT_ID }, context, signal),
    ).resolves.toMatchObject({
      details: { offset: 0, nextOffset: 4, totalCharacters: 8 },
    })
    await expect(
      service.execute('platform:artifact:read_text', { artifactId: ARTIFACT_ID }, context, signal),
    ).rejects.toEqual(new PlatformToolServiceError('artifact_invalid'))
    await expect(
      service.execute(
        'platform:artifact:read_text',
        { artifactId: ARTIFACT_ID },
        context,
        controller.signal,
      ),
    ).rejects.toEqual(new PlatformToolServiceError('platform_tool_aborted'))
  })

  it('propagates Abort and reports network failure instead of an empty result', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const { service } = await fixture({ fetch: vi.fn() as unknown as typeof fetch })
    await expect(
      service.execute('platform:web_search', { query: 'q' }, context, aborted.signal),
    ).rejects.toEqual(new PlatformToolServiceError('platform_tool_aborted'))

    const failing = await fixture({
      fetch: vi.fn(async () => {
        throw new Error('offline')
      }) as typeof fetch,
    })
    await expect(
      failing.service.execute(
        'platform:web_search',
        { query: 'q' },
        context,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new PlatformToolServiceError('search_unavailable'))
  })

  it('maps credential, HTTP, and in-flight abort failures without leaking causes', async () => {
    const credentialFailure = new PlatformToolService({
      artifactStore: { readText: vi.fn(), registerImage: vi.fn() },
      credentials: { read: vi.fn(async () => Promise.reject(new Error('keychain failed'))) },
      fetch: vi.fn() as unknown as typeof fetch,
    })
    await expect(
      credentialFailure.execute(
        'platform:web_search',
        { query: 'q' },
        context,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new PlatformToolServiceError('search_unavailable'))

    const httpFailure = await fixture({
      fetch: vi.fn(async () => response({ status: 503 })) as typeof fetch,
    })
    await expect(
      httpFailure.service.execute(
        'platform:web_search',
        { query: 'q' },
        context,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new PlatformToolServiceError('search_unavailable'))

    const controller = new AbortController()
    const inFlight = await fixture({
      fetch: vi.fn(async (_url, init) => {
        controller.abort()
        expect(init?.signal?.aborted).toBe(true)
        throw new Error('aborted')
      }) as typeof fetch,
    })
    await expect(
      inFlight.service.execute('platform:web_search', { query: 'q' }, context, controller.signal),
    ).rejects.toEqual(new PlatformToolServiceError('platform_tool_aborted'))
  })

  it('maps an aborted credential read and preserves an intentional service error from fetch', async () => {
    const controller = new AbortController()
    const credentialAbort = new PlatformToolService({
      artifactStore: { readText: vi.fn(), registerImage: vi.fn() },
      credentials: {
        read: vi.fn(async () => {
          controller.abort()
          throw new Error('aborted')
        }),
      },
      fetch: vi.fn() as unknown as typeof fetch,
    })
    await expect(
      credentialAbort.execute('platform:web_search', { query: 'q' }, context, controller.signal),
    ).rejects.toEqual(new PlatformToolServiceError('platform_tool_aborted'))

    const preserved = await fixture({
      fetch: vi.fn(async () => {
        throw new PlatformToolServiceError('search_unavailable')
      }) as typeof fetch,
    })
    await expect(
      preserved.service.execute(
        'platform:web_search',
        { query: 'q' },
        context,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new PlatformToolServiceError('search_unavailable'))
  })

  it('revalidates schemas at execution and rejects unknown tools', async () => {
    const { service } = await fixture({ fetch: vi.fn() as unknown as typeof fetch })
    await expect(
      service.execute(
        'platform:web_search',
        { query: 'q', path: '/tmp/private' },
        context,
        new AbortController().signal,
      ),
    ).rejects.toEqual(new PlatformToolServiceError('invalid_tool_arguments'))
    await expect(
      service.execute('platform:unknown', {}, context, new AbortController().signal),
    ).rejects.toEqual(new PlatformToolServiceError('tool_not_in_snapshot'))
  })
})
