import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DocumentBindingError,
  DocumentBindingStore,
  type AtomicWriteFailurePoint,
} from '../src/index'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const thirdId = '33333333-3333-4333-8333-333333333333'
const fourthId = '44444444-4444-4444-8444-444444444444'

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `agent-document-binding-${name}-`))
  const firstPath = join(root, 'first.docx')
  const secondPath = join(root, 'second.docx')
  await writeFile(firstPath, 'first')
  await writeFile(secondPath, 'second')
  return { root, firstPath, secondPath }
}

function ids(...values: string[]) {
  let index = 0
  return () => values[index++]!
}

describe('DocumentBindingStore', () => {
  it('keeps one UUID through first save and in-app Save As while atomically re-keying paths', async () => {
    const { root, firstPath, secondPath } = await fixture('lifecycle')
    const canonicalFirstPath = await realpath(firstPath)
    const canonicalSecondPath = await realpath(secondPath)
    const store = new DocumentBindingStore({
      rootDirectory: root,
      platform: 'linux',
      randomUUID: ids(firstId, secondId),
    })

    const unsaved = await store.createUnsaved({ projectId: 'default', format: 'docx' })
    expect(unsaved).toEqual({
      documentId: firstId,
      projectId: 'default',
      format: 'docx',
      state: 'unsaved',
    })
    const bindingPath = join(root, 'projects', 'default', 'documents', firstId, 'binding.json')
    expect((await stat(bindingPath)).mode & 0o777).toBe(0o600)

    await expect(store.bindPath(firstId, firstPath, 'in_app')).resolves.toMatchObject({
      documentId: firstId,
      canonicalPath: canonicalFirstPath,
      state: 'bound',
    })
    await expect(store.bindPath(firstId, secondPath, 'in_app')).resolves.toMatchObject({
      documentId: firstId,
      canonicalPath: canonicalSecondPath,
      state: 'bound',
    })
    await expect(
      store.openOrCreate({ projectId: 'default', format: 'docx', canonicalPath: secondPath }),
    ).resolves.toMatchObject({ documentId: firstId })

    const oldPathIdentity = await store.openOrCreate({
      projectId: 'default',
      format: 'docx',
      canonicalPath: firstPath,
    })
    expect(oldPathIdentity.documentId).toBe(secondId)
    await expect(store.bindPath(secondId, secondPath, 'in_app')).rejects.toEqual(
      new DocumentBindingError('document_path_already_bound'),
    )
  })

  it('requires an explicit rebind after an external move and supports an explicit identity fork', async () => {
    const { root, firstPath } = await fixture('external-move')
    const movedPath = join(root, 'moved.docx')
    const store = new DocumentBindingStore({
      rootDirectory: root,
      randomUUID: ids(firstId, secondId),
    })
    const opened = await store.openOrCreate({
      projectId: 'project-a',
      format: 'docx',
      canonicalPath: firstPath,
    })
    const canonicalFirstPath = await realpath(firstPath)
    await rename(firstPath, movedPath)
    const canonicalMovedPath = await realpath(movedPath)
    await expect(store.markMissing(opened.documentId)).resolves.toMatchObject({
      documentId: firstId,
      canonicalPath: canonicalFirstPath,
      state: 'missing',
    })
    await expect(store.bindPath(firstId, movedPath, 'in_app')).rejects.toEqual(
      new DocumentBindingError('document_rebind_required'),
    )
    await expect(store.bindPath(firstId, movedPath, 'rebind')).resolves.toMatchObject({
      documentId: firstId,
      canonicalPath: canonicalMovedPath,
      state: 'bound',
    })

    const fork = await store.fork(firstId)
    expect(fork).toEqual({
      documentId: secondId,
      projectId: 'project-a',
      format: 'docx',
      state: 'unsaved',
    })
  })

  it('serializes two processes opening the same canonical path to one identity', async () => {
    const { root, firstPath } = await fixture('concurrent')
    const first = new DocumentBindingStore({ rootDirectory: root, randomUUID: () => firstId })
    const second = new DocumentBindingStore({ rootDirectory: root, randomUUID: () => secondId })

    const bindings = await Promise.all([
      first.openOrCreate({ projectId: 'default', format: 'docx', canonicalPath: firstPath }),
      second.openOrCreate({ projectId: 'default', format: 'docx', canonicalPath: firstPath }),
    ])
    const identities = new Set(bindings.map((binding) => binding.documentId))
    expect(identities).toHaveLength(1)
    expect([firstId, secondId]).toContain([...identities][0])
    expect(await first.list()).toHaveLength(1)
  })

  it.each(['before_rename', 'after_rename'] as const)(
    'exposes one complete binding generation when a write fails %s',
    async (failurePoint: AtomicWriteFailurePoint) => {
      const { root, firstPath, secondPath } = await fixture(`crash-${failurePoint}`)
      const canonicalFirstPath = await realpath(firstPath)
      const canonicalSecondPath = await realpath(secondPath)
      const failure: { point?: AtomicWriteFailurePoint } = {}
      const store = new DocumentBindingStore({
        rootDirectory: root,
        randomUUID: () => firstId,
        atomicWriteOptions: () => ({
          platform: 'linux',
          randomUUID: () => thirdId,
          failAt: failure.point,
        }),
      })
      await store.openOrCreate({
        projectId: 'default',
        format: 'docx',
        canonicalPath: firstPath,
      })
      failure.point = failurePoint
      await expect(store.bindPath(firstId, secondPath, 'in_app')).rejects.toThrow(
        'injected_atomic_write_failure',
      )

      const persisted = JSON.parse(
        await readFile(
          join(root, 'projects', 'default', 'documents', firstId, 'binding.json'),
          'utf8',
        ),
      )
      expect([canonicalFirstPath, canonicalSecondPath]).toContain(persisted.canonicalPath)
      expect(persisted).toMatchObject({ documentId: firstId, state: 'bound' })
    },
  )

  it('fails closed on unsafe identifiers and malformed bindings', async () => {
    const { root, firstPath } = await fixture('invalid')
    const store = new DocumentBindingStore({ rootDirectory: root, randomUUID: () => firstId })
    await expect(store.createUnsaved({ projectId: '../escape', format: 'docx' })).rejects.toEqual(
      new DocumentBindingError('document_binding_invalid'),
    )
    await store.createUnsaved({ projectId: 'default', format: 'docx' })
    const bindingPath = join(root, 'projects', 'default', 'documents', firstId, 'binding.json')
    await writeFile(bindingPath, '{}')
    await chmod(bindingPath, 0o644)
    await expect(store.get(firstId)).rejects.toEqual(
      new DocumentBindingError('document_binding_invalid'),
    )
    await expect(
      store.openOrCreate({ projectId: 'default', format: 'docx', canonicalPath: firstPath }),
    ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))
  })

  it('preserves content metadata across explicit state transitions and validates every identity input', async () => {
    const { root, firstPath, secondPath } = await fixture('metadata')
    const firstHash = 'a'.repeat(64)
    const secondHash = 'b'.repeat(64)
    const store = new DocumentBindingStore({
      rootDirectory: root,
      randomUUID: ids(firstId, secondId),
    })
    await expect(
      store.createUnsaved({
        projectId: 'default',
        format: 'docx',
        lastKnownContentHash: firstHash,
      }),
    ).resolves.toMatchObject({ documentId: firstId, lastKnownContentHash: firstHash })
    await expect(store.markNeedsRebind(firstId)).resolves.toMatchObject({
      state: 'needs_rebind',
      lastKnownContentHash: firstHash,
    })
    await expect(store.bindPath(firstId, firstPath, 'in_app')).rejects.toEqual(
      new DocumentBindingError('document_rebind_required'),
    )
    await expect(store.bindPath(firstId, firstPath, 'rebind', secondHash)).resolves.toMatchObject({
      state: 'bound',
      lastKnownContentHash: secondHash,
    })
    await expect(store.fork(firstId, firstPath)).rejects.toEqual(
      new DocumentBindingError('document_path_already_bound'),
    )
    await expect(store.fork(firstId, secondPath)).resolves.toMatchObject({
      documentId: secondId,
      lastKnownContentHash: secondHash,
      state: 'bound',
    })
    await expect(
      store.openOrCreate({ projectId: 'default', format: 'pdf', canonicalPath: firstPath }),
    ).rejects.toEqual(new DocumentBindingError('document_format_mismatch'))
    await expect(store.get(thirdId)).rejects.toEqual(
      new DocumentBindingError('document_binding_not_found'),
    )
    await expect(store.get('invalid-id')).rejects.toEqual(
      new DocumentBindingError('document_binding_invalid'),
    )
    await expect(
      store.createUnsaved({ projectId: 'default', format: 'docx', lastKnownContentHash: 'short' }),
    ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))
    expect((await store.list()).map((binding) => binding.documentId)).toEqual([firstId, secondId])

    const duplicateIdStore = new DocumentBindingStore({
      rootDirectory: root,
      randomUUID: () => firstId,
    })
    await expect(
      duplicateIdStore.createUnsaved({ projectId: 'default', format: 'docx' }),
    ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))
    const forkCollisionPath = join(root, 'fork-uuid-collision.docx')
    await writeFile(forkCollisionPath, 'fork collision')
    await expect(duplicateIdStore.fork(firstId, forkCollisionPath)).rejects.toEqual(
      new DocumentBindingError('document_binding_invalid'),
    )
    const collisionPath = join(root, 'uuid-collision.docx')
    await writeFile(collisionPath, 'collision')
    await expect(
      duplicateIdStore.openOrCreate({
        projectId: 'default',
        format: 'docx',
        canonicalPath: collisionPath,
      }),
    ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))

    const defaultRoot = await mkdtemp(join(tmpdir(), 'agent-document-binding-defaults-'))
    const defaults = new DocumentBindingStore({ rootDirectory: defaultRoot, platform: 'win32' })
    expect(
      (await defaults.createUnsaved({ projectId: 'default', format: 'pdf' })).documentId,
    ).toMatch(/^[0-9a-f-]{36}$/)
    await expect(
      defaults.openOrCreate({
        projectId: 'default',
        format: 'pdf',
        canonicalPath: join(defaultRoot, 'missing.pdf'),
      }),
    ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))
    await expect(
      new DocumentBindingStore({
        rootDirectory: defaultRoot,
        canonicalizePath: async () => '',
      }).openOrCreate({ projectId: 'default', format: 'pdf', canonicalPath: firstPath }),
    ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))
  })

  it('fails closed on ambiguous identities and invalid Resource Home topology', async () => {
    const { root, firstPath } = await fixture('ambiguous')
    const canonicalPath = await realpath(firstPath)
    const writeRawBinding = async (projectId: string, documentId: string, path: string) => {
      const directory = join(root, 'projects', projectId, 'documents', documentId)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'binding.json'),
        `${JSON.stringify({
          documentId,
          projectId,
          format: 'docx',
          canonicalPath: path,
          state: 'bound',
        })}\n`,
      )
    }
    await writeRawBinding('project-a', firstId, canonicalPath)
    await writeRawBinding('project-b', firstId, join(root, 'other.docx'))
    const store = new DocumentBindingStore({ rootDirectory: root, randomUUID: () => thirdId })
    await expect(store.get(firstId)).rejects.toEqual(
      new DocumentBindingError('document_binding_invalid'),
    )

    const duplicatePathRoot = await mkdtemp(join(tmpdir(), 'agent-document-binding-path-'))
    const duplicatePathStore = new DocumentBindingStore({ rootDirectory: duplicatePathRoot })
    const duplicatePath = async (projectId: string, documentId: string) => {
      const directory = join(duplicatePathRoot, 'projects', projectId, 'documents', documentId)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'binding.json'),
        JSON.stringify({
          documentId,
          projectId,
          format: 'docx',
          canonicalPath,
          state: 'bound',
        }),
      )
    }
    await duplicatePath('project-a', firstId)
    await duplicatePath('project-b', secondId)
    await expect(
      duplicatePathStore.openOrCreate({
        projectId: 'default',
        format: 'docx',
        canonicalPath: firstPath,
      }),
    ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))

    for (const [name, prepare] of [
      [
        'project-file',
        async (topologyRoot: string) => writeFile(join(topologyRoot, 'projects', 'bad'), ''),
      ],
      [
        'document-file',
        async (topologyRoot: string) => {
          const documents = join(topologyRoot, 'projects', 'default', 'documents')
          await mkdir(documents, { recursive: true })
          await writeFile(join(documents, 'bad'), '')
        },
      ],
      [
        'binding-directory',
        async (topologyRoot: string) =>
          mkdir(join(topologyRoot, 'projects', 'default', 'documents', fourthId, 'binding.json'), {
            recursive: true,
          }),
      ],
    ] as const) {
      const topologyRoot = await mkdtemp(join(tmpdir(), `agent-document-binding-${name}-`))
      await mkdir(join(topologyRoot, 'projects'), { recursive: true })
      await prepare(topologyRoot)
      await expect(
        new DocumentBindingStore({ rootDirectory: topologyRoot }).list(),
      ).rejects.toEqual(new DocumentBindingError('document_binding_invalid'))
    }

    const emptyProjectRoot = await mkdtemp(join(tmpdir(), 'agent-document-binding-empty-project-'))
    await mkdir(join(emptyProjectRoot, 'projects', 'default'), { recursive: true })
    await expect(
      new DocumentBindingStore({ rootDirectory: emptyProjectRoot }).list(),
    ).resolves.toEqual([])
    const emptyDocumentRoot = await mkdtemp(
      join(tmpdir(), 'agent-document-binding-empty-document-'),
    )
    await mkdir(join(emptyDocumentRoot, 'projects', 'default', 'documents', fourthId), {
      recursive: true,
    })
    await expect(
      new DocumentBindingStore({ rootDirectory: emptyDocumentRoot }).list(),
    ).resolves.toEqual([])
  })
})
