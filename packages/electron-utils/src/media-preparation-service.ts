import type { ScopedArtifactRef } from '@genoffice/agent-resource'

const MAX_MEDIA_BYTES = 100 * 1024 * 1024
const MAX_DURATION_MS = 2 * 60 * 60 * 1_000
const MAX_FRAMES = 12

export type MediaArtifactRef = ScopedArtifactRef & {
  mediaType: 'image/png' | 'audio/wav' | 'video/mp4'
}

export type OpenedMediaArtifact = {
  artifact: MediaArtifactRef & { mediaType: 'audio/wav' | 'video/mp4' }
  bytes: Buffer
}

export type MediaFrame = {
  bytes: Uint8Array
  width: number
  height: number
  timestampMs: number
}

export type MediaFrameExtractor = {
  extract(
    input: {
      bytes: Uint8Array
      mediaType: 'video/mp4'
      durationMs: number
      maximumFrames: number
    },
    signal: AbortSignal,
  ): Promise<readonly MediaFrame[]>
}

export type MediaPreparationArtifactStore = {
  openImage(input: {
    artifactId: string
    documentId: string
    runId: string
  }): Promise<{ artifact: ScopedArtifactRef & { mediaType: 'image/png' }; bytes: Buffer }>
  openMedia(input: {
    artifactId: string
    documentId: string
    runId: string
  }): Promise<OpenedMediaArtifact>
  registerImage(input: {
    artifactId: string
    documentId: string
    runId: string
    bytes: Uint8Array
    mediaType: 'image/png'
    width: number
    height: number
    displayName?: string
  }): Promise<ScopedArtifactRef & { mediaType: 'image/png' }>
  discardImage(input: { artifactId: string; documentId: string; runId: string }): Promise<void>
}

export type MediaPreparationRequest = {
  operationId: string
  documentId: string
  runId: string
  artifact: MediaArtifactRef
  strategy: 'image' | 'native' | 'frames'
}

export type PreparedMedia = {
  operationId: string
  inputKind: 'image' | 'audio' | 'video'
  strategy: 'image' | 'native' | 'frames'
  durationMs?: number
  artifacts: MediaArtifactRef[]
  timestampsMs?: number[]
}

export type MediaPreparationServiceErrorCode =
  | 'media_aborted'
  | 'media_malformed'
  | 'media_oversize'
  | 'media_strategy_unsupported'
  | 'media_frame_extractor_unavailable'

export class MediaPreparationServiceError extends Error {
  constructor(readonly code: MediaPreparationServiceErrorCode) {
    super(code)
    this.name = 'MediaPreparationServiceError'
  }
}

export type MediaPreparationServiceOptions = {
  artifactStore: MediaPreparationArtifactStore
  frameExtractor?: MediaFrameExtractor
  randomUUID: () => string
  maximumMediaBytes?: number
  maximumDurationMs?: number
  maximumFrames?: number
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaPreparationServiceError('media_aborted')
}

function sameArtifact(expected: MediaArtifactRef, actual: ScopedArtifactRef): boolean {
  return (
    expected.artifactId === actual.artifactId &&
    expected.mediaType === actual.mediaType &&
    expected.byteLength === actual.byteLength &&
    expected.sha256 === actual.sha256 &&
    expected.displayName === actual.displayName
  )
}

function wavDurationMs(bytes: Buffer): number | undefined {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return undefined
  }
  let offset = 12
  let byteRate: number | undefined
  let dataBytes: number | undefined
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const payload = offset + 8
    if (payload + size > bytes.length) return undefined
    if (kind === 'fmt ' && size >= 16) {
      const format = bytes.readUInt16LE(payload)
      const channels = bytes.readUInt16LE(payload + 2)
      const sampleRate = bytes.readUInt32LE(payload + 4)
      byteRate = bytes.readUInt32LE(payload + 8)
      const blockAlign = bytes.readUInt16LE(payload + 12)
      const bitsPerSample = bytes.readUInt16LE(payload + 14)
      if (
        (format !== 1 && format !== 3) ||
        channels < 1 ||
        sampleRate < 1 ||
        byteRate !== sampleRate * blockAlign ||
        blockAlign !== (channels * bitsPerSample) / 8
      ) {
        return undefined
      }
    }
    if (kind === 'data') dataBytes = size
    offset = payload + size + (size % 2)
  }
  if (!byteRate || dataBytes === undefined) return undefined
  const duration = (dataBytes / byteRate) * 1_000
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined
}

function mp4DurationMs(bytes: Buffer): number | undefined {
  if (bytes.length < 24 || bytes.toString('ascii', 4, 8) !== 'ftyp') return undefined
  const walk = (start: number, end: number): number | undefined => {
    let offset = start
    while (offset + 8 <= end) {
      const size = bytes.readUInt32BE(offset)
      const kind = bytes.toString('ascii', offset + 4, offset + 8)
      if (size < 8 || offset + size > end) return undefined
      const payload = offset + 8
      if (kind === 'mvhd') {
        const version = bytes[payload]
        if (version === 0 && payload + 20 <= offset + size) {
          const timescale = bytes.readUInt32BE(payload + 12)
          const duration = bytes.readUInt32BE(payload + 16)
          if (!timescale || !duration) return undefined
          return Math.round((duration / timescale) * 1_000)
        }
        if (version === 1 && payload + 32 <= offset + size) {
          const timescale = bytes.readUInt32BE(payload + 20)
          const high = bytes.readUInt32BE(payload + 24)
          const low = bytes.readUInt32BE(payload + 28)
          if (!timescale || high > 0x1f_ffff) return undefined
          const duration = high * 0x1_0000_0000 + low
          return duration > 0 ? Math.round((duration / timescale) * 1_000) : undefined
        }
        return undefined
      }
      if (kind === 'moov') {
        const duration = walk(payload, offset + size)
        if (duration !== undefined) return duration
      }
      offset += size
    }
    return undefined
  }
  return walk(0, bytes.length)
}

