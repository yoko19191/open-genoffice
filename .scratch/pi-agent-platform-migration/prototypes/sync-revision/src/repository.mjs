import { canonicalJson, remoteLayout, sha256, verifyManifest, verifyRevision } from './model.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class CasMismatchError extends Error {
  constructor(message = 'remote head changed') {
    super(message)
    this.name = 'CasMismatchError'
  }
}

export class MemoryObjectStore {
  #objects = new Map()
  #version = 0

  async get(key) {
    const object = this.#objects.get(key)
    return object ? { bytes: object.bytes.slice(), versionToken: object.versionToken } : null
  }

  async putIfAbsent(key, bytes) {
    if (this.#objects.has(key)) return { created: false }
    this.#version += 1
    this.#objects.set(key, { bytes: bytes.slice(), versionToken: `"memory-${this.#version}"` })
    return { created: true }
  }

  async compareAndSwap(key, bytes, expectedVersionToken) {
    const current = this.#objects.get(key)
    const currentToken = current?.versionToken ?? null
    if (currentToken !== expectedVersionToken) throw new CasMismatchError()
    this.#version += 1
    const versionToken = `"memory-${this.#version}"`
    this.#objects.set(key, { bytes: bytes.slice(), versionToken })
    return { versionToken }
  }
}

async function putImmutable(store, key, bytes) {
  const result = await store.putIfAbsent(key, bytes)
  if (result.created) return
  const existing = await store.get(key)
  if (!existing || sha256(existing.bytes) !== sha256(bytes))
    throw new Error(`immutable sync object collision at ${key}`)
}

export function createSyncRepository(store, { namespace, scopeId }) {
  const layout = remoteLayout(namespace, scopeId)
  return {
    async publishRevision(revision, contentBytes) {
      verifyRevision(revision)
      if (revision.namespace !== namespace || revision.scopeId !== scopeId)
        throw new TypeError('revision belongs to another repository')
      if (revision.tombstone) {
        if (contentBytes !== undefined)
          throw new TypeError('tombstone publication cannot include bytes')
      } else {
        if (!(contentBytes instanceof Uint8Array) || sha256(contentBytes) !== revision.contentHash)
          throw new TypeError('revision bytes do not match content hash')
        await putImmutable(store, layout.blob(revision.contentHash), contentBytes)
      }
      await putImmutable(
        store,
        layout.revision(revision.revisionId),
        encoder.encode(canonicalJson(revision)),
      )
    },

    async loadHead() {
      const object = await store.get(layout.head)
      if (!object) return { manifest: null, versionToken: null }
      let manifest
      try {
        manifest = JSON.parse(decoder.decode(object.bytes))
      } catch {
        throw new Error('remote manifest is not valid JSON')
      }
      verifyManifest(manifest)
      if (manifest.namespace !== namespace || manifest.scopeId !== scopeId)
        throw new Error('remote manifest belongs to another repository')
      return { manifest, versionToken: object.versionToken }
    },

    async commitHead(manifest, expectedVersionToken) {
      verifyManifest(manifest)
      if (manifest.namespace !== namespace || manifest.scopeId !== scopeId)
        throw new TypeError('manifest belongs to another repository')
      return store.compareAndSwap(
        layout.head,
        encoder.encode(canonicalJson(manifest)),
        expectedVersionToken,
      )
    },
  }
}
