import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  parseMediaPreparationRequest,
  parsePreparedMediaReceipt,
  type MediaPreparationRequest,
  type PreparedMediaReceipt,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'

type MediaHostRequest = Extract<
  RequestEnvelope,
  { method: 'media.prepare' | 'media.prepare.abort' }
>

export type RuntimeMediaPreparationClientOptions = {
  send: (request: MediaHostRequest) => void
  randomUUID?: () => string
}

type Pending = {
  correlationId: string
  kind: 'prepare' | 'abort'
  resolve: (value: PreparedMediaReceipt | undefined) => void
  reject: (error: Error) => void
}

export class RuntimeMediaPreparationClientError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RuntimeMediaPreparationClientError'
  }
}

export class RuntimeMediaPreparationClient {
  private readonly createId: () => string
  private readonly pending = new Map<string, Pending>()
  private sequence = 0

  constructor(private readonly options: RuntimeMediaPreparationClientOptions) {
    this.createId = options.randomUUID ?? randomUUID
  }

  prepare(input: MediaPreparationRequest, signal?: AbortSignal): Promise<PreparedMediaReceipt> {
    let request: MediaPreparationRequest
    try {
      request = parseMediaPreparationRequest(input)
    } catch {
      return Promise.reject(
        new RuntimeMediaPreparationClientError('media_preparation_request_invalid'),
      )
    }
    this.sequence += 1
    const id = `media-prepare-${this.sequence}-${this.createId()}`
    const correlationId = this.createId()
    const result = new Promise<PreparedMediaReceipt>((resolve, reject) => {
      this.pending.set(id, {
        correlationId,
        kind: 'prepare',
        resolve: (value) => resolve(value as PreparedMediaReceipt),
        reject,
      })
    })
    this.options.send({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'request',
      id,
      method: 'media.prepare',
      correlationId,
      params: request,
    })
    const abort = () => {
      void this.abort(request.operationId, request.documentId).catch(() => undefined)
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    return result.finally(() => signal?.removeEventListener('abort', abort))
  }

  handleResponse(response: ResponseEnvelope): boolean {
    const pending = this.pending.get(response.id)
    if (!pending) return false
    this.pending.delete(response.id)
    if (
      response.correlationId !== pending.correlationId ||
      ('error' in response && response.error.correlationId !== pending.correlationId)
    ) {
      pending.reject(new RuntimeMediaPreparationClientError('media_preparation_response_invalid'))
      return true
    }
    if ('error' in response) {
      pending.reject(new RuntimeMediaPreparationClientError(response.error.code))
      return true
    }
    try {
      if (pending.kind === 'abort') {
        if (
          !response.result ||
          typeof response.result !== 'object' ||
          typeof (response.result as { aborted?: unknown }).aborted !== 'boolean'
        ) {
          throw new Error('media_preparation_response_invalid')
        }
        pending.resolve(undefined)
      } else {
        pending.resolve(parsePreparedMediaReceipt(response.result))
      }
    } catch {
      pending.reject(new RuntimeMediaPreparationClientError('media_preparation_response_invalid'))
    }
    return true
  }

  close(code: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new RuntimeMediaPreparationClientError(code))
    }
    this.pending.clear()
  }

  private abort(operationId: string, documentId: string): Promise<void> {
    this.sequence += 1
    const id = `media-prepare-abort-${this.sequence}-${this.createId()}`
    const correlationId = this.createId()
    const result = new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        correlationId,
        kind: 'abort',
        resolve: () => resolve(),
        reject,
      })
    })
    this.options.send({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'request',
      id,
      method: 'media.prepare.abort',
      correlationId,
      params: { operationId, documentId },
    })
    return result
  }
}
