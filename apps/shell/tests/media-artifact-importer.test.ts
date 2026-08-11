import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScopedArtifactStore } from '@genoffice/agent-resource'
import { MediaArtifactImportError, importMediaArtifact } from '../src/main/media-artifact-importer'

const artifactId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const runId = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []
const wav = Buffer.from(
  '524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000',
  'hex',
)
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-media-import-'))
  roots.push(root)
  return { root, store: new ScopedArtifactStore({ rootDirectory: join(root, 'artifacts') }) }
}

describe('media Artifact importer', () => {
  it.each([
    ['clip.wav', wav, 'audio/wav'],
    ['clip.mp4', mp4, 'video/mp4'],
  ] as const)(
    'registers %s under document scope without exposing bytes or paths',
    async (name, bytes, mediaType) => {
      const { root, store } = await fixture()
      const path = join(root, name)
      await writeFile(path, bytes)
      const artifact = await importMediaArtifact({
        path,
        documentId,
        artifactStore: store,
        randomUUID: () => artifactId,
      })
      expect(artifact).toMatchObject({ artifactId, mediaType, displayName: name })
      expect(JSON.stringify(artifact)).not.toContain(path)
      await expect(store.openMedia({ artifactId, documentId, runId })).resolves.toMatchObject({
        artifact,
      })
    },
  )

  it('rejects invalid extensions, identities, empty files, symlinks and store failures', async () => {
    const { root, store } = await fixture()
    const text = join(root, 'clip.txt')
    const empty = join(root, 'empty.wav')
    const malformed = join(root, 'bad.wav')
    const link = join(root, 'link.wav')
    await writeFile(text, 'text')
    await writeFile(empty, '')
    await writeFile(malformed, 'not-wave')
    await symlink(malformed, link)
    for (const [path, id] of [
      [text, documentId],
      [empty, documentId],
      [link, documentId],
      [malformed, 'bad'],
      [malformed, documentId],
    ]) {
      await expect(
        importMediaArtifact({
          path,
          documentId: id,
          artifactStore: store,
          randomUUID: () => artifactId,
        }),
      ).rejects.toEqual(new MediaArtifactImportError())
    }
  })

  it('preserves the stable importer error at its boundary', async () => {
    const { root } = await fixture()
    const path = join(root, 'clip.wav')
    await writeFile(path, wav)
    const error = new MediaArtifactImportError()
    await expect(
      importMediaArtifact({
        path,
        documentId,
        artifactStore: { registerMedia: async () => Promise.reject(error) },
        randomUUID: () => artifactId,
      }),
    ).rejects.toBe(error)
  })
})
