import { describe, expect, it } from 'vitest'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { S3ObjectStore, type S3ClientPort } from '../src/sync/s3-object-store.js'

class FakeS3Client implements S3ClientPort {
  readonly objects = new Map<string, { bytes: Uint8Array; generation: number }>()
  readonly inputs: unknown[] = []
  available = true
  forceConflict = false
  conditionalRaces = 0
  hideObjects = false
  invalidBody = false
  etagOverride: string | null | undefined
  encryptionOverride: 'AES256' | 'aws:kms' | null | undefined

  async send(command: GetObjectCommand | PutObjectCommand): Promise<any> {
    if (!this.available) throw new Error('provider unavailable')
    this.inputs.push(command.input)
    const input = command.input as {
      Key: string
      IfMatch?: string
      IfNoneMatch?: string
      Body?: Uint8Array
      ServerSideEncryption?: 'AES256' | 'aws:kms'
    }
    const current = this.objects.get(input.Key)
    if (command instanceof GetObjectCommand) {
      if (!current || this.hideObjects) throw serviceError('NoSuchKey', 404)
      return {
        Body: this.invalidBody ? {} : { transformToByteArray: async () => current.bytes.slice() },
        ETag:
          this.etagOverride === undefined
            ? `"g${current.generation}-multipart"`
            : (this.etagOverride ?? undefined),
        LastModified: new Date('2099-01-01T00:00:00Z'),
      }
    }
    if (this.conditionalRaces > 0) {
      this.conditionalRaces -= 1
      throw serviceError('ConditionalRequestConflict', 409)
    }
    if (
      this.forceConflict ||
      (input.IfNoneMatch === '*' && current) ||
      (input.IfMatch && input.IfMatch !== `"g${current?.generation}-multipart"`)
    ) {
      throw serviceError('PreconditionFailed', 412)
    }
    const generation = (current?.generation ?? 0) + 1
    this.objects.set(input.Key, { bytes: new Uint8Array(input.Body!), generation })
    return {
      ETag: `"g${generation}-multipart"`,
      ServerSideEncryption:
        this.encryptionOverride === undefined
          ? input.ServerSideEncryption
          : (this.encryptionOverride ?? undefined),
    }
  }
}

function serviceError(name: string, statusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    message: name,
    $fault: 'client',
    $metadata: { httpStatusCode: statusCode },
  })
}

function makeStore(client: FakeS3Client, overrides: Record<string, unknown> = {}): S3ObjectStore {
  return new S3ObjectStore({
    region: 'us-east-1',
    bucket: 'genoffice-test',
    encryption: { type: 'AES256' },
    client,
    ...overrides,
  })
}

