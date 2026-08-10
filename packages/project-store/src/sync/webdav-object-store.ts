import { AuthType, createClient, type WebDAVClient, type WebDAVClientError } from 'webdav'
import { canonicalJsonBytes, canonicalizeSyncPath } from './canonical.js'
import type { ProviderDiagnostics, SyncObjectStore } from './types.js'

type WebDavAuth =
  | { type: 'basic' | 'digest'; username: string; password: string }
  | { type: 'bearer'; token: string }

export interface WebDavObjectStoreOptions {
  endpoint: string
  auth?: WebDavAuth
  allowLoopbackHttpForTests?: boolean
}

function statusOf(error: unknown): number | undefined {
  return (error as WebDAVClientError | undefined)?.status
}

function strongVersionToken(value: string | null | undefined): string | null {
  if (!value || value.startsWith('W/')) return null
  return /^"[^"\r\n]+"$/.test(value) ? value : null
}

export class WebDavObjectStore implements SyncObjectStore {
  readonly #client: WebDAVClient
  readonly #knownCollections = new Set<string>()

  constructor(options: WebDavObjectStoreOptions) {
    const url = new URL(options.endpoint)
    const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(options.allowLoopbackHttpForTests && isLoopback)) {
      throw new Error('sync_tls_required')
    }
    const clientOptions: Parameters<typeof createClient>[1] = {}
    if (options.auth?.type === 'bearer') {
      clientOptions.headers = { Authorization: `Bearer ${options.auth.token}` }
    } else if (options.auth) {
      clientOptions.authType = options.auth.type === 'digest' ? AuthType.Digest : AuthType.Password
      clientOptions.username = options.auth.username
      clientOptions.password = options.auth.password
    }
    this.#client = createClient(options.endpoint.replace(/\/$/, ''), clientOptions)
  }

  async probe(): Promise<ProviderDiagnostics> {
    try {
      await this.#client.customRequest('/', { method: 'OPTIONS' })
      const key = 'open-genoffice-sync/v1/.provider-capability.json'
      const bytes = canonicalJsonBytes({ schemaVersion: 1, purpose: 'conditional-write-probe' })
      await this.putImmutable(key, bytes)
      const current = await this.get(key)
      if (!current) {
        return {
          ok: false,
          strongEtag: false,
          conditionalPut: false,
          code: 'sync_strong_etag_required',
        }
      }
      const result = await this.compareAndSwap(key, bytes, current.versionToken)
      if ('conflict' in result) {
        return {
          ok: false,
          strongEtag: true,
          conditionalPut: false,
          code: 'sync_conditional_put_required',
        }
      }
      return { ok: true, strongEtag: true, conditionalPut: true }
    } catch (error) {
      if (error instanceof Error && error.message === 'sync_strong_etag_required') {
        return {
          ok: false,
          strongEtag: false,
          conditionalPut: false,
          code: 'sync_strong_etag_required',
        }
      }
      return {
        ok: false,
        strongEtag: false,
        conditionalPut: false,
        code: 'sync_provider_unavailable',
      }
    }
  }

  async get(key: string): Promise<{ bytes: Uint8Array; versionToken: string } | null> {
    this.#assertKey(key)
    try {
      const response = (await this.#client.getFileContents(`/${key}`, {
        details: true,
        format: 'binary',
      })) as { data: Buffer | ArrayBuffer; headers: Record<string, string> }
      const etag = strongVersionToken(response.headers.etag)
      if (!etag) throw new Error('sync_strong_etag_required')
      const bytes = new Uint8Array(response.data)
      return { bytes: bytes.slice(), versionToken: etag }
    } catch (error) {
      if (statusOf(error) === 404) return null
      throw error
    }
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<'created' | 'already-exists'> {
    this.#assertKey(key)
    await this.#ensureCollections(key)
    const created = await this.#client.putFileContents(`/${key}`, Buffer.from(bytes), {
      overwrite: false,
      contentLength: bytes.byteLength,
    })
    return created ? 'created' : 'already-exists'
  }

  async compareAndSwap(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | 'absent',
  ): Promise<{ versionToken: string } | { conflict: true }> {
    this.#assertKey(key)
    await this.#ensureCollections(key)
    try {
      const response = await this.#client.customRequest(`/${key}`, {
        method: 'PUT',
        data: Buffer.from(bytes),
        headers:
          expectedVersion === 'absent'
            ? { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' }
            : { 'If-Match': expectedVersion, 'Content-Type': 'application/octet-stream' },
      })
      const etag = strongVersionToken(response.headers.get('etag'))
      if (!etag) throw new Error('sync_strong_etag_required')
      return { versionToken: etag }
    } catch (error) {
      if (statusOf(error) === 412) return { conflict: true }
      throw error
    }
  }

  async #ensureCollections(key: string): Promise<void> {
    const segments = key.split('/').slice(0, -1)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      if (this.#knownCollections.has(current)) continue
      try {
        await this.#client.customRequest(current, { method: 'MKCOL' })
      } catch (error) {
        if (statusOf(error) !== 405) throw error
      }
      this.#knownCollections.add(current)
    }
  }

  #assertKey(key: string): void {
    if (canonicalizeSyncPath(key) !== key || !key.startsWith('open-genoffice-sync/v1/')) {
      throw new Error('sync_object_key_invalid')
    }
  }
}
