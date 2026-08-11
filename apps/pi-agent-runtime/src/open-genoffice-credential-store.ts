import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'

export type CredentialBrokerMetadata = {
  credentialId: string
  slot: string
  providerId: string
  kind: Credential['type']
  generation: number
  status: 'available'
}

export type CredentialBrokerStatus =
  CredentialBrokerMetadata | { slot: string; status: 'missing' | 'secure_storage_unavailable' }

export type CredentialBrokerWrite = {
  slot: string
  providerId: string
  kind: Credential['type']
  expectedGeneration: number
  secretPayload: string
}

export type CredentialBrokerClient = {
  put(input: CredentialBrokerWrite): Promise<CredentialBrokerMetadata>
  rotate(input: CredentialBrokerWrite): Promise<CredentialBrokerMetadata>
  get(
    slot: string,
  ): Promise<{ metadata: CredentialBrokerMetadata; secretPayload: string } | undefined>
  status(slot: string): Promise<CredentialBrokerStatus>
  delete(slot: string, expectedGeneration: number): Promise<void>
}

export type CredentialStoreStatus = {
  providerId: string
  status: 'available' | 'missing' | 'secure_storage_unavailable'
  kind?: Credential['type']
}

export type OpenGenOfficeCredentialStoreOptions =
  | {
      mode: 'persistent'
      broker: CredentialBrokerClient
      providerIds?: readonly string[]
    }
  | {
      mode: 'memory_only'
      providerIds?: readonly string[]
    }

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const BROKER_ERROR_CODES = new Set([
  'secure_storage_unavailable',
  'credential_generation_conflict',
  'credential_index_invalid',
  'credential_persist_failed',
  'credential_decrypt_failed',
])

export class OpenGenOfficeCredentialStoreError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'OpenGenOfficeCredentialStoreError'
    this.code = code
  }
}

function assertProviderId(providerId: string): void {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new OpenGenOfficeCredentialStoreError('credential_provider_id_invalid')
  }
}

function slotFor(providerId: string): string {
  assertProviderId(providerId)
  return `model/${providerId}/default`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validApiKeyCredential(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  if (keys.some((key) => !['type', 'key', 'env'].includes(key))) return false
  if (value.key !== undefined && typeof value.key !== 'string') return false
  if (value.env === undefined) return true
  return isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === 'string')
}

function validOAuthCredential(value: Record<string, unknown>): boolean {
  return (
    typeof value.access === 'string' &&
    typeof value.refresh === 'string' &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires)
  )
}

export function parseCredentialPayload(payload: string): Credential {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new OpenGenOfficeCredentialStoreError('credential_payload_invalid')
  }
  if (
    !isRecord(parsed) ||
    (parsed.type === 'api_key' && !validApiKeyCredential(parsed)) ||
    (parsed.type === 'oauth' && !validOAuthCredential(parsed)) ||
    (parsed.type !== 'api_key' && parsed.type !== 'oauth')
  ) {
    throw new OpenGenOfficeCredentialStoreError('credential_payload_invalid')
  }
  return parsed as Credential
}

function serializeCredential(credential: Credential): string {
  const payload = JSON.stringify(credential)
  parseCredentialPayload(payload)
  return payload
}

function normalizeBrokerError(error: unknown, fallback: string): OpenGenOfficeCredentialStoreError {
  const candidate = error as { code?: unknown; message?: unknown }
  const code =
    typeof candidate.code === 'string'
      ? candidate.code
      : typeof candidate.message === 'string'
        ? candidate.message
        : fallback
  return new OpenGenOfficeCredentialStoreError(BROKER_ERROR_CODES.has(code) ? code : fallback)
}

