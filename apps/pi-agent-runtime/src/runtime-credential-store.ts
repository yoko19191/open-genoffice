import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'
import type { ProviderCredentialStatus } from '@genoffice/agent-runtime-protocol'
import {
  OpenGenOfficeCredentialStore,
  OpenGenOfficeCredentialStoreError,
  parseCredentialPayload,
  type CredentialBrokerClient,
} from './open-genoffice-credential-store'

export type RuntimeCredentialStoreOptions = {
  broker: CredentialBrokerClient
  providerIds?: readonly string[]
}

export class RuntimeCredentialStore implements CredentialStore {
  private readonly persistent: OpenGenOfficeCredentialStore
  private readonly memory: OpenGenOfficeCredentialStore
  private readonly memoryProviders = new Set<string>()
  private readonly providers = new Set<string>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(options: RuntimeCredentialStoreOptions) {
    this.persistent = new OpenGenOfficeCredentialStore({
      mode: 'persistent',
      broker: options.broker,
      providerIds: options.providerIds,
    })
    this.memory = new OpenGenOfficeCredentialStore({
      mode: 'memory_only',
      providerIds: options.providerIds,
    })
    for (const providerId of options.providerIds ?? []) this.providers.add(providerId)
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(
      providerId,
      () => this.activeStore(providerId).read(providerId, options),
      options,
    )
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted()
    const credentials: CredentialInfo[] = []
    for (const providerId of this.providers) {
      const status = await this.status(providerId, options)
      if (status.status === 'available' && status.kind) {
        credentials.push({ providerId, type: status.kind })
      }
    }
    return credentials
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(
      providerId,
      () => this.activeStore(providerId).modify(providerId, fn, options),
      options,
    )
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(
      providerId,
      async () => {
        await this.activeStore(providerId).delete(providerId, options)
        this.memoryProviders.delete(providerId)
      },
      options,
    )
  }

  put(
    providerId: string,
    persistence: ProviderCredentialStatus['persistence'],
    secretPayload: string,
    options?: AuthOperationOptions,
  ): Promise<ProviderCredentialStatus> {
    const credential = parseCredentialPayload(secretPayload)
    return this.enqueue(
      providerId,
      async () => {
        if (persistence === 'memory_only') {
          const persistentStatus = await this.persistent.status(providerId, options)
          if (persistentStatus.status === 'available') {
            throw new OpenGenOfficeCredentialStoreError('credential_persistence_conflict')
          }
          await this.memory.modify(providerId, async () => credential, options)
          this.memoryProviders.add(providerId)
        } else {
          await this.persistent.modify(providerId, async () => credential, options)
          await this.memory.delete(providerId, options)
          this.memoryProviders.delete(providerId)
        }
        return {
          providerId,
          persistence,
          status: 'available',
          kind: credential.type,
        }
      },
      options,
    )
  }

  status(providerId: string, options?: AuthOperationOptions): Promise<ProviderCredentialStatus> {
    return this.enqueue(
      providerId,
      async () => {
        const persistence = this.memoryProviders.has(providerId) ? 'memory_only' : 'persistent'
        const status = await this.activeStore(providerId).status(providerId, options)
        return {
          providerId,
          persistence,
          status: status.status,
          ...(status.kind ? { kind: status.kind } : {}),
        }
      },
      options,
    )
  }

  private activeStore(providerId: string): OpenGenOfficeCredentialStore {
    this.providers.add(providerId)
    return this.memoryProviders.has(providerId) ? this.memory : this.persistent
  }

  private enqueue<T>(
    providerId: string,
    operation: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    this.providers.add(providerId)
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