function frameName(source: MediaArtifactRef, index: number): string {
  const base = (source.displayName ?? 'video').replace(/\.[^.]+$/u, '') || 'video'
  return `${base.slice(0, 238)}-frame-${String(index + 1).padStart(4, '0')}.png`
}

export class MediaPreparationService {
  private readonly maximumMediaBytes: number
  private readonly maximumDurationMs: number
  private readonly maximumFrames: number

  constructor(private readonly options: MediaPreparationServiceOptions) {
    this.maximumMediaBytes = options.maximumMediaBytes ?? MAX_MEDIA_BYTES
    this.maximumDurationMs = options.maximumDurationMs ?? MAX_DURATION_MS
    this.maximumFrames = options.maximumFrames ?? MAX_FRAMES
  }

  async prepare(input: MediaPreparationRequest, signal: AbortSignal): Promise<PreparedMedia> {
    try {
      aborted(signal)
      if (input.strategy === 'image') return await this.prepareImage(input, signal)
      const opened = await this.options.artifactStore.openMedia({
        artifactId: input.artifact.artifactId,
        documentId: input.documentId,
        runId: input.runId,
      })
      aborted(signal)
      if (!sameArtifact(input.artifact, opened.artifact)) {
        throw new MediaPreparationServiceError('media_malformed')
      }
      if (opened.bytes.length > this.maximumMediaBytes) {
        throw new MediaPreparationServiceError('media_oversize')
      }
      const inputKind = opened.artifact.mediaType === 'audio/wav' ? 'audio' : 'video'
      const durationMs =
        inputKind === 'audio' ? wavDurationMs(opened.bytes) : mp4DurationMs(opened.bytes)
      if (!durationMs) throw new MediaPreparationServiceError('media_malformed')
      if (durationMs > this.maximumDurationMs) {
        throw new MediaPreparationServiceError('media_oversize')
      }
      if (input.strategy === 'native') {
        return {
          operationId: input.operationId,
          inputKind,
          strategy: 'native',
          durationMs,
          artifacts: [opened.artifact],
        }
      }
      if (inputKind !== 'video') {
        throw new MediaPreparationServiceError('media_strategy_unsupported')
      }
      return await this.prepareFrames(
        input,
        {
          ...opened,
          artifact: { ...opened.artifact, mediaType: 'video/mp4' },
        },
        durationMs,
        signal,
      )
    } catch (error) {
      if (error instanceof MediaPreparationServiceError) throw error
      if (signal.aborted) throw new MediaPreparationServiceError('media_aborted')
      throw new MediaPreparationServiceError('media_malformed')
    }
  }

  private async prepareImage(
    input: MediaPreparationRequest,
    signal: AbortSignal,
  ): Promise<PreparedMedia> {
    if (input.artifact.mediaType !== 'image/png') {
      throw new MediaPreparationServiceError('media_strategy_unsupported')
    }
    const opened = await this.options.artifactStore.openImage({
      artifactId: input.artifact.artifactId,
      documentId: input.documentId,
      runId: input.runId,
    })
    aborted(signal)
    if (!sameArtifact(input.artifact, opened.artifact)) {
      throw new MediaPreparationServiceError('media_malformed')
    }
    return {
      operationId: input.operationId,
      inputKind: 'image',
      strategy: 'image',
      artifacts: [opened.artifact],
    }
  }

  private async prepareFrames(
    input: MediaPreparationRequest,
    opened: OpenedMediaArtifact & { artifact: MediaArtifactRef & { mediaType: 'video/mp4' } },
    durationMs: number,
    signal: AbortSignal,
  ): Promise<PreparedMedia> {
    if (!this.options.frameExtractor) {
      throw new MediaPreparationServiceError('media_frame_extractor_unavailable')
    }
    const frames = await this.options.frameExtractor.extract(
      {
        bytes: opened.bytes,
        mediaType: 'video/mp4',
        durationMs,
        maximumFrames: this.maximumFrames,
      },
      signal,
    )
    aborted(signal)
    if (
      frames.length < 1 ||
      frames.length > this.maximumFrames ||
      frames.some(
        (frame, index) =>
          !Number.isInteger(frame.timestampMs) ||
          frame.timestampMs < 0 ||
          frame.timestampMs > durationMs ||
          frame.width < 1 ||
          frame.height < 1 ||
          (index > 0 && frame.timestampMs <= frames[index - 1]!.timestampMs),
      )
    ) {
      throw new MediaPreparationServiceError('media_malformed')
    }
    const artifacts: MediaArtifactRef[] = []
    try {
      for (const [index, frame] of frames.entries()) {
        aborted(signal)
        artifacts.push(
          await this.options.artifactStore.registerImage({
            artifactId: this.options.randomUUID(),
            documentId: input.documentId,
            runId: input.runId,
            bytes: frame.bytes,
            mediaType: 'image/png',
            width: frame.width,
            height: frame.height,
            displayName: frameName(opened.artifact, index),
          }),
        )
      }
    } catch (error) {
      await Promise.allSettled(
        artifacts.map(({ artifactId }) =>
          this.options.artifactStore.discardImage({
            artifactId,
            documentId: input.documentId,
            runId: input.runId,
          }),
        ),
      )
      throw error
    }
    return {
      operationId: input.operationId,
      inputKind: 'video',
      strategy: 'frames',
      durationMs,
      artifacts,
      timestampsMs: frames.map(({ timestampMs }) => timestampMs),
    }
  }
}
