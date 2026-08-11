import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

import { createManifest, createRevision } from '../src/model.mjs'
import { CasMismatchError, createSyncRepository } from '../src/repository.mjs'
import { createAuthenticatedWebDavObjectStore } from '../src/webdav-store.mjs'

const objects = new Map()
const etag = (bytes) => `"${createHash('sha256').update(bytes).digest('hex')}"`

const server = createServer((request, response) => {
  const key = new URL(request.url, 'http://127.0.0.1').pathname
  const current = objects.get(key)
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (!current) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('ETag', current.etag)
    response.writeHead(200)
    response.end(request.method === 'HEAD' ? undefined : current.bytes)
    return
  }
  if (request.method !== 'PUT') {
    response.writeHead(405).end()
    return
  }
  const ifNoneMatch = request.headers['if-none-match']
  const ifMatch = request.headers['if-match']
  if ((ifNoneMatch === '*' && current) || (ifMatch && current?.etag !== ifMatch)) {
    response.writeHead(412).end()
    return
  }
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const bytes = Buffer.concat(chunks)
    const versionToken = etag(bytes)
    objects.set(key, { bytes, etag: versionToken })
    response.setHeader('ETag', versionToken)
    response.writeHead(current ? 204 : 201).end()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const address = server.address()
  const store = createAuthenticatedWebDavObjectStore({
    baseUrl: `http://127.0.0.1:${address.port}/dav/`,
    allowInsecureLoopback: true,
  })
  const repository = createSyncRepository(store, { namespace: 'project', scopeId: 'probe-project' })
  const content = new TextEncoder().encode('webdav-probe')
  const revision = createRevision({
    namespace: 'project',
    scopeId: 'probe-project',
    path: 'documents/probe.docx',
    kind: 'office-document',
    contentBytes: content,
    authorDeviceId: 'probe-device',
  })
  const manifest = createManifest({
    namespace: 'project',
    scopeId: 'probe-project',
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
  if (!staleCasRejected) throw new Error('stale WebDAV CAS was not rejected')
  process.stdout.write(
    `${JSON.stringify({ provider: 'webdav', manifestId: manifest.manifestId, versionToken: commit.versionToken, staleCasRejected })}\n`,
  )
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
