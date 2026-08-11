import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ProviderOperationStore,
  ProviderOperationStoreError,
  type ProviderOperationRecord,
} from '../src/provider-operation-store'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222'
const SECOND_OPERATION_ID = '00000000-0000-4000-8000-000000000001'

function operation(
  state: ProviderOperationRecord['state'],
  generation: number,
): ProviderOperationRecord {
  return {
    operationId: OPERATION_ID,
    providerId: 'mineru',
    documentId: DOCUMENT_ID,
    state,
    generation,
    updatedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-11T00:00:00.000Z',
  }
}

describe('redacted Provider Operation store', () => {
  it('commits generation-CAS state without provider IDs, URLs, paths or document content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-operation-store-'))
    const store = new ProviderOperationStore({ rootDirectory: root, platform: 'linux' })
    await expect(store.commit(operation('preparing', 1), 0)).resolves.toEqual(
      operation('preparing', 1),
    )
    await expect(store.commit(operation('running', 2), 1)).resolves.toEqual(operation('running', 2))
    await expect(store.get(OPERATION_ID)).resolves.toEqual(operation('running', 2))
    await expect(store.list()).resolves.toEqual([operation('running', 2)])

    const persisted = await readFile(join(root, 'state/provider-operations.json'), 'utf8')
    for (const forbidden of [
      'private-batch-id',
      'https://signed.example',
      '/private/source.pdf',
      'private document content',
    ]) {
      expect(persisted).not.toContain(forbidden)
    }
  })

  it('serializes concurrent commits and rejects stale generations or invalid records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-operation-cas-'))
    const store = new ProviderOperationStore({ rootDirectory: root })
    await store.commit(operation('preparing', 1), 0)
    const results = await Promise.allSettled([
      store.commit(operation('running', 2), 1),
      store.commit(operation('failed', 2), 1),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(store.commit(operation('done' as never, 3), 2)).rejects.toEqual(
      new ProviderOperationStoreError('provider_operation_invalid'),
    )
  })

  it('persists only the documented safe provider progress projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-operation-progress-'))
    const store = new ProviderOperationStore({ rootDirectory: root })
    await expect(
      store.commit({ ...operation('running', 1), providerState: 'converting' }, 0),
    ).resolves.toMatchObject({ providerState: 'converting' })
    await store.commit({ ...operation('preparing', 1), operationId: SECOND_OPERATION_ID }, 0)
    await expect(store.list()).resolves.toHaveLength(2)
    await expect(
      store.commit(
        { ...operation('running', 2), providerState: 'private-provider-state' as never },
        1,
      ),
    ).rejects.toEqual(new ProviderOperationStoreError('provider_operation_invalid'))
  })

  it('fails closed on corrupt persisted state without overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-operation-corrupt-'))
    const path = join(root, 'state/provider-operations.json')
    await mkdir(join(root, 'state'))
    await writeFile(path, '{"schemaVersion":99}\n')
    const store = new ProviderOperationStore({ rootDirectory: root })
    await expect(store.get(OPERATION_ID)).rejects.toEqual(
      new ProviderOperationStoreError('provider_operation_index_invalid'),
    )
    await expect(readFile(path, 'utf8')).resolves.toBe('{"schemaVersion":99}\n')
    await writeFile(path, 'not-json\n')
    await expect(store.get(OPERATION_ID)).rejects.toEqual(
      new ProviderOperationStoreError('provider_operation_index_invalid'),
    )
  })
})
