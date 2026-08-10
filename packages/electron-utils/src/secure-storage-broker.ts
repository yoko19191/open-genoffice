import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  atomicWriteFile,
  atomicWriteJson,
  initializeAgentResourceHome,
  type AgentResourceHome,
} from '@genoffice/agent-resource'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export type SecureStorageBackend =
  'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'

export type SafeStorageAdapter = {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend(): SecureStorageBackend
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export type SecureStorageFailurePoint = 'after_blob_commit' | 'after_index_commit'

export type CredentialKind = 'api_key' | 'oauth'

export type CredentialMetadata = {
  credentialId: string
  slot: string
  providerId: string
  kind: CredentialKind
  generation: number
  status: 'available'
}

export type CredentialStatus =
  CredentialMetadata | { slot: string; status: 'missing' | 'secure_storage_unavailable' }

export type CredentialWrite = {
  slot: string
  providerId: string
  kind: CredentialKind
  expectedGeneration: number
  secretPayload: string
}

export type OperationCapsuleWrite = {
  operationId: string
  expectedGeneration: number
  generation: number
  payload: string
}

export type SecureStorageBrokerOptions = {
  rootDirectory: string
  runtimeVersion: string
  platform?: NodeJS.Platform
  safeStorage: SafeStorageAdapter
  randomUUID?: () => string
  failAt?: SecureStorageFailurePoint
}

const CredentialMetadataSchema = Type.Object(
  {
    credentialId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
    slot: Type.String({ minLength: 1, maxLength: 256 }),
    providerId: Type.String({ minLength: 1, maxLength: 128 }),
    kind: Type.Union([Type.Literal('api_key'), Type.Literal('oauth')]),
    generation: Type.Integer({ minimum: 1 }),
    status: Type.Literal('available'),
  },
  { additionalProperties: false },
)

const SecureStorageIndexSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    entries: Type.Array(CredentialMetadataSchema),
  },
  { additionalProperties: false },
)

type SecureStorageIndex = Static<typeof SecureStorageIndexSchema>

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class SecureStorageBrokerError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'SecureStorageBrokerError'
    this.code = code
  }
}