describe('S3ObjectStore', () => {
  it('fails closed on insecure endpoints and exposes path-style config only when requested', () => {
    expect(
      () =>
        new S3ObjectStore({
          endpoint: 'http://s3.example.test',
          region: 'us-east-1',
          bucket: 'bucket',
          encryption: { type: 'AES256' },
        }),
    ).toThrow(/sync_tls_required/)

    let captured: S3ClientConfig | undefined
    const client = new FakeS3Client()
    new S3ObjectStore({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'bucket',
      prefix: 'tenant-a',
      forcePathStyle: true,
      encryption: { type: 'AES256' },
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      allowLoopbackHttpForTests: true,
      clientFactory: (config) => {
        captured = config
        return client
      },
    })
    expect(captured).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 3,
    })

    expect(
      () =>
        new S3ObjectStore({
          endpoint: 'https://s3.example.test',
          region: 'us-east-1',
          bucket: 'bucket',
          encryption: { type: 'AES256' },
          credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
        }),
    ).not.toThrow()
  })

  it('uses SHA-256 objects, opaque multipart ETags and conditional PutObject', async () => {
    const client = new FakeS3Client()
    const store = makeStore(client, { prefix: 'tenant-a' })
    await expect(store.probe()).resolves.toEqual({
      ok: true,
      conditionalPut: true,
      strongEtag: true,
    })
    const key = `open-genoffice-sync/v1/project/a/blobs/sha256/aa/${'a'.repeat(64)}`
    await expect(store.putImmutable(key, new Uint8Array([1, 2, 3]))).resolves.toBe('created')
    await expect(store.putImmutable(key, new Uint8Array([9]))).resolves.toBe('already-exists')
    await expect(store.get(key)).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      versionToken: '"g1-multipart"',
    })
    await expect(store.get('open-genoffice-sync/v1/project/a/missing')).resolves.toBeNull()
    const puts = client.inputs.filter((input: any) => input.Body)
    expect(puts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Key: expect.stringContaining('tenant-a/open-genoffice-sync/v1/'),
          IfNoneMatch: '*',
          ServerSideEncryption: 'AES256',
          ChecksumSHA256: expect.any(String),
        }),
      ]),
    )
    expect(puts.some((input: any) => 'LastModified' in input)).toBe(false)
  })

  it('maps precondition failures to conflict and sends SSE-KMS without exposing the key in results', async () => {
    const client = new FakeS3Client()
    const store = makeStore(client, {
      encryption: { type: 'aws:kms', keyId: 'kms-key-id' },
    })
    const key = 'open-genoffice-sync/v1/project/a/head.json'
    const created = await store.compareAndSwap(key, new Uint8Array([1]), 'absent')
    expect(created).toEqual({ versionToken: '"g1-multipart"' })
    await expect(store.compareAndSwap(key, new Uint8Array([2]), '"stale"')).resolves.toEqual({
      conflict: true,
    })
    expect(client.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: 'kms-key-id',
        }),
      ]),
    )
    expect(JSON.stringify(created)).not.toContain('kms-key-id')
  })

  it('reports provider, ETag, conditional-write and encryption incompatibilities', async () => {
    const unavailableClient = new FakeS3Client()
    unavailableClient.available = false
    await expect(makeStore(unavailableClient).probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_provider_unavailable',
    })

    const conflictClient = new FakeS3Client()
    const conflictStore = makeStore(conflictClient)
    await conflictStore.putImmutable(
      'open-genoffice-sync/v1/.provider-capability.json',
      new Uint8Array([1]),
    )
    conflictClient.forceConflict = true
    await expect(conflictStore.probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_conditional_put_required',
    })

    const missing = new FakeS3Client()
    missing.hideObjects = true
    await expect(makeStore(missing).probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_strong_etag_required',
    })

    const encryption = new FakeS3Client()
    encryption.encryptionOverride = null
    await expect(makeStore(encryption).probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_s3_encryption_unsupported',
    })
  })

  it('rejects invalid prefixes, object keys and incomplete KMS configuration', async () => {
    const client = new FakeS3Client()
    expect(() => makeStore(client, { prefix: '../escape' })).toThrow(/sync_path_invalid/)
    expect(() => makeStore(client, { encryption: { type: 'aws:kms', keyId: '' } })).toThrow(
      /sync_s3_encryption_invalid/,
    )
    expect(() => makeStore(client, { bucket: 'x' })).toThrow(/sync_s3_bucket_invalid/)
    expect(() => makeStore(client, { region: 'invalid_region' })).toThrow(/sync_s3_region_invalid/)
    expect(() => makeStore(client, { prefix: 'te\u0301nant' })).toThrow(/sync_s3_prefix_invalid/)
    expect(
      () =>
        new S3ObjectStore({
          region: 'us-east-1',
          bucket: 'bucket',
          encryption: { type: 'AES256' },
        }),
    ).toThrow(/sync_s3_credentials_required/)
    await expect(makeStore(client).get('../escape')).rejects.toThrow(/sync_path_invalid/)
  })

  it('rejects malformed object responses and unsafe endpoint components', async () => {
    const client = new FakeS3Client()
    const store = makeStore(client)
    const key = 'open-genoffice-sync/v1/project/a/head.json'
    await store.putImmutable(key, new Uint8Array([1]))

    client.invalidBody = true
    await expect(store.get(key)).rejects.toThrow(/sync_s3_body_invalid/)
    client.invalidBody = false
    for (const etag of [null, 'W/"weak"', 'unquoted']) {
      client.etagOverride = etag
      await expect(store.get(key)).rejects.toThrow(/sync_strong_etag_required/)
    }

    for (const endpoint of [
      'https://user:secret@s3.example.test',
      'https://s3.example.test?secret=value',
      'https://s3.example.test#fragment',
      'http://localhost:9000',
    ]) {
      expect(
        () =>
          new S3ObjectStore({
            endpoint,
            region: 'us-east-1',
            bucket: 'bucket',
            encryption: { type: 'AES256' },
            client,
          }),
      ).toThrow(/sync_tls_required/)
    }
  })

  it('retries a single immutable 409 but never replays a CAS race', async () => {
    const client = new FakeS3Client()
    const store = makeStore(client)
    const immutableKey = 'open-genoffice-sync/v1/project/a/blobs/sha256/aa/' + 'a'.repeat(64)
    client.conditionalRaces = 1
    await expect(store.putImmutable(immutableKey, new Uint8Array([1]))).resolves.toBe('created')

    client.conditionalRaces = 2
    await expect(
      store.putImmutable(
        'open-genoffice-sync/v1/project/a/blobs/sha256/bb/' + 'b'.repeat(64),
        new Uint8Array([2]),
      ),
    ).rejects.toMatchObject({ name: 'ConditionalRequestConflict' })

    client.conditionalRaces = 1
    await expect(
      store.compareAndSwap(
        'open-genoffice-sync/v1/project/a/head.json',
        new Uint8Array([1]),
        'absent',
      ),
    ).resolves.toEqual({ conflict: true })

    client.available = false
    await expect(
      store.compareAndSwap(
        'open-genoffice-sync/v1/project/a/head.json',
        new Uint8Array([1]),
        'absent',
      ),
    ).rejects.toThrow(/provider unavailable/)
  })
})
