import {
  ProviderUnavailableError,
  type ProviderDiagnostics,
  type SyncObjectStore,
} from './types.js'

interface MemoryObject {
  bytes: Uint8Array
  generation: number
}

export class InMemorySyncObjectStore implements SyncObjectStore {
  readonly #objects = new Map<string, MemoryObject>()
  available = true
  immutableWriteCount = 0

  async probe(): Promise<ProviderDiagnostics> {
    this.#assertAvailable()
    return { ok: true, strongEtag: true, conditionalPut: true }
  }

  async get(key: string): Promise<{ bytes: Uint8Array; versionToken: string } | null> {
    this.#assertAvailable()
    const object = this.#objects.get(key)
    return object
      ? { bytes: object.bytes.slice(), versionToken: this.#versionToken(object.generation) }
      : null
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<'created' | 'already-exists'> {
    this.#assertAvailable()
    if (this.#objects.has(key)) return 'already-exists'
    this.#objects.set(key, { bytes: bytes.slice(), generation: 1 })
    this.immutableWriteCount += 1
    return 'created'
  }

  async compareAndSwap(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | 'absent',
  ): Promise<{ versionToken: string } | { conflict: true }> {
    this.#assertAvailable()
    const current = this.#objects.get(key)
    if (
      (expectedVersion === 'absent' && current) ||
      (expectedVersion !== 'absent' &&
        (!current || expectedVersion !== this.#versionToken(current.generation)))
    ) {
      return { conflict: true }
    }
    const generation = (current?.generation ?? 0) + 1
    this.#objects.set(key, { bytes: bytes.slice(), generation })
    return { versionToken: this.#versionToken(generation) }
  }

  #versionToken(generation: number): string {
    return `"g${generation}"`
  }

  #assertAvailable(): void {
    if (!this.available) throw new ProviderUnavailableError()
  }
}
