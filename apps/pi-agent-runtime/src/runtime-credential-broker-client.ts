import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  parseCredentialBrokerDeleteReceipt,
  parseCredentialBrokerGetResult,
  parseCredentialBrokerMetadata,
  parseCredentialBrokerRequest,
  parseCredentialBrokerStatus,
  type CredentialBrokerGetResult,
  type CredentialBrokerMetadata,
  type CredentialBrokerRequest,
  type CredentialBrokerStatus,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'
import type {
  CredentialBrokerClient,
  CredentialBrokerWrite,
} from './open-genoffice-credential-store'

export type RuntimeCredentialBrokerClientOptions = {
  send: (request: CredentialBrokerRequest) => void
  randomUUID?: () => string
}

type PendingRequest = {
  correlationId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  parse: (value: unknown) => unknown
}

export class RuntimeCredentialBrokerClientError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'RuntimeCredentialBrokerClientError'
    this.code = code
  }
}

export class RuntimeCredentialBrokerClient implements CredentialBrokerClient {
  private readonly createId: () => string
  private readonly pending = new Map<string, PendingRequest>()
  private sequence = 0

  constructor(private readonly options: RuntimeCredentialBrokerClientOptions) {
    this.createId = options.randomUUID ?? randomUUID
  }

  put(input: CredentialBrokerWrite): Promise<CredentialBrokerMetadata> {
    return this.request('credential.put', input, parseCredentialBrokerMetadata)
  }

  rotate(input: CredentialBrokerWrite): Promise<CredentialBrokerMetadata> {
    return this.request('credential.rotate', input, parseCredentialBrokerMetadata)
  }

  get(slot: string): Promise<CredentialBrokerGetResult | undefined> {
    return this.request('credential.get', { slot }, parseCredentialBrokerGetResult)
  }

  status(slot: string): Promise<CredentialBrokerStatus> {
    return this.request('credential.status', { slot }, parseCredentialBrokerStatus)
  }

  async delete(slot: string, expectedGeneration: number): Promise<void> {
    await this.request(
      'credential.delete',
      { slot, expectedGeneration },
      parseCredentialBrokerDeleteReceipt,
    )
  }

  handleResponse(response: ResponseEnvelope): boolean {
    const pending = this.pending.get(response.id)
    if (!pending) return false
    this.pending.delete(response.id)
    if (
      response.correlationId !== pending.correlationId ||
      ('error' in response && response.error.correlationId !== pending.correlationId)
    ) {
      pending.reject(new RuntimeCredentialBrokerClientError('credential_response_invalid'))
      return true
    }
    if ('error' in response) {
      pending.reject(new RuntimeCredentialBrokerClientError(response.error.code))
      return true
    }
    try {
      pending.resolve(pending.parse(response.result))
    } catch {
      pending.reject(new RuntimeCredentialBrokerClientError('credential_response_invalid'))
    }
    return true
  }

  close(code: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new RuntimeCredentialBrokerClientError(code))
    }
    this.pending.clear()
  }

  private request<T>(
    method: CredentialBrokerRequest['method'],
    params: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    this.sequence += 1
    const id = `credential-${this.sequence}-${this.createId()}`
    const correlationId = this.createId()
    let resolveRequest!: (value: unknown) => void
    let rejectRequest!: (error: Error) => void
    const result = new Promise<T>((resolve, reject) => {
      resolveRequest = resolve as (value: unknown) => void
      rejectRequest = reject
    })
    this.pending.set(id, {
      correlationId,
      resolve: resolveRequest,
      reject: rejectRequest,
      parse,
    })
    try {
      this.options.send(
        parseCredentialBrokerRequest({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'request',
          id,
          method,
          correlationId,
          params,
        }),
      )
    } catch {
      this.pending.delete(id)
      rejectRequest(new RuntimeCredentialBrokerClientError('credential_request_invalid'))
    }
    return result
  }
}
