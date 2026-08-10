import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectSyncReconciler } from '../src/sync/project-sync-reconciler.js'
import { S3ObjectStore, type S3ClientPort } from '../src/sync/s3-object-store.js'
import {
  EXPECTED_PROVIDER_HEADS,
  projectSyncFixture,
  PROVIDER_CONTRACT_SCOPE,
  tombstoneDocument,
} from './fixtures/project-sync-fixture.js'
import {
  EXPECTED_GLOBAL_ASSET_PROVIDER_RESULT,
  runGlobalAssetProviderContract,
} from './fixtures/global-asset-sync-contract.js'

const endpoint = process.env.GENOFFICE_TEST_MINIO_ENDPOINT
const accessKeyId = process.env.GENOFFICE_TEST_MINIO_ACCESS_KEY
const secretAccessKey = process.env.GENOFFICE_TEST_MINIO_SECRET_KEY
const bucket = process.env.GENOFFICE_TEST_MINIO_BUCKET
const enabled = Boolean(endpoint && accessKeyId && secretAccessKey && bucket)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(enabled)('MinIO Project repository contract', () => {
  it('shares canonical revisions across upload, incremental restore, CAS conflict and tombstone', async () => {
    const credentials = { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }
    const client = new S3Client({
      endpoint: endpoint!,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials,
      maxAttempts: 3,
    })
    await client.send(new CreateBucketCommand({ Bucket: bucket! })).catch((error: unknown) => {
      if ((error as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw error
    })
    const prefix = `contract-${process.pid}-${Date.now()}`

    let injectConditionalRace = true
    const retryClient: S3ClientPort = {
      send: async (command) => {
        if (injectConditionalRace && command instanceof PutObjectCommand) {
          injectConditionalRace = false
          throw Object.assign(new Error('injected conditional race'), {
            name: 'ConditionalRequestConflict',
            $metadata: { httpStatusCode: 409 },
          })
        }
        return client.send(command as never)
      },
    }
    const retryStore = new S3ObjectStore({
      region: 'us-east-1',
      bucket: bucket!,
      prefix,
      encryption: { type: 'AES256' },
      client: retryClient,
    })
    const retryKey = `open-genoffice-sync/v1/project/${PROVIDER_CONTRACT_SCOPE}/retry.json`
    await expect(retryStore.putImmutable(retryKey, new Uint8Array([1, 2, 3]))).resolves.toBe(
      'created',
    )
    expect(injectConditionalRace).toBe(false)
    await expect(retryStore.get(retryKey)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
    })

    const makeStore = () =>
      new S3ObjectStore({
        endpoint: endpoint!,
        region: 'us-east-1',
        bucket: bucket!,
        prefix,
        forcePathStyle: true,
        credentials,
        encryption: { type: 'AES256' },
        allowLoopbackHttpForTests: true,
      })
    await expect(runGlobalAssetProviderContract(makeStore)).resolves.toEqual(
      EXPECTED_GLOBAL_ASSET_PROVIDER_RESULT,
    )
    const scopeId = PROVIDER_CONTRACT_SCOPE
    const publisher = new ProjectSyncReconciler({
      store: makeStore(),
      scopeId,
      authorDeviceId: 'device-a',
    })
    const initialEntries = projectSyncFixture(scopeId)
    const initial = await publisher.publish(initialEntries)
    expect(initial.status).toBe('published')
    if (initial.status !== 'published') throw new Error('initial_publish_failed')
    expect(initial.head).toEqual(EXPECTED_PROVIDER_HEADS.initial)

    const updatedEntries = projectSyncFixture(scopeId, 'office-content-v2')
    const updated = await publisher.publish(updatedEntries, initial.remoteBase)
    expect(updated.status).toBe('published')
    if (updated.status !== 'published') throw new Error('incremental_publish_failed')
    expect(updated.head).toEqual(EXPECTED_PROVIDER_HEADS.updated)
    expect(updated.manifest.entries.filter((entry) => entry.tombstone)).toEqual([])

    const cleanRoot = await mkdtemp(join(tmpdir(), 'project-sync-minio-'))
    roots.push(cleanRoot)
    const cleanClient = new ProjectSyncReconciler({
      store: makeStore(),
      scopeId,
      authorDeviceId: 'device-b',
    })
    await expect(cleanClient.restore(cleanRoot)).resolves.toMatchObject({
      status: 'restored',
      manifestHash: updated.head.manifestHash,
    })
    expect(await readFile(join(cleanRoot, 'documents/report.docx'), 'utf8')).toBe(
      'office-content-v2',
    )

    const headKey = `open-genoffice-sync/v1/project/${scopeId}/head.json`
    const staleCas = await makeStore().compareAndSwap(
      headKey,
      new TextEncoder().encode('{}'),
      initial.remoteBase.versionToken,
    )
    expect(staleCas).toEqual({ conflict: true })

    const deleted = await publisher.publish(tombstoneDocument(updatedEntries), updated.remoteBase)
    expect(deleted.status).toBe('published')
    if (deleted.status !== 'published') throw new Error('tombstone_publish_failed')
    expect(deleted.head).toEqual(EXPECTED_PROVIDER_HEADS.deleted)
    const tombstone = deleted.manifest.entries.find(
      (entry) => entry.canonicalPath === 'documents/report.docx',
    )
    expect(tombstone).toMatchObject({ tombstone: true, size: 0 })
    expect(tombstone).not.toHaveProperty('contentHash')
    await expect(cleanClient.restore(cleanRoot)).resolves.toMatchObject({
      status: 'deletion_confirmation_required',
      canonicalPath: 'documents/report.docx',
    })
    expect(await readFile(join(cleanRoot, 'documents/report.docx'), 'utf8')).toBe(
      'office-content-v2',
    )
  })
})
