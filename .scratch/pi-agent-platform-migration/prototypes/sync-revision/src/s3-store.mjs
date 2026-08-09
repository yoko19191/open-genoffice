import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

import { CasMismatchError } from './repository.mjs'

function preconditionFailed(error) {
  return error?.$metadata?.httpStatusCode === 412 || error?.name === 'PreconditionFailed'
}

function notFound(error) {
  return error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey'
}

function encryptionParameters(encryption) {
  if (!encryption) return {}
  if (encryption.algorithm === 'AES256') return { ServerSideEncryption: 'AES256' }
  if (encryption.algorithm === 'aws:kms' && encryption.kmsKeyId)
    return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: encryption.kmsKeyId }
  throw new TypeError('S3 encryption must be AES256 or aws:kms with a key ID')
}

export class S3ObjectStore {
  constructor({ client, bucket, prefix = '', encryption }) {
    if (!client || typeof client.send !== 'function') throw new TypeError('S3 client is required')
    if (typeof bucket !== 'string' || bucket.length === 0)
      throw new TypeError('S3 bucket is required')
    this.client = client
    this.bucket = bucket
    this.prefix = prefix.replace(/^\/+|\/+$/gu, '')
    this.encryption = encryptionParameters(encryption)
  }

  key(key) {
    return this.prefix ? `${this.prefix}/${key}` : key
  }

  async get(key) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      )
      if (!response.ETag) throw new Error('S3 provider did not return an ETag')
      return {
        bytes: new Uint8Array(await response.Body.transformToByteArray()),
        versionToken: response.ETag,
      }
    } catch (error) {
      if (notFound(error)) return null
      throw error
    }
  }

  async putIfAbsent(key, bytes) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Body: bytes,
          IfNoneMatch: '*',
          ...this.encryption,
        }),
      )
      return { created: true }
    } catch (error) {
      if (preconditionFailed(error)) return { created: false }
      throw error
    }
  }

  async compareAndSwap(key, bytes, expectedVersionToken) {
    try {
      const response = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Body: bytes,
          ...(expectedVersionToken ? { IfMatch: expectedVersionToken } : { IfNoneMatch: '*' }),
          ...this.encryption,
        }),
      )
      if (!response.ETag) throw new Error('S3 provider did not return an ETag')
      return { versionToken: response.ETag }
    } catch (error) {
      if (preconditionFailed(error)) throw new CasMismatchError()
      throw error
    }
  }
}
