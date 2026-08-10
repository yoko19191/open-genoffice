import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  parseOfficeToolInvocation,
  parseOfficeToolReceipt,
  type OfficeToolInvocation,
  type OfficeToolReceipt,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'

type OfficeToolHostRequest = Extract<
  RequestEnvelope,
  { method: 'office.tool.invoke' | 'office.tool.abort' }
>

export type RuntimeOfficeToolHostClientOptions = {
  send: (request: OfficeToolHostRequest) => void
  randomUUID?: () => string
}

type PendingRequest = {
  correlationId: string
  kind: 'invoke' | 'abort'
  resolve: (value: OfficeToolReceipt | undefined) => void
  reject: (error: Error) => void
}

export class RuntimeOfficeToolHostClientError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'RuntimeOfficeToolHostClientError'
    this.code = code
  }
}

export class RuntimeOfficeToolHostClient {
  private readonly createId: () => string
  private readonly pending = new Map<string, PendingRequest>()
  private sequence = 0

  constructor(private readonly options: RuntimeOfficeToolHostClientOptions) {
    this.createId = options.randomUUID ?? randomUUID
  }

  invoke(input: OfficeToolInvocation, signal?: AbortSignal): Promise<OfficeToolReceipt> {
    let invocation: OfficeToolInvocation
    try {
      invocation = parseOfficeToolInvocation(input)
    } catch {
      return Promise.reject(new RuntimeOfficeToolHostClientError('office_tool_request_invalid'))
    }
    this.sequence += 1
    const id = `office-tool-${this.sequence}-${this.createId()}`
    const correlationId = this.createId()
    const result = new Promise<OfficeToolReceipt>((resolve, reject) => {
      this.pending.set(id, {
        correlationId,
        kind: 'invoke',
        resolve: (value) => resolve(value as OfficeToolReceipt),
        reject,
      })
    })
    this.options.send({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'request',
      id,
      method: 'office.tool.invoke',
      correlationId,
      params: invocation,
    })
    const abort = () => {
      void this.abortOperation(invocation.operationId, invocation.documentId).catch(() => undefined)
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
      pending.reject(new RuntimeOfficeToolHostClientError('office_tool_response_invalid'))
      return true
    }
    if ('error' in response) {
      pending.reject(new RuntimeOfficeToolHostClientError(response.error.code))
      return true
    }
    try {
      if (pending.kind === 'abort') {
        if (
          !response.result ||
          typeof response.result !== 'object' ||
          typeof (response.result as { aborted?: unknown }).aborted !== 'boolean'
        ) {
          throw new Error('office_tool_response_invalid')
        }
        pending.resolve(undefined)
        return true
      }
      pending.resolve(parseOfficeToolReceipt(response.result))
    } catch {
      pending.reject(new RuntimeOfficeToolHostClientError('office_tool_response_invalid'))
    }
    return true
  }

  private abortOperation(operationId: string, documentId: string): Promise<void> {
    this.sequence += 1
    const id = `office-tool-abort-${this.sequence}-${this.createId()}`
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
      method: 'office.tool.abort',
      correlationId,
      params: { operationId, documentId },
    })
    return result
  }

  close(code: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new RuntimeOfficeToolHostClientError(code))
    }
    this.pending.clear()
  }
}
