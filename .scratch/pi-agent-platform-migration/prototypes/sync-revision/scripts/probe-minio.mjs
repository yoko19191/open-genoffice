import { randomBytes } from 'node:crypto'

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'

import { createManifest, createRevision } from '../src/model.mjs'
import { CasMismatchError, createSyncRepository } from '../src/repository.mjs'
import { S3ObjectStore } from '../src/s3-store.mjs'

const endpoint = process.env.SPIKE06_MINIO_ENDPOINT ?? 'http://127.0.0.1:19000'
const accessKeyId = process.env.SPIKE06_MINIO_ACCESS_KEY ?? 'spike06-access'
const secretAccessKey = process.env.SPIKE06_MINIO_SECRET_KEY ?? 'spike06-secret'
const bucket = `open-genoffice-spike06-${randomBytes(6).toString('hex')}`
const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
})

await client.send(new CreateBucketCommand({ Bucket: bucket }))
try {
  const store = new S3ObjectStore({ client, bucket, prefix: 'sync' })
  const repository = createSyncRepository(store, { namespace: 'global', scopeId: 'probe-global' })
  const content = new TextEncoder().encode('minio-probe')
  const revision = createRevision({
    namespace: 'global',
    scopeId: 'probe-global',
    path: 'prompts/probe.md',
    kind: 'prompt',
    contentBytes: content,
    authorDeviceId: 'probe-device',
  })
  const manifest = createManifest({
    namespace: 'global',
    scopeId: 'probe-global',
    generation: 0,
    revisions: [revision],
    writerDeviceId: 'probe-device',
  })
  await repository.publishRevision(revision, content)
  const commit = await repository.commitHead(manifest, null)
  const loaded = await repository.loadHead()
  if (loaded.manifest.manifestId !== manifest.manifestId)
    throw new Error('manifest round-trip failed')
  let staleCasRejected = false
  try {
    await repository.commitHead(manifest, null)
  } catch (error) {
    staleCasRejected = error instanceof CasMismatchError
  }
  if (!staleCasRejected) throw new Error('stale S3 CAS was not rejected')
  process.stdout.write(
    `${JSON.stringify({ provider: 'minio', manifestId: manifest.manifestId, versionToken: commit.versionToken, staleCasRejected })}\n`,
  )
} finally {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }))
  if (listed.Contents?.length)
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: listed.Contents.map(({ Key }) => ({ Key })) },
      }),
    )
  await client.send(new DeleteBucketCommand({ Bucket: bucket }))
  client.destroy()
}
