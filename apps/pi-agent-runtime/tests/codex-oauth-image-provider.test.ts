import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthResult } from '@earendil-works/pi-ai'
import {
  CodexOAuthImageProvider,
  CodexOAuthImageProviderError,
} from '../src/codex-oauth-image-provider'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const VALID_INPUT = {
  operationId: '22222222-2222-4222-8222-222222222222',
  documentId: '33333333-3333-4333-8333-333333333333',
  runId: '44444444-4444-4444-8444-444444444444',
  prompt: 'draw',
}
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'genoffice-codex-image-'))
  roots.push(value)
  return value
}

function sse(events: unknown[], status = 200): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function auth() {
  return {
    auth: {
      headers: {
        Authorization: 'Bearer oauth-secret',
        'chatgpt-account-id': 'account-secret',
      },
    },
    source: 'OAuth',
  }
}

function completed(base64 = PNG_BASE64) {
  return {
    type: 'response.completed',
    response: {
      output: [{ type: 'image_generation_call', result: base64 }],
      tool_usage: { image_gen: { input_tokens: 4, output_tokens: 8, total_tokens: 12 } },
    },
  }
}

describe('CodexOAuthImageProvider', () => {
  it('uses the fixed Responses image contract and atomically returns an opaque verified ArtifactRef', async () => {
    const storage = await root()
    const getAuth = vi.fn(async (_providerId: string, _options?: object) => auth())
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => sse([completed()]))
    const provider = new CodexOAuthImageProvider({
      rootDirectory: storage,
      modelRuntime: { getAuth, isUsingOAuth: () => true },
      fetch,
      createId: () => '11111111-1111-4111-8111-111111111111',
    })

    const result = await provider.generate({
      operationId: '22222222-2222-4222-8222-222222222222',
      documentId: '33333333-3333-4333-8333-333333333333',
      runId: '44444444-4444-4444-8444-444444444444',
      prompt: 'private prompt',
    })

    expect(getAuth).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: true,
      tool_choice: { type: 'image_generation' },
      tools: [{ type: 'image_generation', action: 'generate', model: 'gpt-image-2' }],
    })
    expect(body.tools[0]).not.toHaveProperty('n')
    expect(init?.redirect).toBe('error')
    expect(result).toMatchObject({
      artifact: {
        artifactId: '11111111-1111-4111-8111-111111111111',
        mediaType: 'image/png',
        byteLength: 68,
        displayName: 'generated-image.png',
      },
      width: 1,
      height: 1,
      usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
    })
    expect(result.artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(provider.artifactPath(result.artifact.artifactId))).toEqual(
      Buffer.from(PNG_BASE64, 'base64'),
    )
    expect(JSON.stringify(result)).not.toContain('private prompt')
    expect(JSON.stringify(result)).not.toContain('oauth-secret')
    expect(JSON.stringify(result)).not.toContain(PNG_BASE64)
  })

  it('refreshes once on a pre-image 401, but never retries after a partial image event', async () => {
    const storage = await root()
    const getAuth = vi.fn(async (_providerId: string, _options?: object) => auth())
    const preImageFetch = vi
      .fn(async (_input: string, _init: RequestInit) => new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(sse([completed()]))
    const provider = new CodexOAuthImageProvider({
      rootDirectory: storage,
      modelRuntime: { getAuth, isUsingOAuth: () => true },
      fetch: preImageFetch,
    })
    await expect(
      provider.generate({
        operationId: '22222222-2222-4222-8222-222222222222',
        documentId: '33333333-3333-4333-8333-333333333333',
        runId: '44444444-4444-4444-8444-444444444444',
        prompt: 'draw',
      }),
    ).resolves.toMatchObject({ width: 1, height: 1 })
    expect(preImageFetch).toHaveBeenCalledTimes(2)
    expect(getAuth.mock.calls[1]?.[1]).toMatchObject({ minOAuthValidityMs: expect.any(Number) })

    const partialFetch = vi.fn(async () =>
      sse([
        { type: 'response.image_generation_call.partial_image', partial_image_b64: PNG_BASE64 },
        { type: 'response.failed', response: { error: { code: 'unauthorized' } } },
      ]),
    )
    const partialProvider = new CodexOAuthImageProvider({
      rootDirectory: storage,
      modelRuntime: { getAuth, isUsingOAuth: () => true },
      fetch: partialFetch,
    })
    await expect(
      partialProvider.generate({
        operationId: '55555555-5555-4555-8555-555555555555',
        documentId: '33333333-3333-4333-8333-333333333333',
        runId: '44444444-4444-4444-8444-444444444444',
        prompt: 'draw',
      }),
    ).rejects.toMatchObject({ code: 'provider_partial_image' })
    expect(partialFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    [429, 'provider_usage_limited'],
    [400, 'provider_contract_incompatible'],
    [422, 'provider_contract_incompatible'],
    [403, 'provider_auth_required'],
    [500, 'provider_unavailable'],
  ] as const)('maps HTTP %s without exposing the response body', async (status, code) => {
    const provider = new CodexOAuthImageProvider({
      rootDirectory: await root(),
      modelRuntime: { getAuth: async () => auth(), isUsingOAuth: () => true },
      fetch: async () => new Response('private remote body', { status }),
    })
    await expect(
      provider.generate({
        operationId: '22222222-2222-4222-8222-222222222222',
        documentId: '33333333-3333-4333-8333-333333333333',
        runId: '44444444-4444-4444-8444-444444444444',
        prompt: 'draw',
      }),
    ).rejects.toEqual(new CodexOAuthImageProviderError(code))
  })

  it('fails closed for missing OAuth, malformed final images, missing final output and Abort', async () => {
    const storage = await root()
    const input = {
      operationId: '22222222-2222-4222-8222-222222222222',
      documentId: '33333333-3333-4333-8333-333333333333',
      runId: '44444444-4444-4444-8444-444444444444',
      prompt: 'draw',
    }
    await expect(
      new CodexOAuthImageProvider({
        rootDirectory: storage,
        modelRuntime: { getAuth: async () => undefined, isUsingOAuth: () => false },
      }).generate(input),
    ).rejects.toMatchObject({ code: 'provider_auth_required' })
    await expect(
      new CodexOAuthImageProvider({
        rootDirectory: storage,
        modelRuntime: { getAuth: async () => auth(), isUsingOAuth: () => true },
        fetch: async () => sse([completed(Buffer.from('not-image').toString('base64'))]),
      }).generate(input),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
    await expect(
      new CodexOAuthImageProvider({
        rootDirectory: storage,
        modelRuntime: { getAuth: async () => auth(), isUsingOAuth: () => true },
        fetch: async () => sse([{ type: 'response.completed', response: { output: [] } }]),
      }).generate(input),
    ).rejects.toMatchObject({ code: 'provider_contract_incompatible' })

    const controller = new AbortController()
    controller.abort()
    await expect(
      new CodexOAuthImageProvider({
        rootDirectory: storage,
        modelRuntime: { getAuth: async () => auth(), isUsingOAuth: () => true },
      }).generate(input, controller.signal),
    ).rejects.toMatchObject({ code: 'provider_request_aborted' })
  })

  it('accepts only a final image item while ignoring malformed and partial stream records', async () => {
    const noisy = [
      'event: ping',
      '',
      'data:',
      '',
      'data: [DONE]',
      '',
      'data: {',
      '',
      'data: []',
      '',
      `data: ${JSON.stringify({ type: 'response.image_generation_call.partial_image', partial_image_b64: PNG_BASE64 })}`,
      '',
      `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'message' } })}`,
      '',
      `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG_BASE64 } })}`,
      '',
      `data: ${JSON.stringify({ type: 'response.completed', response: { output: 'invalid', tool_usage: { image_gen: { input_tokens: -1 } } } })}`,
      '',
    ].join('\n')
    const provider = new CodexOAuthImageProvider({
      rootDirectory: await root(),
      modelRuntime: { getAuth: async () => auth(), isUsingOAuth: () => true },
      fetch: async () => new Response(noisy),
    })
    await expect(provider.generate(VALID_INPUT)).resolves.toMatchObject({
      width: 1,
      height: 1,
    })
  })

  it.each([
    [{ ...VALID_INPUT, operationId: 'bad' }],
    [{ ...VALID_INPUT, documentId: 'bad' }],
    [{ ...VALID_INPUT, runId: 'bad' }],
    [{ ...VALID_INPUT, prompt: '   ' }],
    [{ ...VALID_INPUT, prompt: 'x'.repeat(16_001) }],
  ])('rejects malformed operation scope before auth or network', async (input) => {
    const getAuth = vi.fn(async () => auth())
    const fetch = vi.fn(async () => sse([completed()]))
    const provider = new CodexOAuthImageProvider({
      rootDirectory: await root(),
      modelRuntime: { getAuth, isUsingOAuth: () => true },
      fetch,
    })
    await expect(provider.generate(input)).rejects.toMatchObject({
      code: 'provider_contract_incompatible',
    })
    expect(getAuth).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects invalid artifact identities, base64, PNG dimensions and missing streams', async () => {
    const storage = await root()
    const build = (response: () => Promise<Response>) =>
      new CodexOAuthImageProvider({
        rootDirectory: storage,
        modelRuntime: { getAuth: async () => auth(), isUsingOAuth: () => true },
        fetch: response,
      })
    expect(() => build(async () => sse([completed()])).artifactPath('bad')).toThrow(
      'artifact_invalid',
    )
    await expect(
      build(async () => sse([completed('not base64!')])).generate(VALID_INPUT),
    ).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
    const zeroWidth = Buffer.from(PNG_BASE64, 'base64')
    zeroWidth.writeUInt32BE(0, 16)
    await expect(
      build(async () => sse([completed(zeroWidth.toString('base64'))])).generate(VALID_INPUT),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
    const hugeHeight = Buffer.from(PNG_BASE64, 'base64')
    hugeHeight.writeUInt32BE(16_385, 20)
    await expect(
      build(async () => sse([completed(hugeHeight.toString('base64'))])).generate(VALID_INPUT),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
    await expect(build(async () => new Response(null)).generate(VALID_INPUT)).rejects.toMatchObject(
      {
        code: 'provider_contract_incompatible',
      },
    )
  })

  it('normalizes stream failures, missing auth headers, transport Abort and atomic write failure', async () => {
    const storage = await root()
    const provider = (options: {
      getAuth?: () => Promise<AuthResult | undefined>
      fetch?: () => Promise<Response>
      createId?: () => string
    }) =>
      new CodexOAuthImageProvider({
        rootDirectory: storage,
        modelRuntime: {
          getAuth: options.getAuth ?? (async () => auth()),
          isUsingOAuth: () => true,
        },
        fetch: options.fetch,
        createId: options.createId,
      })

    await expect(
      provider({ fetch: async () => sse([{ type: 'response.failed' }]) }).generate(VALID_INPUT),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    await expect(
      provider({ getAuth: async () => ({ auth: {}, source: 'OAuth' }) }).generate(VALID_INPUT),
    ).rejects.toMatchObject({ code: 'provider_auth_required' })
    await expect(
      provider({ getAuth: async () => ({ ...auth(), source: 'API key' }) }).generate(VALID_INPUT),
    ).rejects.toMatchObject({ code: 'provider_auth_required' })
    await expect(
      provider({
        fetch: async () => {
          throw new DOMException('aborted', 'AbortError')
        },
      }).generate(VALID_INPUT),
    ).rejects.toMatchObject({ code: 'provider_request_aborted' })
    await expect(
      provider({
        fetch: async () => Promise.reject(new Error('private transport failure')),
      }).generate(VALID_INPUT),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })

    const artifactId = '11111111-1111-4111-8111-111111111111'
    const writeFailure = provider({
      fetch: async () => sse([completed()]),
      createId: () => artifactId,
    })
    const temporary = `${writeFailure.artifactPath(artifactId)}.${VALID_INPUT.operationId}.tmp`
    await mkdir(dirname(temporary), { recursive: true })
    await writeFile(temporary, 'occupied')
    await expect(writeFailure.generate(VALID_INPUT)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
  })
})
