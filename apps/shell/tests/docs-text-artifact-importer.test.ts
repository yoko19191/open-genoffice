import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScopedArtifactStore } from '@genoffice/agent-resource'
import {
  DocsTextArtifactImportError,
  importDocsTextArtifact,
} from '../src/main/docs-text-artifact-importer'

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-docs-text-import-'))
  roots.push(root)
  return { root, store: new ScopedArtifactStore({ rootDirectory: join(root, 'artifacts') }) }
}

describe('Docs text Artifact importer', () => {
  it('registers validated UTF-8 under document scope and returns no path or content', async () => {
    const { root, store } = await fixture()
    const path = join(root, 'notes.md')
    await writeFile(path, 'line one\nline two')
    const artifact = await importDocsTextArtifact({
      path,
      documentId: DOCUMENT_ID,
      artifactStore: store,
      randomUUID: () => ARTIFACT_ID,
    })
    expect(artifact).toMatchObject({
      artifactId: ARTIFACT_ID,
      mediaType: 'text/plain',
      displayName: 'notes.md',
    })
    expect(JSON.stringify(artifact)).not.toContain(path)
    expect(JSON.stringify(artifact)).not.toContain('line one')
    await expect(
      store.readText({ artifactId: ARTIFACT_ID, documentId: DOCUMENT_ID, runId: RUN_ID }),
    ).resolves.toMatchObject({ text: 'line one\nline two' })
  })

  it.each([
    ['empty', Buffer.alloc(0)],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['NUL', Buffer.from('bad\0text')],
    ['too large', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)],
  ])('rejects %s files', async (_label, bytes) => {
    const { root, store } = await fixture()
    const path = join(root, 'bad.txt')
    await writeFile(path, bytes)
    await expect(
      importDocsTextArtifact({
        path,
        documentId: DOCUMENT_ID,
        artifactStore: store,
        randomUUID: () => ARTIFACT_ID,
      }),
    ).rejects.toEqual(new DocsTextArtifactImportError('artifact_invalid'))
  })

  it('rejects symlinks and invalid document identities', async () => {
    const { root, store } = await fixture()
    const target = join(root, 'target.txt')
    const link = join(root, 'link.txt')
    await writeFile(target, 'safe')
    await symlink(target, link)
    await expect(
      importDocsTextArtifact({
        path: link,
        documentId: DOCUMENT_ID,
        artifactStore: store,
        randomUUID: () => ARTIFACT_ID,
      }),
    ).rejects.toEqual(new DocsTextArtifactImportError('artifact_invalid'))
    await expect(
      importDocsTextArtifact({
        path: target,
        documentId: 'bad',
        artifactStore: store,
        randomUUID: () => ARTIFACT_ID,
      }),
    ).rejects.toEqual(new DocsTextArtifactImportError('artifact_invalid'))
  })
})
