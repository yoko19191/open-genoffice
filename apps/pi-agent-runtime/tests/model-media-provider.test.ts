import { describe, expect, it, vi } from 'vitest'
import {
  ModelMediaProvider,
  ModelMediaProviderError,
  type ModelMediaClient,
} from '../src/model-media-provider'

const documentId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const artifactId = '44444444-4444-4444-8444-444444444444'

function artifact(mediaType: 'image/png' | 'audio/wav' | 'video/mp4') {
  return { artifactId, mediaType, byteLength: 24, sha256: 'a'.repeat(64), displayName: 'media' }
}

function model(capabilities: string[]) {
  return { providerId: 'user-provider', modelId: 'selected-model', capabilities }
}

function fixture(client: Partial<ModelMediaClient> = {}) {
  const records: Array<{ state: string; providerId: string }> = []
  const prepare = vi.fn().mockImplementation(async (input) => ({
    operationId: input.operationId,
    inputKind: input.artifact.mediaType.startsWith('video/')
      ? 'video'
      : input.artifact.mediaType.startsWith('audio/')
        ? 'audio'
        : 'image',
    strategy: input.strategy,
    artifacts: [artifact(input.strategy === 'frames' ? 'image/png' : input.artifact.mediaType)],
    ...(input.strategy === 'frames' ? { durationMs: 2_000, timestampsMs: [500] } : {}),
  }))
  const mediaClient: ModelMediaClient = {
    supportsNative: client.supportsNative ?? (() => false),
    analyzeImages:
      client.analyzeImages ??
      vi.fn().mockResolvedValue({ text: 'image analysis', usageRecorded: true }),
    analyzeNative:
      client.analyzeNative ??
      vi.fn().mockResolvedValue({ text: 'native analysis', usageRecorded: true }),
  }
  const provider = new ModelMediaProvider({
    operationStore: {
      commit: vi.fn().mockImplementation(async (record) => {
        records.push({ state: record.state, providerId: record.providerId })
        return record
      }),
    },
    prepare,
    client: mediaClient,
    now: () => '2026-08-10T00:00:00.000Z',
  })
  return { provider, prepare, mediaClient, records }
}

