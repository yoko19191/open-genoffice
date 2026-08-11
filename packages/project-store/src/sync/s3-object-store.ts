import { createHash } from 'node:crypto'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { assertSyncObjectKey, canonicalJsonBytes, canonicalizeSyncPath } from './canonical.js'
import type { ProviderDiagnostics, SyncObjectStore } from './types.js'

export interface S3ClientPort {
  send(command: GetObjectCommand | PutObjectCommand): Promise<any>
}

type S3Encryption = { type: 'AES256' } | { type: 'aws:kms'; keyId: string }

export interface S3ObjectStoreOptions {
  region: string
  bucket: string
  endpoint?: string
  prefix?: string
  forcePathStyle?: boolean
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  encryption: S3Encryption
  allowLoopbackHttpForTests?: boolean
  client?: S3ClientPort
  clientFactory?: (config: S3ClientConfig) => S3ClientPort
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode
}

function isMissing(error: unknown): boolean {
  return statusOf(error) === 404 || (error as { name?: string } | undefined)?.name === 'NoSuchKey'
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    statusOf(error) === 412 ||
    (error as { name?: string } | undefined)?.name === 'PreconditionFailed'
  )
}

function isConditionalRace(error: unknown): boolean {
  return (
    statusOf(error) === 409 ||
    (error as { name?: string } | undefined)?.name === 'ConditionalRequestConflict'
  )
}

function versionToken(value: string | undefined): string {
  if (!value || value.startsWith('W/') || !/^"[^"\r\n]+"$/.test(value)) {
    throw new Error('sync_strong_etag_required')
  }
  return value
}

export class S3ObjectStore implements SyncObjectStore {
  readonly #client: S3ClientPort
  readonly #bucket: string
  readonly #prefix?: string
  readonly #encryption: S3Encryption

  constructor(options: S3ObjectStoreOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,61}[A-Za-z0-9]$/.test(options.bucket)) {
      throw new Error('sync_s3_bucket_invalid')
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(options.region)) {
      throw new Error('sync_s3_region_invalid')
    }
    if (options.encryption.type === 'aws:kms' && options.encryption.keyId.length === 0) {
      throw new Error('sync_s3_encryption_invalid')
    }
    if (options.endpoint) this.#assertEndpoint(options.endpoint, options.allowLoopbackHttpForTests)
    if (!options.client && !options.clientFactory && !options.credentials) {
      throw new Error('sync_s3_credentials_required')
    }
    if (options.prefix) {
      const prefix = canonicalizeSyncPath(options.prefix)
      if (prefix !== options.prefix) throw new Error('sync_s3_prefix_invalid')
      this.#prefix = prefix
    }
    const config: S3ClientConfig = {
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? false,
      ...(options.credentials ? { credentials: options.credentials } : {}),
      maxAttempts: 3,
    }
    this.#client =
      options.client ?? options.clientFactory?.(config) ?? (new S3Client(config) as S3ClientPort)
    this.#bucket = options.bucket
    this.#encryption = options.encryption
  }

  async probe(): Promise<ProviderDiagnostics> {
    try {
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
        return { ok: false, strongEtag: false, conditionalPut: false, code: error.message }
      }
      if (error instanceof Error && error.message === 'sync_s3_encryption_unsupported') {
        return { ok: false, strongEtag: false, conditionalPut: false, code: error.message }
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
    try {
      const output = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(key) }),
      )
      if (!output.Body || typeof output.Body.transformToByteArray !== 'function') {
        throw new Error('sync_s3_body_invalid')
      }
      return {
        bytes: new Uint8Array(await output.Body.transformToByteArray()),
        versionToken: versionToken(output.ETag),
      }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<'created' | 'already-exists'> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#put(key, bytes, { IfNoneMatch: '*' })
        return 'created'
      } catch (error) {
        if (isPreconditionFailure(error)) return 'already-exists'
        if (!isConditionalRace(error) || attempt === 1) throw error
      }
    }
    throw new Error('sync_provider_unavailable')
  }

  async compareAndSwap(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | 'absent',
  ): Promise<{ versionToken: string } | { conflict: true }> {
    try {
      const output = await this.#put(
        key,
        bytes,
        expectedVersion === 'absent' ? { IfNoneMatch: '*' } : { IfMatch: expectedVersion },
      )
      return { versionToken: versionToken(output.ETag) }
    } catch (error) {
      if (isPreconditionFailure(error) || isConditionalRace(error)) return { conflict: true }
      throw error
    }
  }

  async #put(
    key: string,
    bytes: Uint8Array,
    condition: { IfNoneMatch: '*' } | { IfMatch: string },
  ): Promise<any> {
    const encryption =
      this.#encryption.type === 'AES256'
        ? { ServerSideEncryption: 'AES256' as const }
        : { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: this.#encryption.keyId }
    const output = await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: this.#key(key),
        Body: bytes,
        ContentLength: bytes.byteLength,
        ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        ...condition,
        ...encryption,
      }),
    )
    if (output.ServerSideEncryption !== this.#encryption.type) {
      throw new Error('sync_s3_encryption_unsupported')
    }
    return output
  }

  #key(key: string): string {
    const canonical = assertSyncObjectKey(key)
    return this.#prefix ? `${this.#prefix}/${canonical}` : canonical
  }

  #assertEndpoint(endpoint: string, allowLoopbackHttpForTests?: boolean): void {
    const url = new URL(endpoint)
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(allowLoopbackHttpForTests && loopback))
    ) {
      throw new Error('sync_tls_required')
    }
  }
}
