import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScopedArtifactStore, ScopedArtifactStoreError } from '../src/index'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createStore(): Promise<{ root: string; store: ScopedArtifactStore }> {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-artifact-store-'))
  roots.push(root)
  return { root, store: new ScopedArtifactStore({ rootDirectory: root }) }
}

describe('ScopedArtifactStore', () => {
  it('registers and pages a scope-bound UTF-8 text attachment without exposing its path', async () => {
    const { store } = await createStore()
    const text = `${'甲'.repeat(24_000)}tail`
    const artifact = await store.registerText({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      text,
      mediaType: 'text/plain',
      displayName: 'notes.txt',
    })
    expect(artifact).toMatchObject({
      artifactId: ARTIFACT_ID,
      mediaType: 'text/plain',
      displayName: 'notes.txt',
    })

    const first = await store.readText({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      offset: 0,
    })
    expect(first).toMatchObject({ artifact, text: '甲'.repeat(24_000), nextOffset: 24_000 })
    const last = await store.readText({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      offset: first.nextOffset!,
    })
    expect(last).toMatchObject({ artifact, text: 'tail' })
    expect(last.nextOffset).toBeUndefined()
    expect(JSON.stringify(last)).not.toContain(store.artifactPath(ARTIFACT_ID))
  })

  it('fails closed for text scope mismatch, invalid content and metadata drift', async () => {
    const { root, store } = await createStore()
    await expect(
      store.registerText({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        text: 'bad\0text',
        mediaType: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
    await store.registerText({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      text: 'safe text',
      mediaType: 'text/plain',
    })
    await expect(
      store.readText({
        artifactId: ARTIFACT_ID,
        documentId: '44444444-4444-4444-8444-444444444444',
        runId: RUN_ID,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'artifact_scope_invalid' })
    await expect(
      store.readText({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        offset: -1,
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
    await writeFile(join(root, `${ARTIFACT_ID}.txt`), 'changed')
    await expect(
      store.readText({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
  })

  it('rejects invalid text registration scope, empty content, duplicates and invalid roots', async () => {
    const { store } = await createStore()
    const valid = {
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      text: 'safe text',
      mediaType: 'text/plain' as const,
    }
    await expect(store.registerText({ ...valid, documentId: 'bad' })).rejects.toMatchObject({
      code: 'artifact_scope_invalid',
    })
    await expect(store.registerText({ ...valid, text: '' })).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
    await store.registerText(valid)
    await expect(store.registerText(valid)).rejects.toMatchObject({ code: 'artifact_exists' })

    const parent = await mkdtemp(join(tmpdir(), 'genoffice-invalid-text-store-'))
    roots.push(parent)
    const rootFile = join(parent, 'not-a-directory')
    await writeFile(rootFile, 'file')
    await expect(
      new ScopedArtifactStore({ rootDirectory: rootFile }).registerText({
        ...valid,
        artifactId: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
  })

  it('cleans a partial text write and normalizes unexpected read failures', async () => {
    const failingRoot = await mkdtemp(join(tmpdir(), 'genoffice-failing-text-store-'))
    roots.push(failingRoot)
    const failingStore = new ScopedArtifactStore({
      rootDirectory: failingRoot,
      atomicWriteOptions: { failAt: 'after_rename' },
    })
    await expect(
      failingStore.registerText({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        text: 'safe text',
        mediaType: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
    await expect(readFile(join(failingRoot, `${ARTIFACT_ID}.txt`))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const invalidRoot = join(failingRoot, 'not-a-directory')
    await writeFile(invalidRoot, 'file')
    await expect(
      new ScopedArtifactStore({ rootDirectory: invalidRoot }).readText({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
  })

  it('rejects malformed text metadata and externally introduced NUL content', async () => {
    const { root, store } = await createStore()
    const register = () =>
      store.registerText({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        text: 'safe text',
        mediaType: 'text/plain',
      })
    const read = () =>
      store.readText({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID })
    await register()
    const metadataPath = join(root, `${ARTIFACT_ID}.json`)
    const textPath = join(root, `${ARTIFACT_ID}.txt`)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    for (const value of [
      [],
      { ...metadata, extra: true },
      { ...metadata, documentId: 'bad' },
      Object.fromEntries(
        Object.entries({ ...metadata, scope: 'other' }).filter(([key]) => key !== 'runId'),
      ),
      { ...metadata, schemaVersion: 2 },
    ]) {
      await writeFile(metadataPath, JSON.stringify(value))
      await expect(read()).rejects.toMatchObject({ code: expect.stringMatching(/^artifact_/) })
    }

    const corrupt = Buffer.from('safe\0text')
    await writeFile(textPath, corrupt)
    await writeFile(
      metadataPath,
      JSON.stringify({
        ...metadata,
        byteLength: corrupt.length,
        sha256: createHash('sha256').update(corrupt).digest('hex'),
      }),
    )
    await expect(read()).rejects.toMatchObject({ code: 'artifact_invalid' })
  })

  it('allows a document-scoped attachment across runs but never across documents', async () => {
    const { store } = await createStore()
    await store.registerText({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      scope: 'document',
      text: 'document attachment',
      mediaType: 'text/plain',
    })
    await expect(
      store.readText({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: '44444444-4444-4444-8444-444444444444',
      }),
    ).resolves.toMatchObject({ text: 'document attachment' })
    await expect(
      store.readText({
        artifactId: ARTIFACT_ID,
        documentId: '55555555-5555-4555-8555-555555555555',
        runId: RUN_ID,
      }),
    ).rejects.toMatchObject({ code: 'artifact_scope_invalid' })
  })

  it('atomically registers and reopens one scope-bound verified PNG ArtifactRef', async () => {
    const { store } = await createStore()
    const artifact = await store.registerImage({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      bytes: PNG,
      mediaType: 'image/png',
      width: 1,
      height: 1,
      displayName: 'generated-image.png',
    })
    expect(artifact).toMatchObject({
      artifactId: ARTIFACT_ID,
      mediaType: 'image/png',
      byteLength: 68,
      displayName: 'generated-image.png',
    })
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)

    const opened = await store.openImage({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
    })
    expect(opened).toMatchObject({ artifact, width: 1, height: 1 })
    expect(opened.bytes).toEqual(PNG)
    expect(JSON.stringify(opened)).not.toContain(store.artifactPath(ARTIFACT_ID))
  })

  it.each([
    [{ artifactId: 'bad', documentId: DOCUMENT_ID, runId: RUN_ID }, 'artifact_invalid'],
    [{ artifactId: ARTIFACT_ID, documentId: 'bad', runId: RUN_ID }, 'artifact_scope_invalid'],
    [{ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: 'bad' }, 'artifact_scope_invalid'],
  ] as const)('rejects malformed open scope %j', async (input, code) => {
    const { store } = await createStore()
    await expect(store.openImage(input)).rejects.toEqual(new ScopedArtifactStoreError(code))
  })

  it('rejects cross-document/run access, hash drift, metadata drift and symlinks', async () => {
    const { root, store } = await createStore()
    await store.registerImage({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      bytes: PNG,
      mediaType: 'image/png',
      width: 1,
      height: 1,
      displayName: 'generated-image.png',
    })
    await expect(
      store.openImage({
        artifactId: ARTIFACT_ID,
        documentId: '44444444-4444-4444-8444-444444444444',
        runId: RUN_ID,
      }),
    ).rejects.toMatchObject({ code: 'artifact_scope_invalid' })
    await expect(
      store.openImage({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toMatchObject({ code: 'artifact_scope_invalid' })

    const driftedPng = Buffer.from(PNG)
    driftedPng[driftedPng.length - 1] ^= 1
    await writeFile(store.artifactPath(ARTIFACT_ID), driftedPng)
    await expect(
      store.openImage({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })

    await writeFile(join(root, `${ARTIFACT_ID}.json`), '[]')
    await expect(
      store.openImage({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })

    await writeFile(join(root, `${ARTIFACT_ID}.json`), '{"extra":true}')
    await expect(
      store.openImage({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })

    await writeFile(join(root, `${ARTIFACT_ID}.json`), '{')
    await expect(
      store.openImage({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })

    await unlink(store.artifactPath(ARTIFACT_ID))
    const outside = join(root, 'outside.png')
    await writeFile(outside, PNG)
    await symlink(outside, store.artifactPath(ARTIFACT_ID))
    await expect(
      store.openImage({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
  })

  it('rejects invalid registration fields, bytes, dimensions and duplicate identities', async () => {
    const { store } = await createStore()
    const valid = {
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      bytes: PNG,
      mediaType: 'image/png' as const,
      width: 1,
      height: 1,
      displayName: 'generated-image.png',
    }
    for (const input of [
      { ...valid, artifactId: 'bad' },
      { ...valid, documentId: 'bad' },
      { ...valid, runId: 'bad' },
      { ...valid, mediaType: 'image/jpeg' as 'image/png' },
      { ...valid, bytes: Buffer.from('bad') },
      { ...valid, bytes: Buffer.concat([Buffer.alloc(24), PNG]) },
      { ...valid, bytes: Buffer.from(PNG).fill(0, 16, 20) },
      { ...valid, width: 0 },
      { ...valid, height: 20_000 },
      { ...valid, displayName: '../escape.png' },
    ]) {
      await expect(store.registerImage(input)).rejects.toMatchObject({
        code: expect.stringMatching(/^artifact_/),
      })
    }
    await store.registerImage(valid)
    await expect(store.registerImage(valid)).rejects.toMatchObject({ code: 'artifact_exists' })
  })

  it('supports an omitted display name and rejects invalid metadata and store failures', async () => {
    expect(() => new ScopedArtifactStore({ rootDirectory: '' })).toThrowError(
      new ScopedArtifactStoreError('artifact_invalid'),
    )

    const { root, store } = await createStore()
    const artifact = await store.registerImage({
      artifactId: ARTIFACT_ID,
      documentId: DOCUMENT_ID,
      runId: RUN_ID,
      bytes: PNG,
      mediaType: 'image/png',
      width: 1,
      height: 1,
    })
    expect(artifact.displayName).toBeUndefined()
    expect(
      await store.openImage({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).toMatchObject({ artifact })

    const metadataPath = join(root, `${ARTIFACT_ID}.json`)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    await writeFile(metadataPath, `${JSON.stringify({ ...metadata, schemaVersion: 2 })}\n`)
    await expect(
      store.openImage({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })

    const parent = await mkdtemp(join(tmpdir(), 'genoffice-invalid-artifact-store-'))
    roots.push(parent)
    const rootFile = join(parent, 'not-a-directory')
    await writeFile(rootFile, 'file')
    const invalidStore = new ScopedArtifactStore({ rootDirectory: rootFile })
    await expect(
      invalidStore.registerImage({
        artifactId: '44444444-4444-4444-8444-444444444444',
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        bytes: PNG,
        mediaType: 'image/png',
        width: 1,
        height: 1,
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
  })

  it('removes partial output when an atomic write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-failing-artifact-store-'))
    roots.push(root)
    const store = new ScopedArtifactStore({
      rootDirectory: root,
      atomicWriteOptions: { failAt: 'after_rename' },
    })
    await expect(
      store.registerImage({
        artifactId: ARTIFACT_ID,
        documentId: DOCUMENT_ID,
        runId: RUN_ID,
        bytes: PNG,
        mediaType: 'image/png',
        width: 1,
        height: 1,
      }),
    ).rejects.toMatchObject({ code: 'artifact_invalid' })
    await expect(readFile(store.artifactPath(ARTIFACT_ID))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
