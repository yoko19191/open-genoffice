import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebDavObjectStore } from '../src/sync/webdav-object-store.js'
import { ProjectSyncReconciler } from '../src/sync/project-sync-reconciler.js'
import {
  EXPECTED_PROVIDER_HEADS,
  projectSyncFixture,
  PROVIDER_CONTRACT_SCOPE,
  tombstoneDocument,
} from './fixtures/project-sync-fixture.js'

type StoredObject = { bytes: Buffer; generation: number }

function strongEtag(object: StoredObject): string {
  return `"g${object.generation}"`
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe('WebDavObjectStore', () => {
  const objects = new Map<string, StoredObject>()
  let responseMode:
    | 'normal'
    | 'weak-etag'
    | 'invalid-etag'
    | 'missing-etag'
    | 'disappear-on-get'
    | 'force-cas-conflict'
    | 'put-error'
    | 'unavailable'
    | 'mkcol-exists'
    | 'mkcol-error' = 'normal'
  let endpoint = ''
  let closeServer: (() => Promise<void>) | undefined
  const temporaryRoots: string[] = []

  beforeEach(async () => {
    objects.clear()
    responseMode = 'normal'
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? '/', 'http://loopback').pathname
      if (request.method === 'OPTIONS') {
        if (responseMode === 'unavailable') {
          response.statusCode = 503
          response.end()
          return
        }
        response.setHeader('DAV', '1, 2')
        response.end()
        return
      }
      if (request.method === 'MKCOL') {
        if (responseMode === 'mkcol-error') {
          response.statusCode = 500
          response.end()
          return
        }
        if (responseMode === 'mkcol-exists') {
          response.statusCode = 405
          response.end()
          return
        }
        response.statusCode = 201
        response.end()
        return
      }
      if (request.method === 'GET') {
        const object = objects.get(path)
        if (!object || responseMode === 'disappear-on-get') {
          response.statusCode = 404
          response.end()
          return
        }
        if (responseMode !== 'missing-etag') {
          response.setHeader(
            'ETag',
            responseMode === 'weak-etag'
              ? `W/${strongEtag(object)}`
              : responseMode === 'invalid-etag'
                ? 'unquoted'
                : strongEtag(object),
          )
        }
        response.end(object.bytes)
        return
      }
      if (request.method === 'PUT') {
        if (responseMode === 'put-error') {
          response.statusCode = 500
          response.end()
          return
        }
        const current = objects.get(path)
        if (request.headers['if-none-match'] === '*' && current) {
          response.statusCode = 412
          response.end()
          return
        }
        if (
          typeof request.headers['if-match'] === 'string' &&
          request.headers['if-match'] !== strongEtag(current!)
        ) {
          response.statusCode = 412
          response.end()
          return
        }
        if (responseMode === 'force-cas-conflict' && request.headers['if-match']) {
          response.statusCode = 412
          response.end()
          return
        }
        const next = { bytes: await readBody(request), generation: (current?.generation ?? 0) + 1 }
        objects.set(path, next)
        response.statusCode = current ? 204 : 201
        if (responseMode !== 'missing-etag') response.setHeader('ETag', strongEtag(next))
        response.end()
        return
      }
      response.statusCode = 405
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback_start_failed')
    endpoint = `http://127.0.0.1:${address.port}`
    closeServer = async () => {
      server.close()
      await once(server, 'close')
    }
  })

  afterEach(async () => {
    await closeServer?.()
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  it('fails closed for non-TLS product endpoints', () => {
    expect(() => new WebDavObjectStore({ endpoint })).toThrow(/sync_tls_required/)
    expect(
      () =>
        new WebDavObjectStore({
          endpoint: endpoint.replace('127.0.0.1', 'example.test'),
          allowLoopbackHttpForTests: true,
        }),
    ).toThrow(/sync_tls_required/)
    expect(
      () =>
        new WebDavObjectStore({
          endpoint: 'https://example.test',
          auth: { type: 'bearer', token: 'opaque' },
        }),
    ).not.toThrow()
    expect(
      () =>
        new WebDavObjectStore({
          endpoint: 'https://example.test',
          auth: { type: 'basic', username: 'u', password: 'p' },
        }),
    ).not.toThrow()
    expect(
      () =>
        new WebDavObjectStore({
          endpoint: 'https://example.test',
          auth: { type: 'digest', username: 'u', password: 'p' },
        }),
    ).not.toThrow()
    expect(
      () =>
        new WebDavObjectStore({
          endpoint: endpoint.replace('127.0.0.1', 'localhost'),
          allowLoopbackHttpForTests: true,
        }),
    ).not.toThrow()
  })

  it('proves strong ETag and conditional writes against loopback', async () => {
    const store = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    await expect(store.probe()).resolves.toEqual({
      ok: true,
      conditionalPut: true,
      strongEtag: true,
    })

    const hash = 'a'.repeat(64)
    const key = `open-genoffice-sync/v1/project/project-a/blobs/sha256/aa/${hash}`
    await expect(store.putImmutable(key, new Uint8Array([1, 2, 3]))).resolves.toBe('created')
    await expect(store.putImmutable(key, new Uint8Array([9]))).resolves.toBe('already-exists')
    await expect(store.get(key)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      versionToken: '"g1"',
    })
    await expect(
      store.get('open-genoffice-sync/v1/project/project-a/head-missing.json'),
    ).resolves.toBeNull()

    const headKey = 'open-genoffice-sync/v1/project/project-a/head.json'
    const created = await store.compareAndSwap(headKey, new Uint8Array([1]), 'absent')
    expect(created).toEqual({ versionToken: '"g1"' })
    await expect(store.compareAndSwap(headKey, new Uint8Array([2]), '"stale"')).resolves.toEqual({
      conflict: true,
    })
    await expect(store.compareAndSwap(headKey, new Uint8Array([2]), '"g1"')).resolves.toEqual({
      versionToken: '"g2"',
    })
  })

  it('uploads and restores a complete Project through two clean WebDAV clients', async () => {
    const publisherStore = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    const publisher = new ProjectSyncReconciler({
      store: publisherStore,
      scopeId: PROVIDER_CONTRACT_SCOPE,
      authorDeviceId: 'device-a',
    })
    const published = await publisher.publish(projectSyncFixture(PROVIDER_CONTRACT_SCOPE))
    expect(published.status).toBe('published')
    if (published.status !== 'published') throw new Error('publish_failed')
    expect(published.head).toEqual(EXPECTED_PROVIDER_HEADS.initial)

    const updatedEntries = projectSyncFixture(PROVIDER_CONTRACT_SCOPE, 'office-content-v2')
    const updated = await publisher.publish(updatedEntries, published.remoteBase)
    expect(updated.status).toBe('published')
    if (updated.status !== 'published') throw new Error('incremental_publish_failed')
    expect(updated.head).toEqual(EXPECTED_PROVIDER_HEADS.updated)

    const targetRoot = await mkdtemp(join(tmpdir(), 'project-sync-webdav-'))
    temporaryRoots.push(targetRoot)
    const cleanStore = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    const cleanClient = new ProjectSyncReconciler({
      store: cleanStore,
      scopeId: PROVIDER_CONTRACT_SCOPE,
      authorDeviceId: 'device-b',
    })
    const restored = await cleanClient.restore(targetRoot)
    expect(restored).toMatchObject({
      status: 'restored',
      manifestHash: updated.head.manifestHash,
    })
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe(
      'office-content-v2',
    )
    expect(await readFile(join(targetRoot, '.open-genoffice/resources/skill.md'), 'utf8')).toBe(
      '# Project Skill',
    )
    expect(restored.status === 'restored' ? restored.manifest.entries : []).toEqual(
      updated.manifest.entries,
    )

    const deleted = await publisher.publish(tombstoneDocument(updatedEntries), updated.remoteBase)
    expect(deleted.status).toBe('published')
    if (deleted.status !== 'published') throw new Error('tombstone_publish_failed')
    expect(deleted.head).toEqual(EXPECTED_PROVIDER_HEADS.deleted)
    await expect(cleanClient.restore(targetRoot)).resolves.toMatchObject({
      status: 'deletion_confirmation_required',
      canonicalPath: 'documents/report.docx',
    })
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe(
      'office-content-v2',
    )
  })

  it('rejects missing or weak ETags', async () => {
    const store = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    responseMode = 'weak-etag'
    await expect(store.probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_strong_etag_required',
    })
    responseMode = 'missing-etag'
    await expect(store.get('open-genoffice-sync/v1/.provider-capability.json')).rejects.toThrow(
      /sync_strong_etag_required/,
    )
    responseMode = 'invalid-etag'
    await expect(store.get('open-genoffice-sync/v1/.provider-capability.json')).rejects.toThrow(
      /sync_strong_etag_required/,
    )
    responseMode = 'disappear-on-get'
    await expect(store.probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_strong_etag_required',
    })
  })

  it('reports unavailable and unsupported conditional writes without weakening the gate', async () => {
    const unavailable = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    responseMode = 'unavailable'
    await expect(unavailable.probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_provider_unavailable',
    })

    responseMode = 'normal'
    const conditional = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    await conditional.putImmutable(
      'open-genoffice-sync/v1/.provider-capability.json',
      new Uint8Array([1]),
    )
    responseMode = 'force-cas-conflict'
    await expect(conditional.probe()).resolves.toMatchObject({
      ok: false,
      code: 'sync_conditional_put_required',
    })
  })

  it('accepts existing collections and surfaces unexpected collection errors', async () => {
    const existing = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    responseMode = 'mkcol-exists'
    await expect(
      existing.putImmutable('open-genoffice-sync/v1/project/a/head.json', new Uint8Array([1])),
    ).resolves.toBe('created')

    const failing = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    responseMode = 'mkcol-error'
    await expect(
      failing.putImmutable('open-genoffice-sync/v1/project/b/head.json', new Uint8Array([1])),
    ).rejects.toBeTruthy()
  })

  it('rejects a CAS success without a strong ETag and propagates unexpected PUT failures', async () => {
    const store = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    responseMode = 'missing-etag'
    await expect(
      store.compareAndSwap(
        'open-genoffice-sync/v1/project/a/head.json',
        new Uint8Array([1]),
        'absent',
      ),
    ).rejects.toThrow(/sync_strong_etag_required/)
    responseMode = 'put-error'
    await expect(
      store.compareAndSwap(
        'open-genoffice-sync/v1/project/b/head.json',
        new Uint8Array([1]),
        'absent',
      ),
    ).rejects.toBeTruthy()
  })

  it('rejects object-store traversal before making a request', async () => {
    const store = new WebDavObjectStore({ endpoint, allowLoopbackHttpForTests: true })
    await expect(store.get('open-genoffice-sync/v1/project/a/../head.json')).rejects.toThrow(
      /sync_path_invalid/,
    )
    await expect(store.putImmutable('other-prefix/object', new Uint8Array())).rejects.toThrow(
      /sync_object_key_invalid/,
    )
  })
})
