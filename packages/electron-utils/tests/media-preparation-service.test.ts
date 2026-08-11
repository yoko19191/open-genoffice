import { describe, expect, it, vi } from 'vitest'
import {
  MediaPreparationService,
  MediaPreparationServiceError,
  type OpenedMediaArtifact,
} from '../src/media-preparation-service'

const documentId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const sourceId = '44444444-4444-4444-8444-444444444444'
const frameId = '55555555-5555-4555-8555-555555555555'

function wav(durationMs = 1_000): Buffer {
  const sampleRate = 8_000
  const samples = Math.floor((sampleRate * durationMs) / 1_000)
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

function mp4(durationMs = 2_000): Buffer {
  const ftyp = Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x32,
  ])
  const mvhd = Buffer.alloc(32)
  mvhd.writeUInt32BE(32, 0)
  mvhd.write('mvhd', 4, 'ascii')
  mvhd.writeUInt8(0, 8)
  mvhd.writeUInt32BE(1_000, 20)
  mvhd.writeUInt32BE(durationMs, 24)
  const moov = Buffer.alloc(8 + mvhd.length)
  moov.writeUInt32BE(moov.length, 0)
  moov.write('moov', 4, 'ascii')
  mvhd.copy(moov, 8)
  return Buffer.concat([ftyp, moov])
}

function mp4VersionOne(durationMs = 2_000): Buffer {
  const bytes = mp4(durationMs)
  const mvhd = bytes.indexOf('mvhd') - 4
  bytes.writeUInt32BE(44, mvhd)
  const expanded = Buffer.alloc(bytes.length + 12)
  bytes.subarray(0, mvhd).copy(expanded)
  expanded.writeUInt32BE(44, mvhd)
  expanded.write('mvhd', mvhd + 4, 'ascii')
  expanded.writeUInt8(1, mvhd + 8)
  expanded.writeUInt32BE(1_000, mvhd + 28)
  expanded.writeBigUInt64BE(BigInt(durationMs), mvhd + 32)
  const moov = 24
  expanded.writeUInt32BE(expanded.length - moov, moov)
  return expanded
}

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1,
])

function media(mediaType: 'audio/wav' | 'video/mp4', bytes: Buffer): OpenedMediaArtifact {
  return {
    artifact: {
      artifactId: sourceId,
      mediaType,
      byteLength: bytes.length,
      sha256: 'a'.repeat(64),
      displayName: mediaType === 'audio/wav' ? 'clip.wav' : 'clip.mp4',
    },
    bytes,
  }
}

