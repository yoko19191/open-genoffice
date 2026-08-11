import type { ProviderOperationRecord } from '@genoffice/agent-resource'
import type { ArtifactRef } from '@genoffice/agent-runtime-protocol'

export type MediaModelMetadata = {
  providerId: string
  modelId: string
  capabilities: readonly string[]
}

export type PreparedMediaInput = {
  operationId: string
  inputKind: 'image' | 'audio' | 'video'
  strategy: 'image' | 'native' | 'frames'
  durationMs?: number
  artifacts: ArtifactRef[]
  timestampsMs?: number[]
}

export type ModelMediaClientResult = {
  text: string
  usageRecorded: boolean
}

export type ModelMediaClient = {
  supportsNative(model: MediaModelMetadata, inputKind: 'audio' | 'video'): boolean
  analyzeImages(
    input: {
      model: MediaModelMetadata
      documentId: string
      runId: string
      requirements: string
      inputMode: 'image' | 'frames'
      artifacts: readonly ArtifactRef[]
      timestampsMs?: readonly number[]
    },
    signal: AbortSignal,
  ): Promise<ModelMediaClientResult>
  analyzeNative(
    input: {
      model: MediaModelMetadata
      documentId: string
      runId: string
      requirements: string
      inputKind: 'audio' | 'video'
      artifact: ArtifactRef
      durationMs?: number
    },
    signal: AbortSignal,
  ): Promise<ModelMediaClientResult>
}

export type ModelMediaPrepare = (
  input: {
    operationId: string
    documentId: string
    runId: string
    artifact: ArtifactRef
    strategy: 'image' | 'native' | 'frames'
  },
  signal: AbortSignal,
) => Promise<PreparedMediaInput>

export type ModelMediaProviderOptions = {
  operationStore: {
    commit(
      record: ProviderOperationRecord,
      expectedGeneration: number,
    ): Promise<ProviderOperationRecord>
  }
  prepare: ModelMediaPrepare
  client: ModelMediaClient
  now?: () => string
  operationTtlMs?: number
}

export type ModelMediaProviderErrorCode =
  'media_aborted' | 'media_capability_unsupported' | 'media_input_invalid' | 'media_provider_failed'

export type ModelMediaDisabledDetails = {
  state: 'disabled'
  action: 'change_model'
  providerId: string
  modelId: string
}

export class ModelMediaProviderError extends Error {
  constructor(
    readonly code: ModelMediaProviderErrorCode,
    readonly details?: ModelMediaDisabledDetails,
  ) {
    super(code)
    this.name = 'ModelMediaProviderError'
  }
}

export type ModelMediaAnalysisInput = {
  operationId: string
  documentId: string
  runId: string
  artifact: ArtifactRef
  requirements: string
  model: MediaModelMetadata
}

export type ModelMediaAnalysisResult = {
  text: string
  details: {
    operationId: string
    providerId: string
    modelId: string
    toolId: 'platform:analyze_media'
    inputMode: 'image' | 'frames' | 'native-audio' | 'native-video'
    sourceArtifactId: string
    usageRecorded: boolean
  }
}

const allowedMediaTypes = new Set(['image/png', 'audio/wav', 'video/mp4'])

function unsupported(model: MediaModelMetadata): ModelMediaProviderError {
  return new ModelMediaProviderError('media_capability_unsupported', {
    state: 'disabled',
    action: 'change_model',
    providerId: model.providerId,
    modelId: model.modelId,
  })
}

function providerId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)
}

function validInput(input: ModelMediaAnalysisInput): boolean {
  return (
    providerId(input.model.providerId) &&
    input.model.modelId.length > 0 &&
    input.model.modelId.length <= 256 &&
    input.requirements.trim().length > 0 &&
    input.requirements.length <= 16_000 &&
    allowedMediaTypes.has(input.artifact.mediaType) &&
    input.artifact.byteLength > 0
  )
}

export class ModelMediaProvider {
  private readonly now: () => string
  private readonly operationTtlMs: number

  constructor(private readonly options: ModelMediaProviderOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.operationTtlMs = options.operationTtlMs ?? 24 * 60 * 60 * 1_000
  }