export class OpenGenOfficeCredentialStore implements CredentialStore {
  private readonly mode: 'persistent' | 'memory_only'
  private readonly broker?: CredentialBrokerClient
  private readonly providers = new Set<string>()
  private readonly memory = new Map<string, Credential>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(options: OpenGenOfficeCredentialStoreOptions) {
    this.mode = options.mode
    this.broker = options.mode === 'persistent' ? options.broker : undefined
    for (const providerId of options.providerIds ?? []) {
      assertProviderId(providerId)
      this.providers.add(providerId)
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted()
    this.register(providerId)
    if (this.mode === 'memory_only') return this.memory.get(providerId)
    return (await this.readPersistent(providerId)).credential
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted()
    if (this.mode === 'memory_only') {
      return [...this.memory].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }))
    }

    const listed: CredentialInfo[] = []
    for (const providerId of this.providers) {
      options?.signal?.throwIfAborted()
      let status: CredentialBrokerStatus
      try {
        status = await this.requireBroker().status(slotFor(providerId))
      } catch (error) {
        throw normalizeBrokerError(error, 'credential_status_failed')
      }
      if (status.status === 'secure_storage_unavailable') {
        throw new OpenGenOfficeCredentialStoreError('secure_storage_unavailable')
      }
      if (status.status === 'available') listed.push({ providerId, type: status.kind })
    }
    return listed
  }

  async status(providerId: string, options?: AuthOperationOptions): Promise<CredentialStoreStatus> {
    options?.signal?.throwIfAborted()
    this.register(providerId)
    if (this.mode === 'memory_only') {
      const credential = this.memory.get(providerId)
      return credential
        ? { providerId, status: 'available', kind: credential.type }
        : { providerId, status: 'missing' }
    }
    let status: CredentialBrokerStatus
    try {
      status = await this.requireBroker().status(slotFor(providerId))
    } catch (error) {
      throw normalizeBrokerError(error, 'credential_status_failed')
    }
    if (status.status !== 'available') return { providerId, status: status.status }
    return { providerId, status: 'available', kind: status.kind }
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    this.register(providerId)
    return this.enqueue(
      providerId,
      async () => {
        const persistent =
          this.mode === 'persistent'
            ? await this.readPersistent(providerId)
            : { credential: this.memory.get(providerId), generation: 0 }
        const next = await fn(persistent.credential)
        options?.signal?.throwIfAborted()
        if (next === undefined) return persistent.credential
        const secretPayload = serializeCredential(next)
        if (this.mode === 'memory_only') {
          this.memory.set(providerId, next)
          return next
        }

        const input: CredentialBrokerWrite = {
          slot: slotFor(providerId),
          providerId,
          kind: next.type,
          expectedGeneration: persistent.generation,
          secretPayload,
        }
        try {
          if (persistent.generation === 0) await this.requireBroker().put(input)
          else await this.requireBroker().rotate(input)
        } catch (error) {
          throw normalizeBrokerError(error, 'credential_persist_failed')
        }
        return next
      },
      options,
    )
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    this.register(providerId)
    return this.enqueue(
      providerId,
      async () => {
        if (this.mode === 'memory_only') {
          this.memory.delete(providerId)
          return
        }
        const slot = slotFor(providerId)
        let status: CredentialBrokerStatus
        try {
          status = await this.requireBroker().status(slot)
          if (status.status === 'secure_storage_unavailable') {
            throw new OpenGenOfficeCredentialStoreError('secure_storage_unavailable')
          }
          if (status.status === 'available') {
            await this.requireBroker().delete(slot, status.generation)
          }
        } catch (error) {
          throw normalizeBrokerError(error, 'credential_delete_failed')
        }
      },
      options,
    )
  }

  private register(providerId: string): void {
    assertProviderId(providerId)
    this.providers.add(providerId)
  }

  private requireBroker(): CredentialBrokerClient {
    return this.broker as CredentialBrokerClient
  }

  private async readPersistent(
    providerId: string,
  ): Promise<{ credential: Credential | undefined; generation: number }> {
    let stored: Awaited<ReturnType<CredentialBrokerClient['get']>>
    try {
      stored = await this.requireBroker().get(slotFor(providerId))
    } catch (error) {
      throw normalizeBrokerError(error, 'credential_read_failed')
    }
    if (!stored) return { credential: undefined, generation: 0 }
    const credential = parseCredentialPayload(stored.secretPayload)
    if (
      stored.metadata.providerId !== providerId ||
      stored.metadata.slot !== slotFor(providerId) ||
      stored.metadata.kind !== credential.type
    ) {
      throw new OpenGenOfficeCredentialStoreError('credential_payload_invalid')
    }
    return { credential, generation: stored.metadata.generation }
  }

  private enqueue<T>(
    providerId: string,
    operation: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const result = previous.then(async () => {
      options?.signal?.throwIfAborted()
      return operation()
    })
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(providerId, settled)
    void settled.finally(() => {
      if (this.chains.get(providerId) === settled) this.chains.delete(providerId)
    })
    return result
  }
}