describe('MediaPreparationService', () => {
  it('validates a native WAV locally and returns the same scope-bound ArtifactRef', async () => {
    const opened = media('audio/wav', wav())
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi.fn(),
        openMedia: vi.fn().mockResolvedValue(opened),
        registerImage: vi.fn(),
        discardImage: vi.fn(),
      },
      randomUUID: () => frameId,
    })

    await expect(
      service.prepare(
        {
          operationId,
          documentId,
          runId,
          artifact: opened.artifact,
          strategy: 'native',
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      operationId,
      inputKind: 'audio',
      strategy: 'native',
      durationMs: 1_000,
      artifacts: [opened.artifact],
    })
  })

  it('extracts bounded deterministic PNG frames and registers only run-scoped refs', async () => {
    const opened = media('video/mp4', mp4())
    const registerImage = vi.fn().mockResolvedValue({
      artifactId: frameId,
      mediaType: 'image/png',
      byteLength: png.length,
      sha256: 'b'.repeat(64),
      displayName: 'clip-frame-0001.png',
    })
    const extract = vi
      .fn()
      .mockResolvedValue([{ bytes: png, width: 1, height: 1, timestampMs: 500 }])
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi.fn(),
        openMedia: vi.fn().mockResolvedValue(opened),
        registerImage,
        discardImage: vi.fn(),
      },
      frameExtractor: { extract },
      randomUUID: () => frameId,
    })

    const result = await service.prepare(
      {
        operationId,
        documentId,
        runId,
        artifact: opened.artifact,
        strategy: 'frames',
      },
      new AbortController().signal,
    )

    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: 'video/mp4', maximumFrames: 12, durationMs: 2_000 }),
      expect.any(AbortSignal),
    )
    expect(registerImage).toHaveBeenCalledWith({
      artifactId: frameId,
      documentId,
      runId,
      bytes: png,
      mediaType: 'image/png',
      width: 1,
      height: 1,
      displayName: 'clip-frame-0001.png',
    })
    expect(result).toMatchObject({
      inputKind: 'video',
      strategy: 'frames',
      durationMs: 2_000,
      timestampsMs: [500],
    })
  })

  it.each([
    ['malformed WAV', media('audio/wav', Buffer.from('not-wave')), 'media_malformed'],
    ['MIME mismatch', media('video/mp4', wav()), 'media_malformed'],
    ['oversize', media('audio/wav', Buffer.alloc(101 * 1024 * 1024)), 'media_oversize'],
  ])('rejects %s deterministically', async (_label, opened, code) => {
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi.fn(),
        openMedia: vi.fn().mockResolvedValue(opened),
        registerImage: vi.fn(),
        discardImage: vi.fn(),
      },
      randomUUID: () => frameId,
    })

    await expect(
      service.prepare(
        {
          operationId,
          documentId,
          runId,
          artifact: opened.artifact,
          strategy: 'native',
        },
        new AbortController().signal,
      ),
    ).rejects.toEqual(new MediaPreparationServiceError(code as 'media_malformed'))
  })

  it('aborts local extraction without registering a partial frame', async () => {
    const controller = new AbortController()
    const registerImage = vi.fn()
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi.fn(),
        openMedia: vi.fn().mockResolvedValue(media('video/mp4', mp4())),
        registerImage,
        discardImage: vi.fn(),
      },
      frameExtractor: {
        extract: vi.fn().mockImplementation(async (_input, signal: AbortSignal) => {
          controller.abort()
          await Promise.resolve()
          if (signal.aborted) throw signal.reason
          return []
        }),
      },
      randomUUID: () => frameId,
    })

    await expect(
      service.prepare(
        {
          operationId,
          documentId,
          runId,
          artifact: media('video/mp4', mp4()).artifact,
          strategy: 'frames',
        },
        controller.signal,
      ),
    ).rejects.toEqual(new MediaPreparationServiceError('media_aborted'))
    expect(registerImage).not.toHaveBeenCalled()
  })

  it('prepares a scope-verified image without opening media bytes', async () => {
    const image = {
      artifactId: sourceId,
      mediaType: 'image/png' as const,
      byteLength: png.length,
      sha256: 'a'.repeat(64),
    }
    const openMedia = vi.fn()
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi.fn().mockResolvedValue({ artifact: image, bytes: png }),
        openMedia,
        registerImage: vi.fn(),
        discardImage: vi.fn(),
      },
      randomUUID: () => frameId,
    })

    await expect(
      service.prepare(
        { operationId, documentId, runId, artifact: image, strategy: 'image' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ operationId, inputKind: 'image', strategy: 'image', artifacts: [image] })
    expect(openMedia).not.toHaveBeenCalled()
  })

  it.each([
    [
      'wrong image strategy',
      { ...media('audio/wav', wav()).artifact, mediaType: 'audio/wav' as const },
      'image',
      'media_strategy_unsupported',
    ],
    [
      'image ref mismatch',
      {
        artifactId: sourceId,
        mediaType: 'image/png' as const,
        byteLength: png.length,
        sha256: 'a'.repeat(64),
      },
      'image',
      'media_malformed',
    ],
  ])('rejects %s', async (_label, artifact, strategy, expected) => {
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi
          .fn()
          .mockResolvedValue({ artifact: { ...artifact, sha256: 'b'.repeat(64) }, bytes: png }),
        openMedia: vi.fn(),
        registerImage: vi.fn(),
        discardImage: vi.fn(),
      },
      randomUUID: () => frameId,
    })
    await expect(
      service.prepare(
        { operationId, documentId, runId, artifact, strategy: strategy as 'image' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: expected })
  })

  it('supports MP4 mvhd version 1 and enforces the duration ceiling', async () => {
    const opened = media('video/mp4', mp4VersionOne())
    const store = {
      openImage: vi.fn(),
      openMedia: vi.fn().mockResolvedValue(opened),
      registerImage: vi.fn(),
      discardImage: vi.fn(),
    }
    await expect(
      new MediaPreparationService({ artifactStore: store, randomUUID: () => frameId }).prepare(
        { operationId, documentId, runId, artifact: opened.artifact, strategy: 'native' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ inputKind: 'video', durationMs: 2_000 })

    const long = media('video/mp4', mp4(2_001))
    await expect(
      new MediaPreparationService({
        artifactStore: { ...store, openMedia: vi.fn().mockResolvedValue(long) },
        randomUUID: () => frameId,
        maximumDurationMs: 2_000,
      }).prepare(
        { operationId, documentId, runId, artifact: long.artifact, strategy: 'native' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_oversize' })
  })

  it('rejects unsupported frame routes and invalid extractor output', async () => {
    const video = media('video/mp4', mp4())
    const audio = media('audio/wav', wav())
    const baseStore = {
      openImage: vi.fn(),
      openMedia: vi.fn().mockResolvedValue(video),
      registerImage: vi.fn(),
      discardImage: vi.fn(),
    }
    await expect(
      new MediaPreparationService({ artifactStore: baseStore, randomUUID: () => frameId }).prepare(
        { operationId, documentId, runId, artifact: video.artifact, strategy: 'frames' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_frame_extractor_unavailable' })
    await expect(
      new MediaPreparationService({
        artifactStore: { ...baseStore, openMedia: vi.fn().mockResolvedValue(audio) },
        frameExtractor: { extract: vi.fn() },
        randomUUID: () => frameId,
      }).prepare(
        { operationId, documentId, runId, artifact: audio.artifact, strategy: 'frames' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_strategy_unsupported' })

    for (const frames of [
      [],
      [{ bytes: png, width: 0, height: 1, timestampMs: 0 }],
      [{ bytes: png, width: 1, height: 1, timestampMs: -1 }],
      [{ bytes: png, width: 1, height: 1, timestampMs: 2_001 }],
      [{ bytes: png, width: 1, height: 1, timestampMs: 1.5 }],
      [
        { bytes: png, width: 1, height: 1, timestampMs: 500 },
        { bytes: png, width: 1, height: 1, timestampMs: 500 },
      ],
    ]) {
      await expect(
        new MediaPreparationService({
          artifactStore: baseStore,
          frameExtractor: { extract: vi.fn().mockResolvedValue(frames) },
          randomUUID: () => frameId,
        }).prepare(
          { operationId, documentId, runId, artifact: video.artifact, strategy: 'frames' },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'media_malformed' })
    }
  })

  it('rolls back registered frames when a later registration fails', async () => {
    const video = media('video/mp4', mp4())
    const firstFrame = { ...video.artifact, artifactId: frameId, mediaType: 'image/png' as const }
    const discardImage = vi.fn().mockResolvedValue(undefined)
    const registerImage = vi
      .fn()
      .mockResolvedValueOnce(firstFrame)
      .mockRejectedValueOnce(new Error('disk'))
    let next = 0
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi.fn(),
        openMedia: vi.fn().mockResolvedValue(video),
        registerImage,
        discardImage,
      },
      frameExtractor: {
        extract: vi.fn().mockResolvedValue([
          { bytes: png, width: 1, height: 1, timestampMs: 500 },
          { bytes: png, width: 1, height: 1, timestampMs: 1_000 },
        ]),
      },
      randomUUID: () => (next++ === 0 ? frameId : '66666666-6666-4666-8666-666666666666'),
    })
    await expect(
      service.prepare(
        { operationId, documentId, runId, artifact: video.artifact, strategy: 'frames' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_malformed' })
    expect(discardImage).toHaveBeenCalledWith({ artifactId: frameId, documentId, runId })
  })

  it('normalizes unexpected store failures and honors a pre-aborted request', async () => {
    const service = new MediaPreparationService({
      artifactStore: {
        openImage: vi.fn(),
        openMedia: vi.fn().mockRejectedValue(new Error('disk')),
        registerImage: vi.fn(),
        discardImage: vi.fn(),
      },
      randomUUID: () => frameId,
    })
    const input = {
      operationId,
      documentId,
      runId,
      artifact: media('audio/wav', wav()).artifact,
      strategy: 'native' as const,
    }
    await expect(service.prepare(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'media_malformed',
    })
    const controller = new AbortController()
    controller.abort()
    await expect(service.prepare(input, controller.signal)).rejects.toMatchObject({
      code: 'media_aborted',
    })
  })

  it('rejects malformed WAV chunk and format variants', async () => {
    const variants = [
      (bytes: Buffer) => bytes.writeUInt32LE(bytes.length, 40),
      (bytes: Buffer) => bytes.writeUInt16LE(2, 20),
      (bytes: Buffer) => bytes.writeUInt16LE(0, 22),
      (bytes: Buffer) => bytes.writeUInt32LE(0, 24),
      (bytes: Buffer) => bytes.writeUInt32LE(1, 28),
      (bytes: Buffer) => bytes.writeUInt16LE(3, 32),
      (bytes: Buffer) => bytes.write('JUNK', 12, 'ascii'),
      (bytes: Buffer) => bytes.write('JUNK', 36, 'ascii'),
      (bytes: Buffer) => bytes.writeUInt32LE(0, 40),
    ]
    for (const mutate of variants) {
      const bytes = wav()
      mutate(bytes)
      const opened = media('audio/wav', bytes)
      const service = new MediaPreparationService({
        artifactStore: {
          openImage: vi.fn(),
          openMedia: vi.fn().mockResolvedValue(opened),
          registerImage: vi.fn(),
          discardImage: vi.fn(),
        },
        randomUUID: () => frameId,
      })
      await expect(
        service.prepare(
          { operationId, documentId, runId, artifact: opened.artifact, strategy: 'native' },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'media_malformed' })
    }
  })

  it('rejects malformed MP4 box and movie-header variants', async () => {
    const versionOne = () => mp4VersionOne()
    const variants = [
      (bytes: Buffer) => bytes.writeUInt32BE(4, 24),
      (bytes: Buffer) => bytes.writeUInt32BE(0, 52),
      (bytes: Buffer) => bytes.writeUInt8(2, 40),
      (bytes: Buffer) => bytes.write('free', 36, 'ascii'),
      (bytes: Buffer) => bytes.write('free', 28, 'ascii'),
      (bytes: Buffer) => bytes.writeUInt32BE(0, 60),
      (bytes: Buffer) => bytes.writeUInt32BE(0x20_0000, 64),
      (bytes: Buffer) => bytes.writeBigUInt64BE(0n, 64),
    ]
    for (const [index, mutate] of variants.entries()) {
      const bytes = index >= 5 ? versionOne() : mp4()
      mutate(bytes)
      const opened = media('video/mp4', bytes)
      const service = new MediaPreparationService({
        artifactStore: {
          openImage: vi.fn(),
          openMedia: vi.fn().mockResolvedValue(opened),
          registerImage: vi.fn(),
          discardImage: vi.fn(),
        },
        randomUUID: () => frameId,
      })
      await expect(
        service.prepare(
          { operationId, documentId, runId, artifact: opened.artifact, strategy: 'native' },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'media_malformed' })
    }
  })

  it('rejects a mismatched media ref and excessive frames, and uses a safe fallback frame name', async () => {
    const video = media('video/mp4', mp4())
    const base = {
      openImage: vi.fn(),
      openMedia: vi.fn().mockResolvedValue(video),
      registerImage: vi.fn().mockImplementation(async (input) => ({
        artifactId: input.artifactId,
        mediaType: 'image/png' as const,
        byteLength: png.length,
        sha256: 'b'.repeat(64),
        displayName: input.displayName,
      })),
      discardImage: vi.fn(),
    }
    await expect(
      new MediaPreparationService({ artifactStore: base, randomUUID: () => frameId }).prepare(
        {
          operationId,
          documentId,
          runId,
          artifact: { ...video.artifact, sha256: 'c'.repeat(64) },
          strategy: 'native',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_malformed' })

    const thirteen = Array.from({ length: 13 }, (_, index) => ({
      bytes: png,
      width: 1,
      height: 1,
      timestampMs: index + 1,
    }))
    await expect(
      new MediaPreparationService({
        artifactStore: base,
        frameExtractor: { extract: vi.fn().mockResolvedValue(thirteen) },
        randomUUID: () => frameId,
      }).prepare(
        { operationId, documentId, runId, artifact: video.artifact, strategy: 'frames' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'media_malformed' })

    const unnamed = { ...video, artifact: { ...video.artifact, displayName: '.mp4' } }
    await new MediaPreparationService({
      artifactStore: { ...base, openMedia: vi.fn().mockResolvedValue(unnamed) },
      frameExtractor: {
        extract: vi.fn().mockResolvedValue([{ bytes: png, width: 1, height: 1, timestampMs: 1 }]),
      },
      randomUUID: () => frameId,
    }).prepare(
      { operationId, documentId, runId, artifact: unnamed.artifact, strategy: 'frames' },
      new AbortController().signal,
    )
    expect(base.registerImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ displayName: 'video-frame-0001.png' }),
    )
  })
})
