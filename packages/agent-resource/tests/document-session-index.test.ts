import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DocumentBindingStore,
  DocumentSessionIndexError,
  DocumentSessionIndexStore,
  type AtomicWriteFailurePoint,
} from '../src/index'

const documentId = '11111111-1111-4111-8111-111111111111'
const firstSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const secondSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `agent-document-session-${name}-`))
  await new DocumentBindingStore({
    rootDirectory: root,
    randomUUID: () => documentId,
  }).createUnsaved({ projectId: 'default', format: 'docx' })
  return root
}

describe('Document current Session index', () => {
  it('serializes concurrent first connects and restores one current Session after restart', async () => {
    const root = await fixture('resolve')
    const first = new DocumentSessionIndexStore({ rootDirectory: root })
    const second = new DocumentSessionIndexStore({ rootDirectory: root })
    let creates = 0
    const create = async () => {
      creates += 1
      return creates === 1 ? firstSessionId : secondSessionId
    }

    const resolved = await Promise.all([
      first.resolveCurrent(documentId, create),
      second.resolveCurrent(documentId, create),
    ])

    expect(creates).toBe(1)
    expect(resolved).toEqual([
      expect.objectContaining({ documentId, currentSessionId: firstSessionId, generation: 1 }),
      expect.objectContaining({ documentId, currentSessionId: firstSessionId, generation: 1 }),
    ])
    await expect(
      new DocumentSessionIndexStore({ rootDirectory: root }).current(documentId),
    ).resolves.toMatchObject({ currentSessionId: firstSessionId })
    const indexPath = join(
      root,
      'projects',
      'default',
      'documents',
      documentId,
      'session-index.json',
    )
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toMatchObject({
      currentSessionId: firstSessionId,
    })
    expect((await stat(indexPath)).mode & 0o777).toBe(0o600)
  })

  it('asserts the current identity and atomically advances it for fork navigation', async () => {
    const root = await fixture('navigate')
    const store = new DocumentSessionIndexStore({
      rootDirectory: root,
      now: () => new Date('2026-08-10T01:00:00.000Z'),
    })
    await store.resolveCurrent(documentId, async () => firstSessionId)
    await expect(store.assertCurrent(documentId, firstSessionId)).resolves.toMatchObject({
      generation: 1,
    })
    await expect(store.assertCurrent(documentId, secondSessionId)).rejects.toEqual(
      new DocumentSessionIndexError('document_session_not_current'),
    )
    await expect(store.setCurrent(documentId, secondSessionId, 1)).resolves.toMatchObject({
      currentSessionId: secondSessionId,
      generation: 2,
      updatedAt: '2026-08-10T01:00:00.000Z',
    })
    await expect(store.setCurrent(documentId, firstSessionId, 1)).rejects.toEqual(
      new DocumentSessionIndexError('document_session_conflict'),
    )

    await expect(
      Promise.allSettled([
        store.advanceCurrent(documentId, secondSessionId, firstSessionId),
        store.advanceCurrent(documentId, secondSessionId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'fulfilled',
        value: expect.objectContaining({ currentSessionId: firstSessionId, generation: 3 }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: new DocumentSessionIndexError('document_session_not_current'),
      }),
    ])

    const newRoot = await fixture('direct-current')
    await expect(
      new DocumentSessionIndexStore({ rootDirectory: newRoot, platform: 'win32' }).setCurrent(
        documentId,
        firstSessionId,
      ),
    ).resolves.toMatchObject({ currentSessionId: firstSessionId, generation: 1 })
  })

  it.each(['before_rename', 'after_rename'] as const)(
    'keeps the index absent or fully committed when persistence fails %s',
    async (point: AtomicWriteFailurePoint) => {
      const root = await fixture(`crash-${point}`)
      const failure: { point?: AtomicWriteFailurePoint } = { point }
      const store = new DocumentSessionIndexStore({
        rootDirectory: root,
        atomicWriteOptions: () => ({ failAt: failure.point, platform: 'linux' }),
      })

      await expect(store.resolveCurrent(documentId, async () => firstSessionId)).rejects.toThrow(
        'injected_atomic_write_failure',
      )
      failure.point = undefined
      if (point === 'before_rename') {
        await expect(store.current(documentId)).resolves.toBeUndefined()
      } else {
        await expect(store.current(documentId)).resolves.toMatchObject({
          currentSessionId: firstSessionId,
        })
      }
    },
  )

  it('does not publish an index when Session creation fails or returns an invalid id', async () => {
    const root = await fixture('create-failure')
    const store = new DocumentSessionIndexStore({ rootDirectory: root })
    await expect(
      store.resolveCurrent(documentId, async () => {
        throw new Error('session_create_failed')
      }),
    ).rejects.toThrow('session_create_failed')
    await expect(store.current(documentId)).resolves.toBeUndefined()
    await expect(store.resolveCurrent(documentId, async () => 'invalid')).rejects.toEqual(
      new DocumentSessionIndexError('document_session_index_invalid'),
    )
    await expect(store.current(documentId)).resolves.toBeUndefined()
  })

  it('fails closed on missing bindings, malformed index data, and invalid identities', async () => {
    const root = await fixture('invalid')
    const store = new DocumentSessionIndexStore({ rootDirectory: root })
    await expect(store.current(secondSessionId)).rejects.toEqual(
      new DocumentSessionIndexError('document_session_binding_not_found'),
    )
    await expect(store.current('invalid')).rejects.toEqual(
      new DocumentSessionIndexError('document_session_index_invalid'),
    )
    await expect(store.assertCurrent(documentId, firstSessionId)).rejects.toEqual(
      new DocumentSessionIndexError('document_session_not_found'),
    )
    const indexPath = join(
      root,
      'projects',
      'default',
      'documents',
      documentId,
      'session-index.json',
    )
    await writeFile(indexPath, '{}')
    await expect(store.current(documentId)).rejects.toEqual(
      new DocumentSessionIndexError('document_session_index_invalid'),
    )
    await rm(indexPath)
    await mkdir(indexPath)
    await expect(store.current(documentId)).rejects.toEqual(
      new DocumentSessionIndexError('document_session_index_invalid'),
    )

    const malformedBindingRoot = await fixture('malformed-binding')
    await writeFile(
      join(malformedBindingRoot, 'projects', 'default', 'documents', documentId, 'binding.json'),
      '{}',
    )
    await expect(
      new DocumentSessionIndexStore({ rootDirectory: malformedBindingRoot }).current(documentId),
    ).rejects.toEqual(new DocumentSessionIndexError('document_session_index_invalid'))
  })
})