function injectedFailure(): Error {
  return new Error('injected_secure_storage_failure')
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class SecureStorageBroker {
  private readonly home: AgentResourceHome
  private readonly platform: NodeJS.Platform
  private readonly safeStorage: SafeStorageAdapter
  private readonly createCredentialId: () => string
  private readonly failAt: SecureStorageFailurePoint | undefined
  private readonly slotQueues = new Map<string, Promise<void>>()
  private indexQueue: Promise<void> = Promise.resolve()

  private constructor(home: AgentResourceHome, options: SecureStorageBrokerOptions) {
    this.home = home
    this.platform = options.platform ?? process.platform
    this.safeStorage = options.safeStorage
    this.createCredentialId = options.randomUUID ?? randomUUID
    this.failAt = options.failAt
  }

  static async create(options: SecureStorageBrokerOptions): Promise<SecureStorageBroker> {
    const home = await initializeAgentResourceHome({
      rootDirectory: options.rootDirectory,
      runtimeVersion: options.runtimeVersion,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    })
    return new SecureStorageBroker(home, options)
  }

  put(input: CredentialWrite): Promise<CredentialMetadata> {
    return this.withSlot(input.slot, () => this.commit(input))
  }

  rotate(input: CredentialWrite): Promise<CredentialMetadata> {
    return this.withSlot(input.slot, () => this.commit(input))
  }

  get(slot: string): Promise<{ metadata: CredentialMetadata; secretPayload: string } | undefined> {
    return this.withSlot(slot, async () => {
      const metadata = (await this.readIndex()).entries.find((entry) => entry.slot === slot)
      if (!metadata) return undefined
      await this.requirePersistentStorage()

      let decrypted: Awaited<ReturnType<SafeStorageAdapter['decryptStringAsync']>>
      try {
        const ciphertext = await readFile(this.blobPath(metadata.credentialId))
        decrypted = await this.safeStorage.decryptStringAsync(ciphertext)
      } catch {
        throw new SecureStorageBrokerError('credential_decrypt_failed')
      }

      if (!decrypted.shouldReEncrypt) {
        return { metadata, secretPayload: decrypted.result }
      }
      const reEncrypted = await this.commit({
        slot,
        providerId: metadata.providerId,
        kind: metadata.kind,
        expectedGeneration: metadata.generation,
        secretPayload: decrypted.result,
      })
      return { metadata: reEncrypted, secretPayload: decrypted.result }
    })
  }

  status(slot: string): Promise<CredentialStatus> {
    return this.withSlot(slot, async () => {
      const metadata = (await this.readIndex()).entries.find((entry) => entry.slot === slot)
      if (!metadata) {
        if (this.platform === 'linux') {
          const backend = this.safeStorage.getSelectedStorageBackend()
          if (backend === 'basic_text' || backend === 'unknown') {
            return { slot, status: 'secure_storage_unavailable' }
          }
        }
        return { slot, status: 'missing' }
      }
      if (!(await this.persistentStorageAvailable())) {
        return { slot, status: 'secure_storage_unavailable' }
      }
      return metadata
    })
  }

  delete(
    slot: string,
    expectedGeneration: number,
  ): Promise<{ slot: string; generation: number; status: 'deleted' }> {
    return this.withSlot(slot, async () => {
      await this.requirePersistentStorage()
      return this.withIndex(async () => {
        const index = await this.readIndex()
        const metadata = index.entries.find((entry) => entry.slot === slot)
        const currentGeneration = metadata?.generation ?? 0
        if (!metadata || currentGeneration !== expectedGeneration) {
          throw new SecureStorageBrokerError('credential_generation_conflict')
        }
        await this.writeIndex({
          schemaVersion: 1,
          entries: index.entries.filter((entry) => entry.slot !== slot),
        })
        await this.removeBlob(metadata.credentialId)
        return { slot, generation: metadata.generation, status: 'deleted' }
      })
    })
  }

  async putOperationCapsule(
    input: OperationCapsuleWrite,
  ): Promise<{ operationId: string; generation: number }> {
    this.assertOperationId(input.operationId)
    return this.withSlot(`capsule:${input.operationId}`, async () => {
      await this.requirePersistentStorage()
      const current = await this.readOperationCapsule(input.operationId)
      if (
        (current?.generation ?? 0) !== input.expectedGeneration ||
        input.generation !== input.expectedGeneration + 1 ||
        typeof input.payload !== 'string'
      ) {
        throw new SecureStorageBrokerError('operation_capsule_generation_conflict')
      }
      await this.writeOperationCapsule(input.operationId, input.generation, input.payload)
      return { operationId: input.operationId, generation: input.generation }
    })
  }

  async getOperationCapsule(
    operationId: string,
  ): Promise<{ operationId: string; generation: number; payload: string } | undefined> {
    this.assertOperationId(operationId)
    return this.withSlot(`capsule:${operationId}`, async () => {
      await this.requirePersistentStorage()
      const capsule = await this.readOperationCapsule(operationId)
      if (!capsule) return undefined
      if (capsule.shouldReEncrypt) {
        await this.writeOperationCapsule(operationId, capsule.generation, capsule.payload)
      }
      return { operationId, generation: capsule.generation, payload: capsule.payload }
    })
  }

  async deleteOperationCapsule(
    operationId: string,
    expectedGeneration: number,
  ): Promise<{ operationId: string; generation: number; status: 'deleted' }> {
    this.assertOperationId(operationId)
    return this.withSlot(`capsule:${operationId}`, async () => {
      await this.requirePersistentStorage()
      const current = await this.readOperationCapsule(operationId)
      if (!current || current.generation !== expectedGeneration) {
        throw new SecureStorageBrokerError('operation_capsule_generation_conflict')
      }
      await unlink(this.operationCapsulePath(operationId))
      return { operationId, generation: expectedGeneration, status: 'deleted' }
    })
  }

  private async commit(input: CredentialWrite): Promise<CredentialMetadata> {
    await this.requirePersistentStorage()
    return this.withIndex(async () => {
      const index = await this.readIndex()
      const previous = index.entries.find((entry) => entry.slot === input.slot)
      const currentGeneration = previous?.generation ?? 0
      if (currentGeneration !== input.expectedGeneration) {
        throw new SecureStorageBrokerError('credential_generation_conflict')
      }

      const metadata: CredentialMetadata = {
        credentialId: this.createCredentialId(),
        slot: input.slot,
        providerId: input.providerId,
        kind: input.kind,
        generation: currentGeneration + 1,
        status: 'available',
      }
      let ciphertext: Buffer
      try {
        ciphertext = await this.safeStorage.encryptStringAsync(input.secretPayload)
        await atomicWriteFile(this.blobPath(metadata.credentialId), ciphertext, {
          platform: this.platform,
        })
      } catch {
        throw new SecureStorageBrokerError('credential_persist_failed')
      }
      if (this.failAt === 'after_blob_commit') throw injectedFailure()

      const entries = index.entries.filter((entry) => entry.slot !== input.slot)
      await this.writeIndex({ schemaVersion: 1, entries: [...entries, metadata] })
      if (this.failAt === 'after_index_commit') throw injectedFailure()
      if (previous) await this.removeBlob(previous.credentialId)
      return metadata
    })
  }

  private async persistentStorageAvailable(): Promise<boolean> {
    if (!(await this.safeStorage.isAsyncEncryptionAvailable())) return false
    if (this.platform !== 'linux') return true
    const backend = this.safeStorage.getSelectedStorageBackend()
    return backend !== 'basic_text' && backend !== 'unknown'
  }

  private async requirePersistentStorage(): Promise<void> {
    if (!(await this.persistentStorageAvailable())) {
      throw new SecureStorageBrokerError('secure_storage_unavailable')
    }
  }

  private get indexPath(): string {
    return join(this.home.secureStoreDirectory, 'index.json')
  }

  private blobPath(credentialId: string): string {
    return join(this.home.credentialBlobsDirectory, `${credentialId}.bin`)
  }

  private operationCapsulePath(operationId: string): string {
    return join(this.home.operationCapsulesDirectory, `${operationId}.bin`)
  }

  private assertOperationId(operationId: string): void {
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new SecureStorageBrokerError('operation_capsule_invalid')
    }
  }

  private async readOperationCapsule(
    operationId: string,
  ): Promise<{ generation: number; payload: string; shouldReEncrypt: boolean } | undefined> {
    let ciphertext: Buffer
    try {
      ciphertext = await readFile(this.operationCapsulePath(operationId))
    } catch (error) {
      if (isMissingFile(error)) return undefined
      throw new SecureStorageBrokerError('operation_capsule_decrypt_failed')
    }
    try {
      const decrypted = await this.safeStorage.decryptStringAsync(ciphertext)
      const parsed: unknown = JSON.parse(decrypted.result)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Number.isInteger((parsed as { generation?: unknown }).generation) ||
        (parsed as { generation: number }).generation < 1 ||
        typeof (parsed as { payload?: unknown }).payload !== 'string'
      ) {
        throw new Error('invalid_capsule')
      }
      return {
        generation: (parsed as { generation: number }).generation,
        payload: (parsed as { payload: string }).payload,
        shouldReEncrypt: decrypted.shouldReEncrypt,
      }
    } catch {
      throw new SecureStorageBrokerError('operation_capsule_decrypt_failed')
    }
  }

  private async writeOperationCapsule(
    operationId: string,
    generation: number,
    payload: string,
  ): Promise<void> {
    try {
      const encrypted = await this.safeStorage.encryptStringAsync(
        JSON.stringify({ generation, payload }),
      )
      await atomicWriteFile(this.operationCapsulePath(operationId), encrypted, {
        platform: this.platform,
      })
    } catch {
      throw new SecureStorageBrokerError('operation_capsule_persist_failed')
    }
  }

  private async removeBlob(credentialId: string): Promise<void> {
    try {
      await unlink(this.blobPath(credentialId))
    } catch {
      // The index is authoritative; stale or already absent blobs cannot roll it back.
    }
  }

  private async readIndex(): Promise<SecureStorageIndex> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.indexPath, 'utf8'))
    } catch (error) {
      if (isMissingFile(error)) return { schemaVersion: 1, entries: [] }
      throw new SecureStorageBrokerError('credential_index_invalid')
    }
    if (!Value.Check(SecureStorageIndexSchema, parsed)) {
      throw new SecureStorageBrokerError('credential_index_invalid')
    }
    return parsed as SecureStorageIndex
  }

  private writeIndex(index: SecureStorageIndex): Promise<void> {
    return atomicWriteJson(this.indexPath, index, { platform: this.platform })
  }

  private withIndex<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.indexQueue.then(operation, operation)
    this.indexQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private withSlot<T>(slot: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.slotQueues.get(slot) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.slotQueues.set(slot, settled)
    void settled.finally(() => {
      if (this.slotQueues.get(slot) === settled) this.slotQueues.delete(slot)
    })
    return result
  }
}