  async analyze(
    input: ModelMediaAnalysisInput,
    signal: AbortSignal,
  ): Promise<ModelMediaAnalysisResult> {
    if (!validInput(input)) throw new ModelMediaProviderError('media_input_invalid')
    if (signal.aborted) throw new ModelMediaProviderError('media_aborted')
    const route = this.route(input)
    let generation = 0
    const commit = async (
      state: ProviderOperationRecord['state'],
      errorCode?: string,
    ): Promise<void> => {
      const updatedAt = this.now()
      const record: ProviderOperationRecord = {
        operationId: input.operationId,
        providerId: input.model.providerId,
        documentId: input.documentId,
        state,
        generation: generation + 1,
        updatedAt,
        expiresAt: new Date(Date.parse(updatedAt) + this.operationTtlMs).toISOString(),
        artifactId: input.artifact.artifactId,
        ...(errorCode ? { errorCode } : {}),
      }
      await this.options.operationStore.commit(record, generation)
      generation = record.generation
    }

    await commit('preparing')
    try {
      const prepared = await this.options.prepare(
        {
          operationId: input.operationId,
          documentId: input.documentId,
          runId: input.runId,
          artifact: input.artifact,
          strategy: route.strategy,
        },
        signal,
      )
      if (signal.aborted) throw new ModelMediaProviderError('media_aborted')
      await commit('dispatched')
      await commit('running')
      const result =
        route.inputMode === 'native-audio' || route.inputMode === 'native-video'
          ? await this.options.client.analyzeNative(
              {
                model: input.model,
                documentId: input.documentId,
                runId: input.runId,
                requirements: input.requirements,
                inputKind: route.inputMode === 'native-audio' ? 'audio' : 'video',
                artifact: prepared.artifacts[0]!,
                ...(prepared.durationMs === undefined ? {} : { durationMs: prepared.durationMs }),
              },
              signal,
            )
          : await this.options.client.analyzeImages(
              {
                model: input.model,
                documentId: input.documentId,
                runId: input.runId,
                requirements: input.requirements,
                inputMode: route.inputMode,
                artifacts: prepared.artifacts,
                ...(prepared.timestampsMs ? { timestampsMs: prepared.timestampsMs } : {}),
              },
              signal,
            )
      if (signal.aborted) throw new ModelMediaProviderError('media_aborted')
      if (!result.text.trim()) throw new ModelMediaProviderError('media_provider_failed')
      await commit('completed')
      return {
        text: result.text,
        details: {
          operationId: input.operationId,
          providerId: input.model.providerId,
          modelId: input.model.modelId,
          toolId: 'platform:analyze_media',
          inputMode: route.inputMode,
          sourceArtifactId: input.artifact.artifactId,
          usageRecorded: result.usageRecorded,
        },
      }
    } catch (error) {
      const isAbort = signal.aborted || (error as { code?: unknown }).code === 'media_aborted'
      await commit(
        isAbort ? 'cancelled_local' : 'failed',
        isAbort ? 'media_aborted' : 'media_provider_failed',
      )
      if (isAbort) throw new ModelMediaProviderError('media_aborted')
      if (error instanceof ModelMediaProviderError) throw error
      throw new ModelMediaProviderError('media_provider_failed')
    }
  }

  private route(input: ModelMediaAnalysisInput): {
    strategy: 'image' | 'native' | 'frames'
    inputMode: ModelMediaAnalysisResult['details']['inputMode']
  } {
    const capabilities = new Set(input.model.capabilities)
    if (input.artifact.mediaType === 'image/png') {
      if (!capabilities.has('image-input')) throw unsupported(input.model)
      return { strategy: 'image', inputMode: 'image' }
    }
    if (input.artifact.mediaType === 'audio/wav') {
      if (
        !capabilities.has('audio-input') ||
        !this.options.client.supportsNative(input.model, 'audio')
      ) {
        throw unsupported(input.model)
      }
      return { strategy: 'native', inputMode: 'native-audio' }
    }
    if (
      capabilities.has('video-input') &&
      this.options.client.supportsNative(input.model, 'video')
    ) {
      return { strategy: 'native', inputMode: 'native-video' }
    }
    if (capabilities.has('image-input')) return { strategy: 'frames', inputMode: 'frames' }
    throw unsupported(input.model)
  }
}
