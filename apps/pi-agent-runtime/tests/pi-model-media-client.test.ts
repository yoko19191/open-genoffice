import { describe, expect, it, vi } from 'vitest'
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { PiModelMediaClient } from '../src/pi-model-media-client'

const documentId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const artifact = {
  artifactId: '33333333-3333-4333-8333-333333333333',
  mediaType: 'image/png' as const,
  byteLength: 24,
  sha256: 'a'.repeat(64),
}
const model = {
  provider: 'selected-provider',
  id: 'selected-model',
  input: ['text', 'image'],
} as Model<Api>

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'analysis' }],
    api: 'openai-completions',
    provider: 'selected-provider',
    model: 'selected-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
    ...overrides,
  }
}

function fixture(response = message()) {
  const completeSimple = vi.fn().mockResolvedValue(response)
  const openImage = vi.fn().mockResolvedValue({ artifact, bytes: Buffer.from('png') })
  const client = new PiModelMediaClient({
    modelRuntime: { completeSimple },
    resolveModel: (providerId, modelId) =>
      providerId === model.provider && modelId === model.id ? model : undefined,
    artifactStore: { openImage },
    now: () => 42,
  })
  return { client, completeSimple, openImage }
}

describe('PiModelMediaClient', () => {
  it('sends only scope-verified PNG inputs to the exact selected Pi model with retries disabled', async () => {
    const { client, completeSimple, openImage } = fixture()
    const result = await client.analyzeImages(
      {
        model: {
          providerId: model.provider,
          modelId: model.id,
          capabilities: ['image-input'],
        },
        documentId,
        runId,
        requirements: 'Describe the frames.',
        inputMode: 'frames',
        artifacts: [artifact],
        timestampsMs: [500],
      },
      new AbortController().signal,
    )

    expect(openImage).toHaveBeenCalledWith({ artifactId: artifact.artifactId, documentId, runId })
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              expect.objectContaining({ text: expect.stringContaining('500') }),
              { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
            ],
            timestamp: 42,
          }),
        ],
      }),
      { signal: expect.any(AbortSignal), maxRetries: 0 },
    )
    expect(result).toEqual({ text: 'analysis', usageRecorded: true })
    expect(
      client.supportsNative(
        { providerId: model.provider, modelId: model.id, capabilities: [] },
        'audio',
      ),
    ).toBe(false)
    await expect(client.analyzeNative()).rejects.toThrow('media_native_transport_unavailable')
  })

  it.each([
    ['missing model', { providerId: 'other', modelId: model.id, capabilities: [] }, artifact],
    [
      'wrong media type',
      { providerId: model.provider, modelId: model.id, capabilities: [] },
      { ...artifact, mediaType: 'video/mp4' },
    ],
    [
      'tampered ref',
      { providerId: model.provider, modelId: model.id, capabilities: [] },
      { ...artifact, sha256: 'b'.repeat(64) },
    ],
  ])('rejects %s before a model request', async (_label, selected, inputArtifact) => {
    const { client, completeSimple } = fixture()
    await expect(
      client.analyzeImages(
        {
          model: selected,
          documentId,
          runId,
          requirements: 'Analyze.',
          inputMode: 'image',
          artifacts: [inputArtifact],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(completeSimple).not.toHaveBeenCalled()
  })

  it.each([
    message({ provider: 'other' }),
    message({ model: 'other' }),
    message({ stopReason: 'error', content: [{ type: 'text', text: 'failed' }] }),
    message({ content: [] }),
  ])('rejects mismatched or failed provider result %#', async (response) => {
    const { client } = fixture(response)
    await expect(
      client.analyzeImages(
        {
          model: { providerId: model.provider, modelId: model.id, capabilities: [] },
          documentId,
          runId,
          requirements: 'Analyze.',
          inputMode: 'image',
          artifacts: [artifact],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('media_provider_failed')
  })

  it('accepts a display name and image mode without timestamp context', async () => {
    const named = { ...artifact, displayName: 'frame.png' }
    const { client, completeSimple, openImage } = fixture(
      message({
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: ' first ' },
          { type: 'text', text: 'second' },
        ],
      }),
    )
    openImage.mockResolvedValueOnce({ artifact: named, bytes: Buffer.from('png') })
    await expect(
      client.analyzeImages(
        {
          model: { providerId: model.provider, modelId: model.id, capabilities: [] },
          documentId,
          runId,
          requirements: 'Describe.',
          inputMode: 'image',
          artifacts: [named],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: 'first \nsecond', usageRecorded: true })
    expect(completeSimple.mock.calls[0]![1].messages[0].content[0].text).toBe('Describe.')
  })

  it.each([[[]], [Array.from({ length: 13 }, () => artifact)]])(
    'rejects an invalid image count before resolving a model',
    async (artifacts) => {
      const { client, completeSimple } = fixture()
      await expect(
        client.analyzeImages(
          {
            model: { providerId: model.provider, modelId: model.id, capabilities: [] },
            documentId,
            runId,
            requirements: 'Analyze.',
            inputMode: 'frames',
            artifacts,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow('media_input_invalid')
      expect(completeSimple).not.toHaveBeenCalled()
    },
  )

  it('maps an aborted Pi response and an already-aborted signal', async () => {
    const abortedResponse = fixture(message({ stopReason: 'aborted' }))
    await expect(
      abortedResponse.client.analyzeImages(
        {
          model: { providerId: model.provider, modelId: model.id, capabilities: [] },
          documentId,
          runId,
          requirements: 'Analyze.',
          inputMode: 'image',
          artifacts: [artifact],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('media_provider_failed')

    const controller = new AbortController()
    controller.abort()
    const signaled = fixture()
    await expect(
      signaled.client.analyzeImages(
        {
          model: { providerId: model.provider, modelId: model.id, capabilities: [] },
          documentId,
          runId,
          requirements: 'Analyze.',
          inputMode: 'image',
          artifacts: [artifact],
        },
        controller.signal,
      ),
    ).rejects.toThrow('media_aborted')
  })

  it('uses production time by default and propagates an artifact-store failure', async () => {
    const completeSimple = vi.fn()
    const client = new PiModelMediaClient({
      modelRuntime: { completeSimple },
      resolveModel: () => model,
      artifactStore: { openImage: vi.fn().mockRejectedValue(new Error('missing')) },
    })
    await expect(
      client.analyzeImages(
        {
          model: { providerId: model.provider, modelId: model.id, capabilities: [] },
          documentId,
          runId,
          requirements: 'Analyze.',
          inputMode: 'image',
          artifacts: [artifact],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('missing')
    expect(completeSimple).not.toHaveBeenCalled()
  })
})
