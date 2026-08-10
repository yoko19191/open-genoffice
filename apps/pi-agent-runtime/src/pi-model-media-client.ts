import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ScopedArtifactStore } from '@genoffice/agent-resource'
import type { ArtifactRef } from '@genoffice/agent-runtime-protocol'
import type {
  MediaModelMetadata,
  ModelMediaClient,
  ModelMediaClientResult,
} from './model-media-provider'

export type PiModelMediaClientOptions = {
  modelRuntime: Pick<ModelRuntime, 'completeSimple'>
  resolveModel(providerId: string, modelId: string): Model<Api> | undefined
  artifactStore: Pick<ScopedArtifactStore, 'openImage'>
  now?: () => number
}

function sameArtifact(expected: ArtifactRef, actual: ArtifactRef): boolean {
  return (
    expected.artifactId === actual.artifactId &&
    expected.mediaType === actual.mediaType &&
    expected.byteLength === actual.byteLength &&
    expected.sha256 === actual.sha256 &&
    expected.displayName === actual.displayName
  )
}

export class PiModelMediaClient implements ModelMediaClient {
  private readonly now: () => number

  constructor(private readonly options: PiModelMediaClientOptions) {
    this.now = options.now ?? Date.now
  }

  supportsNative(_model: MediaModelMetadata, _inputKind: 'audio' | 'video'): boolean {
    return false
  }

  async analyzeImages(
    input: Parameters<ModelMediaClient['analyzeImages']>[0],
    signal: AbortSignal,
  ): Promise<ModelMediaClientResult> {
    if (input.artifacts.length < 1 || input.artifacts.length > 12) {
      throw new Error('media_input_invalid')
    }
    const model = this.options.resolveModel(input.model.providerId, input.model.modelId)
    if (!model || model.provider !== input.model.providerId || model.id !== input.model.modelId) {
      throw new Error('media_model_changed')
    }
    const images = await Promise.all(
      input.artifacts.map(async (artifact) => {
        if (artifact.mediaType !== 'image/png') throw new Error('media_input_invalid')
        const opened = await this.options.artifactStore.openImage({
          artifactId: artifact.artifactId,
          documentId: input.documentId,
          runId: input.runId,
        })
        if (!sameArtifact(artifact, opened.artifact)) throw new Error('media_input_invalid')
        return {
          type: 'image' as const,
          data: opened.bytes.toString('base64'),
          mimeType: 'image/png',
        }
      }),
    )
    const timestampContext = input.timestampsMs?.length
      ? `\nFrame timestamps (milliseconds): ${input.timestampsMs.join(', ')}.`
      : ''
    const message = await this.options.modelRuntime.completeSimple(
      model,
      {
        systemPrompt:
          'Analyze only the supplied media input. Do not claim access to files, providers, or tools not present in this request.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${input.requirements}${timestampContext}` },
              ...images,
            ],
            timestamp: this.now(),
          },
        ],
      },
      { signal, maxRetries: 0 },
    )
    if (
      message.stopReason === 'aborted' ||
      signal.aborted ||
      message.provider !== input.model.providerId ||
      message.model !== input.model.modelId
    ) {
      throw new Error(signal.aborted ? 'media_aborted' : 'media_provider_failed')
    }
    const text = message.content
      .filter(
        (item): item is Extract<(typeof message.content)[number], { type: 'text' }> =>
          item.type === 'text',
      )
      .map(({ text }) => text)
      .join('\n')
      .trim()
    if (!text || message.stopReason === 'error') throw new Error('media_provider_failed')
    return { text, usageRecorded: true }
  }

  analyzeNative(): Promise<ModelMediaClientResult> {
    return Promise.reject(new Error('media_native_transport_unavailable'))
  }
}