describe('ModelMediaProvider', () => {
  it('routes image-only input by explicit capability and returns provider/model/tool provenance', async () => {
    const { provider, prepare, mediaClient, records } = fixture()
    const result = await provider.analyze(
      {
        operationId,
        documentId,
        runId,
        artifact: artifact('image/png'),
        requirements: 'Describe the image.',
        model: model(['text-input', 'image-input']),
      },
      new AbortController().signal,
    )

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'image' }),
      expect.any(AbortSignal),
    )
    expect(mediaClient.analyzeImages).toHaveBeenCalledOnce()
    expect(result).toEqual({
      text: 'image analysis',
      details: {
        operationId,
        providerId: 'user-provider',
        modelId: 'selected-model',
        toolId: 'platform:analyze_media',
        inputMode: 'image',
        sourceArtifactId: artifactId,
        usageRecorded: true,
      },
    })
    expect(records.map(({ state }) => state)).toEqual([
      'preparing',
      'dispatched',
      'running',
      'completed',
    ])
    expect(records.every(({ providerId }) => providerId === 'user-provider')).toBe(true)
  })

  it('uses the same selected provider native adapter only when capability and transport agree', async () => {
    const analyzeNative = vi.fn().mockResolvedValue({ text: 'native video', usageRecorded: true })
    const { provider, prepare } = fixture({
      supportsNative: (_model, kind) => kind === 'video',
      analyzeNative,
    })

    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('video/mp4'),
          requirements: 'Summarize the video.',
          model: model(['text-input', 'video-input']),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ text: 'native video', details: { inputMode: 'native-video' } })
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'native' }),
      expect.any(AbortSignal),
    )
    expect(analyzeNative).toHaveBeenCalledWith(
      expect.objectContaining({ model: model(['text-input', 'video-input']), inputKind: 'video' }),
      expect.any(AbortSignal),
    )
  })

  it('falls back to deterministic frames for the same image-capable model', async () => {
    const { provider, prepare, mediaClient } = fixture()
    const result = await provider.analyze(
      {
        operationId,
        documentId,
        runId,
        artifact: artifact('video/mp4'),
        requirements: 'Find the main scenes.',
        model: model(['text-input', 'image-input']),
      },
      new AbortController().signal,
    )

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'frames' }),
      expect.any(AbortSignal),
    )
    expect(mediaClient.analyzeImages).toHaveBeenCalledWith(
      expect.objectContaining({ model: model(['text-input', 'image-input']), inputMode: 'frames' }),
      expect.any(AbortSignal),
    )
    expect(result.details.inputMode).toBe('frames')
  })

  it.each([
    ['image without image capability', artifact('image/png'), ['text-input']],
    ['audio without audio capability', artifact('audio/wav'), ['text-input']],
    ['video without native transport or image fallback', artifact('video/mp4'), ['video-input']],
  ])('returns a disabled/change-model action for %s', async (_label, media, capabilities) => {
    const { provider, prepare } = fixture()
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: media,
          requirements: 'Analyze it.',
          model: model(capabilities),
        },
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      new ModelMediaProviderError('media_capability_unsupported', {
        state: 'disabled',
        action: 'change_model',
        providerId: 'user-provider',
        modelId: 'selected-model',
      }),
    )
    expect(prepare).not.toHaveBeenCalled()
  })

  it('aborts both preparation and the current model request without retrying', async () => {
    const controller = new AbortController()
    const analyzeImages = vi.fn().mockImplementation(async (_input, signal: AbortSignal) => {
      controller.abort()
      await Promise.resolve()
      if (signal.aborted) throw signal.reason
      return { text: 'unexpected', usageRecorded: false }
    })
    const { provider, records } = fixture({ analyzeImages })

    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('image/png'),
          requirements: 'Describe it.',
          model: model(['image-input']),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'media_aborted' })
    expect(analyzeImages).toHaveBeenCalledOnce()
    expect(records.at(-1)?.state).toBe('cancelled_local')
  })

  it('routes native audio and omits an unavailable duration', async () => {
    const analyzeNative = vi.fn().mockResolvedValue({ text: 'native audio', usageRecorded: false })
    const { provider, prepare } = fixture({ supportsNative: () => true, analyzeNative })
    prepare.mockResolvedValueOnce({
      operationId,
      inputKind: 'audio',
      strategy: 'native',
      artifacts: [artifact('audio/wav')],
    })
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('audio/wav'),
          requirements: 'Transcribe the important points.',
          model: model(['audio-input']),
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      text: 'native audio',
      details: { inputMode: 'native-audio', usageRecorded: false },
    })
    expect(analyzeNative).toHaveBeenCalledWith(
      expect.not.objectContaining({ durationMs: expect.anything() }),
      expect.any(AbortSignal),
    )
  })

  it('omits frame timestamps when preparation does not provide them', async () => {
    const { provider, prepare, mediaClient } = fixture()
    prepare.mockResolvedValueOnce({
      operationId,
      inputKind: 'video',
      strategy: 'frames',
      artifacts: [artifact('image/png')],
      durationMs: 2_000,
    })
    await provider.analyze(
      {
        operationId,
        documentId,
        runId,
        artifact: artifact('video/mp4'),
        requirements: 'Summarize.',
        model: model(['image-input']),
      },
      new AbortController().signal,
    )
    expect(mediaClient.analyzeImages).toHaveBeenCalledWith(
      expect.not.objectContaining({ timestampsMs: expect.anything() }),
      expect.any(AbortSignal),
    )
  })

  it.each([
    ['provider', { model: { ...model(['image-input']), providerId: 'bad/provider' } }],
    ['model', { model: { ...model(['image-input']), modelId: '' } }],
    ['requirements', { requirements: '   ' }],
    ['media type', { artifact: { ...artifact('image/png'), mediaType: 'image/jpeg' } }],
    ['byte length', { artifact: { ...artifact('image/png'), byteLength: 0 } }],
  ])('rejects invalid %s before creating an operation', async (_label, override) => {
    const { provider, records } = fixture()
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('image/png'),
          requirements: 'Analyze.',
          model: model(['image-input']),
          ...override,
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_input_invalid' })
    expect(records).toEqual([])
  })

  it('rejects an already-aborted request before creating an operation', async () => {
    const { provider, records } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('image/png'),
          requirements: 'Analyze.',
          model: model(['image-input']),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'media_aborted' })
    expect(records).toEqual([])
  })

  it.each([
    ['empty provider output', vi.fn().mockResolvedValue({ text: '   ', usageRecorded: true })],
    ['provider exception', vi.fn().mockRejectedValue(new Error('offline'))],
  ])('records a terminal failure for %s without retrying', async (_label, analyzeImages) => {
    const { provider, records } = fixture({ analyzeImages })
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('image/png'),
          requirements: 'Analyze.',
          model: model(['image-input']),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_provider_failed' })
    expect(analyzeImages).toHaveBeenCalledOnce()
    expect(records.at(-1)?.state).toBe('failed')
  })

  it('normalizes preparation failure and uses production time defaults when not injected', async () => {
    const commits: Array<{ updatedAt: string; expiresAt: string; errorCode?: string }> = []
    const provider = new ModelMediaProvider({
      operationStore: {
        commit: vi.fn().mockImplementation(async (record) => {
          commits.push(record)
          return record
        }),
      },
      prepare: vi.fn().mockRejectedValue(new Error('disk')),
      client: {
        supportsNative: () => false,
        analyzeImages: vi.fn(),
        analyzeNative: vi.fn(),
      },
      operationTtlMs: 1_000,
    })
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('image/png'),
          requirements: 'Analyze.',
          model: model(['image-input']),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_provider_failed' })
    expect(Date.parse(commits[0]!.expiresAt) - Date.parse(commits[0]!.updatedAt)).toBe(1_000)
    expect(commits.at(-1)?.errorCode).toBe('media_provider_failed')
  })

  it('observes cancellation after preparation returns', async () => {
    const controller = new AbortController()
    const { provider, prepare, mediaClient, records } = fixture()
    prepare.mockImplementationOnce(async (input) => {
      controller.abort()
      return {
        operationId: input.operationId,
        inputKind: 'image',
        strategy: 'image',
        artifacts: [artifact('image/png')],
      }
    })
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('image/png'),
          requirements: 'Analyze.',
          model: model(['image-input']),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'media_aborted' })
    expect(mediaClient.analyzeImages).not.toHaveBeenCalled()
    expect(records.at(-1)?.state).toBe('cancelled_local')
  })

  it('observes cancellation after the selected provider returns', async () => {
    const controller = new AbortController()
    const analyzeImages = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { text: 'late result', usageRecorded: true }
    })
    const { provider, records } = fixture({ analyzeImages })
    await expect(
      provider.analyze(
        {
          operationId,
          documentId,
          runId,
          artifact: artifact('image/png'),
          requirements: 'Analyze.',
          model: model(['image-input']),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'media_aborted' })
    expect(records.at(-1)?.state).toBe('cancelled_local')
  })
})
