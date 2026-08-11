import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileReconcileIntentStore } from '../src/sync/reconcile-intent-store.js'
import type { ReconcileIntent } from '../src/sync/types.js'

const roots: string[] = []

async function makeStore(): Promise<{ root: string; store: FileReconcileIntentStore }> {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-intents-'))
  roots.push(root)
  return { root, store: new FileReconcileIntentStore(root) }
}

function intent(paths: string[]): ReconcileIntent {
  return { schemaVersion: 1, operation: 'reconcile', scopeId: 'project-a', paths }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileReconcileIntentStore', () => {
  it('atomically merges concurrent path-only intents with private permissions', async () => {
    const { root, store } = await makeStore()
    await expect(store.load('project-a')).resolves.toBeNull()
    await Promise.all([
      store.enqueue(intent(['documents/a.docx', 'assets/chart.png'])),
      store.enqueue(intent(['documents/b.docx', 'documents/a.docx'])),
    ])
    await expect(store.load('project-a')).resolves.toEqual(
      intent(['assets/chart.png', 'documents/a.docx', 'documents/b.docx']),
    )
    expect((await stat(join(root, 'project-a.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(root, 'project-a.json'), 'utf8')).not.toMatch(
      /etag|versionToken|revisionId|manifestHash|secret/i,
    )
    await store.clear('project-a')
    await expect(store.load('project-a')).resolves.toBeNull()
  })

  it('fails closed on invalid scope, JSON, schema and non-canonical paths', async () => {
    const { root, store } = await makeStore()
    await expect(store.load('../escape')).rejects.toThrow(/sync_scope_invalid/)
    await writeFile(join(root, 'project-a.json'), '{')
    await expect(store.load('project-a')).rejects.toThrow(/sync_reconcile_intent_invalid/)
    await writeFile(join(root, 'project-a.json'), '{}')
    await expect(store.load('project-a')).rejects.toThrow(/sync_reconcile_intent_invalid/)
    await writeFile(join(root, 'project-a.json'), JSON.stringify(intent(['资料/Cafe\u0301.docx'])))
    await expect(store.load('project-a')).rejects.toThrow(/sync_reconcile_intent_invalid/)
  })

  it('keeps the serialized writer usable after a rejected intent', async () => {
    const { root, store } = await makeStore()
    await expect(store.enqueue(intent(['../escape']))).rejects.toThrow(/sync_path_invalid/)
    await expect(store.enqueue(intent(['documents/recovered.docx']))).resolves.toBeUndefined()
    await chmod(join(root, 'project-a.json'), 0o600)
    await expect(store.load('project-a')).resolves.toEqual(intent(['documents/recovered.docx']))
  })

  it('surfaces filesystem failures instead of treating them as an empty queue', async () => {
    const { root, store } = await makeStore()
    await mkdir(join(root, 'project-a.json'))
    await expect(store.load('project-a')).rejects.toBeTruthy()
  })
})
