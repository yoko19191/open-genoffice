import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentBindingStore, DocumentSessionIndexStore } from '@genoffice/agent-resource'
import { InMemorySyncObjectStore, ProjectSyncReconciler } from '@genoffice/project-store'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectSessionSyncBundleSchema,
  ProjectSessionSyncService,
  type ProjectSessionSyncServiceOptions,
} from '../src/project-session-sync'
import { createSessionRegistry } from '../src/session-registry'

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const FORK_ID = '33333333-3333-4333-8333-333333333333'
const PROJECT_ID = 'project-sync'
const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function sessionJsonl(
  assistantText: string,
  options: {
    complete?: boolean
    sessionId?: string
    parentSessionId?: string
    officeToolCatalog?: {
      app: 'docs'
      catalogHash: string
      descriptors: Array<{ id: string; modelAlias: string; effect: 'read' }>
    }
  } = {},
): Uint8Array {
  const sessionId = options.sessionId ?? SESSION_ID
  const lines = [
    {
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-08-10T00:00:00.000Z',
      cwd: '/device-local-path',
    },
    {
      type: 'custom',
      id: 'binding-entry',
      parentId: null,
      timestamp: '2026-08-10T00:00:00.000Z',
      customType: 'genoffice.document-binding',
      data: {
        documentId: DOCUMENT_ID,
        ...(options.officeToolCatalog ? { officeToolCatalog: options.officeToolCatalog } : {}),
      },
    },
    ...(options.parentSessionId
      ? [
          {
            type: 'custom',
            id: 'fork-entry',
            parentId: 'binding-entry',
            timestamp: '2026-08-10T00:00:00.500Z',
            customType: 'genoffice.session-fork',
            data: { documentId: DOCUMENT_ID, parentSessionId: options.parentSessionId },
          },
        ]
      : []),
    {
      type: 'message',
      id: 'user-entry',
      parentId: 'binding-entry',
      timestamp: '2026-08-10T00:00:01.000Z',
      message: { role: 'user', content: 'hello' },
    },
    {
      type: 'message',
      id: 'assistant-entry',
      parentId: 'user-entry',
      timestamp: '2026-08-10T00:00:02.000Z',
      message: { role: 'assistant', content: assistantText },
    },
  ]
  const text = lines.map((line) => JSON.stringify(line)).join('\n')
  return new TextEncoder().encode(`${text}${options.complete === false ? '' : '\n'}`)
}

async function seedDocument(
  root: string,
  transcript = sessionJsonl('source answer'),
): Promise<{ documentPath: string; sessionPath: string }> {
  const documentPath = join(root, 'documents', 'report.docx')
  await mkdir(join(root, 'documents'), { recursive: true })
  await writeFile(documentPath, 'office-document')
  const bindings = new DocumentBindingStore({
    rootDirectory: root,
    randomUUID: () => DOCUMENT_ID,
  })
  await bindings.openOrCreate({
    projectId: PROJECT_ID,
    format: 'docx',
    canonicalPath: documentPath,
  })
  const indexes = new DocumentSessionIndexStore({ rootDirectory: root })
  await indexes.setCurrent(DOCUMENT_ID, SESSION_ID)
  const sessionPath = join(root, 'agent', 'sessions', DOCUMENT_ID, `${SESSION_ID}.jsonl`)
  await mkdir(join(sessionPath, '..'), { recursive: true })
  await writeFile(sessionPath, transcript, { mode: 0o600 })
  return { documentPath, sessionPath }
}

function service(
  rootDirectory: string,
  options: {
    barrier?: ProjectSessionSyncServiceOptions['withCommittedReadBarrier']
    randomUUID?: () => string
  } = {},
) {
  return new ProjectSessionSyncService({
    rootDirectory,
    platform: process.platform,
    randomUUID: options.randomUUID ?? (() => FORK_ID),
    withCommittedReadBarrier:
      options.barrier ??
      (async (sessionId, read) =>
        read(join(rootDirectory, 'agent', 'sessions', DOCUMENT_ID, `${sessionId}.jsonl`))),
  })
}

describe('ProjectSessionSyncService', () => {
  it('captures only complete committed JSONL behind a read barrier and excludes local state', async () => {
    const root = await tempRoot('session-sync-source-')
    const { sessionPath } = await seedDocument(root)
    await writeFile(`${sessionPath}.append.tmp`, 'half-active-state')
    const barriers: string[] = []
    const sync = service(root, {
      barrier: async (sessionId, read) => {
        barriers.push(sessionId)
        return read(sessionPath)
      },
    })
    const snapshot = await sync.capture({
      documentId: DOCUMENT_ID,
      requiredCredentialSlots: [{ slotId: 'provider-main', providerId: 'openai-compatible' }],
      requiredResources: [
        {
          resourceId: 'global/skills/demo',
          contentHash: 'a'.repeat(64),
          executable: true,
          network: false,
        },
      ],
    })

    expect(barriers).toEqual([SESSION_ID])
    expect(snapshot.entries.map((entry) => [entry.canonicalPath, entry.kind])).toEqual([
      [`.open-genoffice/session-sync/${DOCUMENT_ID}/bundle.json`, 'project-metadata'],
      [
        `.open-genoffice/session-sync/${DOCUMENT_ID}/sessions/${SESSION_ID}.jsonl`,
        'pi-session-snapshot',
      ],
    ])
    expect(snapshot.bundle.currentSessionId).toBe(SESSION_ID)
    expect(snapshot.bundle.sessions[0]).toMatchObject({
      sessionId: SESSION_ID,
      parentSessionId: null,
      messageCount: 2,
      transcriptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      committedCursor: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain('half-active-state')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('lease')
  })

  it('sorts multiple forks and setup requirements while preserving safe Office catalog metadata', async () => {
    const root = await tempRoot('session-sync-multiple-')
    const seeded = await seedDocument(root)
    await new DocumentBindingStore({ rootDirectory: root }).bindPath(
      DOCUMENT_ID,
      seeded.documentPath,
      'in_app',
      '9'.repeat(64),
    )
    const catalog = {
      app: 'docs' as const,
      catalogHash: 'c'.repeat(64),
      descriptors: [
        { id: 'office:docs:read_text', modelAlias: 'read_text', effect: 'read' as const },
      ],
    }
    const forkPath = join(root, 'agent', 'sessions', DOCUMENT_ID, `${FORK_ID}.jsonl`)
    await writeFile(
      forkPath,
      sessionJsonl('fork answer', {
        sessionId: FORK_ID,
        parentSessionId: SESSION_ID,
        officeToolCatalog: catalog,
      }),
    )
    const captured = await service(root).capture({
      documentId: DOCUMENT_ID,
      requiredCredentialSlots: [
        { slotId: 'z-slot', providerId: 'z-provider' },
        { slotId: 'a-slot', providerId: 'a-provider' },
      ],
      requiredResources: [
        {
          resourceId: 'z-resource',
          contentHash: 'f'.repeat(64),
          executable: false,
          network: false,
        },
        {
          resourceId: 'a-resource',
          contentHash: 'e'.repeat(64),
          executable: true,
          network: false,
        },
      ],
    })
    expect(captured.bundle.sessions.map((item) => item.sessionId)).toEqual([SESSION_ID, FORK_ID])
    expect(captured.bundle.sessions[1]).toMatchObject({
      parentSessionId: SESSION_ID,
      officeToolCatalog: catalog,
    })
    expect(captured.bundle.lastKnownContentHash).toBe('9'.repeat(64))
    expect(captured.bundle.requiredCredentialSlots.map((item) => item.slotId)).toEqual([
      'a-slot',
      'z-slot',
    ])

    const targetRoot = await tempRoot('session-sync-multiple-target-')
    const targetDocument = join(targetRoot, 'document.docx')
    await writeFile(targetDocument, 'document')
    const restored = await service(targetRoot).restore(captured.entries, {
      documentId: DOCUMENT_ID,
      targetDocumentPath: targetDocument,
      availableCredentialSlots: ['z-slot', 'a-slot'],
      activeResourceHashes: ['e'.repeat(64)],
    })
    expect(restored).toMatchObject({
      status: 'restored',
      missingCredentialSlots: [],
      inactiveResourceHashes: [],
    })
    const runtimeBinding = JSON.parse(
      await readFile(join(targetRoot, 'state', 'session-bindings', `${FORK_ID}.json`), 'utf8'),
    )
    expect(runtimeBinding).toMatchObject({
      parentSessionId: SESSION_ID,
      officeToolCatalog: catalog,
    })
  })

  it('rejects half JSONL, a mismatched document binding and a changed file during the barrier', async () => {
    const root = await tempRoot('session-sync-invalid-')
    const { sessionPath } = await seedDocument(root, sessionJsonl('answer', { complete: false }))
    await expect(service(root).capture({ documentId: DOCUMENT_ID })).rejects.toThrow(
      /session_snapshot_incomplete/,
    )

    await writeFile(
      sessionPath,
      Buffer.from(sessionJsonl('answer')).toString().replace(DOCUMENT_ID, FORK_ID),
    )
    await expect(service(root).capture({ documentId: DOCUMENT_ID })).rejects.toThrow(
      /session_snapshot_binding_mismatch/,
    )

    await writeFile(sessionPath, sessionJsonl('answer'))
    const changing = service(root, {
      barrier: async (_sessionId, read) => {
        const result = await read(sessionPath)
        await writeFile(sessionPath, sessionJsonl('changed-during-read'))
        return result
      },
    })
    await expect(changing.capture({ documentId: DOCUMENT_ID })).rejects.toThrow(
      /session_snapshot_changed/,
    )
  })

  it('rejects malformed transcript structures, unsafe files and inconsistent indexes', async () => {
    const root = await tempRoot('session-sync-malformed-')
    const { sessionPath } = await seedDocument(root)
    const malformed = [
      new Uint8Array(),
      new TextEncoder().encode('{}\n\n'),
      new TextEncoder().encode('[]\n'),
      new TextEncoder().encode('{\n'),
      new TextEncoder().encode(`${JSON.stringify({ type: 'session', id: FORK_ID })}\n`),
      new TextEncoder().encode(
        `${Buffer.from(sessionJsonl('answer')).toString().replace('assistant-entry', 'user-entry')}`,
      ),
      new TextEncoder().encode(
        `${Buffer.from(sessionJsonl('answer'))
          .toString()
          .replace('"customType":"genoffice.document-binding"', '"customType":"unknown"')}`,
      ),
      new TextEncoder().encode(
        Buffer.from(sessionJsonl('answer', { parentSessionId: FORK_ID }))
          .toString()
          .replace(FORK_ID, 'bad-parent'),
      ),
      new TextEncoder().encode(
        Buffer.from(
          sessionJsonl('answer', {
            officeToolCatalog: {
              app: 'docs',
              catalogHash: 'c'.repeat(64),
              descriptors: [
                { id: 'office:docs:read_text', modelAlias: 'read_text', effect: 'read' },
              ],
            },
          }),
        )
          .toString()
          .replace('"catalogHash":"', '"catalogHash":"bad'),
      ),
    ]
    for (const bytes of malformed) {
      await writeFile(sessionPath, bytes)
      await expect(service(root).capture({ documentId: DOCUMENT_ID })).rejects.toThrow(
        /session_snapshot_/,
      )
    }

    await writeFile(sessionPath, sessionJsonl('answer'))
    await unlink(sessionPath)
    await symlink(await tempRoot('session-sync-outside-'), sessionPath)
    await expect(service(root).capture({ documentId: DOCUMENT_ID })).rejects.toThrow(
      /session_snapshot_invalid/,
    )

    const noIndexRoot = await tempRoot('session-sync-no-index-')
    const documentPath = join(noIndexRoot, 'document.docx')
    await writeFile(documentPath, 'document')
    await new DocumentBindingStore({
      rootDirectory: noIndexRoot,
      randomUUID: () => DOCUMENT_ID,
    }).openOrCreate({ projectId: PROJECT_ID, format: 'docx', canonicalPath: documentPath })
    await expect(service(noIndexRoot).capture({ documentId: DOCUMENT_ID })).rejects.toThrow(
      /session_snapshot_index_missing/,
    )
    await new DocumentSessionIndexStore({ rootDirectory: noIndexRoot }).setCurrent(
      DOCUMENT_ID,
      SESSION_ID,
    )
    await expect(service(noIndexRoot).capture({ documentId: DOCUMENT_ID })).rejects.toThrow(
      /session_snapshot_current_missing/,
    )

    const invalidDirectoryRoot = await tempRoot('session-sync-invalid-directory-')
    const invalidDocument = join(invalidDirectoryRoot, 'document.docx')
    await writeFile(invalidDocument, 'document')
    await new DocumentBindingStore({
      rootDirectory: invalidDirectoryRoot,
      randomUUID: () => DOCUMENT_ID,
    }).openOrCreate({ projectId: PROJECT_ID, format: 'docx', canonicalPath: invalidDocument })
    await new DocumentSessionIndexStore({ rootDirectory: invalidDirectoryRoot }).setCurrent(
      DOCUMENT_ID,
      SESSION_ID,
    )
    await mkdir(join(invalidDirectoryRoot, 'agent', 'sessions'), { recursive: true })
    await writeFile(join(invalidDirectoryRoot, 'agent', 'sessions', DOCUMENT_ID), 'not-a-directory')
    await expect(
      service(invalidDirectoryRoot).capture({ documentId: DOCUMENT_ID }),
    ).rejects.toThrow(/ENOTDIR/)
  })

  it('rejects invalid and duplicate credential or resource requirements', async () => {
    const root = await tempRoot('session-sync-requirements-')
    await seedDocument(root)
    await expect(
      service(root).capture({
        documentId: DOCUMENT_ID,
        requiredCredentialSlots: [{ slotId: 'bad slot', providerId: 'provider' }],
      }),
    ).rejects.toThrow(/session_snapshot_requirement_invalid/)
    await expect(
      service(root).capture({
        documentId: DOCUMENT_ID,
        requiredCredentialSlots: [
          { slotId: 'same', providerId: 'one' },
          { slotId: 'same', providerId: 'two' },
        ],
      }),
    ).rejects.toThrow(/session_snapshot_requirement_invalid/)
    await expect(
      service(root).capture({
        documentId: DOCUMENT_ID,
        requiredResources: [
          {
            resourceId: 'demo',
            contentHash: 'bad-hash',
            executable: false,
            network: false,
          },
        ],
      }),
    ).rejects.toThrow(/session_snapshot_requirement_invalid/)
    const duplicate = {
      resourceId: 'demo',
      contentHash: 'd'.repeat(64),
      executable: false,
      network: false,
    }
    await expect(
      service(root).capture({
        documentId: DOCUMENT_ID,
        requiredResources: [duplicate, duplicate],
      }),
    ).rejects.toThrow(/session_snapshot_requirement_invalid/)
  })

  it('round-trips a clean second device through Project Reconciler without duplicate messages', async () => {
    const sourceRoot = await tempRoot('session-sync-provider-source-')
    await seedDocument(sourceRoot)
    const captured = await service(sourceRoot).capture({
      documentId: DOCUMENT_ID,
      requiredCredentialSlots: [{ slotId: 'provider-main', providerId: 'openai-compatible' }],
      requiredResources: [
        {
          resourceId: 'global/extensions/demo',
          contentHash: 'b'.repeat(64),
          executable: false,
          network: true,
        },
      ],
    })
    const store = new InMemorySyncObjectStore()
    const first = new ProjectSyncReconciler({
      store,
      scopeId: PROJECT_ID,
      authorDeviceId: 'device-a',
    })
    const published = await first.publish(captured.entries)
    if (published.status !== 'published') throw new Error('publish_failed')
    const stagingRoot = await tempRoot('session-sync-provider-staging-')
    const second = new ProjectSyncReconciler({
      store,
      scopeId: PROJECT_ID,
      authorDeviceId: 'device-b',
    })
    await expect(second.restore(stagingRoot)).resolves.toMatchObject({ status: 'restored' })
    const restoredEntries = await Promise.all(
      captured.entries.map(async (entry) => ({
        canonicalPath: entry.canonicalPath,
        kind: entry.kind,
        bytes: new Uint8Array(await readFile(join(stagingRoot, ...entry.canonicalPath.split('/')))),
      })),
    )

    const targetRoot = await tempRoot('session-sync-provider-target-')
    const targetDocument = join(targetRoot, 'documents', 'report.docx')
    await mkdir(join(targetRoot, 'documents'), { recursive: true })
    await writeFile(targetDocument, 'office-document')
    const restored = await service(targetRoot).restore(restoredEntries, {
      documentId: DOCUMENT_ID,
      targetDocumentPath: targetDocument,
      availableCredentialSlots: [],
      activeResourceHashes: [],
    })
    expect(restored).toMatchObject({
      status: 'restored',
      restoredSessionIds: [SESSION_ID],
      forkCandidates: [],
      missingCredentialSlots: ['provider-main'],
      inactiveResourceHashes: ['b'.repeat(64)],
      committedCursor: captured.bundle.committedCursor,
    })
    const targetBytes = await readFile(
      join(targetRoot, 'agent', 'sessions', DOCUMENT_ID, `${SESSION_ID}.jsonl`),
    )
    expect(targetBytes).toEqual(Buffer.from(sessionJsonl('source answer')))
    expect(targetBytes.toString().match(/"type":"message"/g)).toHaveLength(2)
    await expect(
      new DocumentBindingStore({ rootDirectory: targetRoot }).get(DOCUMENT_ID),
    ).resolves.toMatchObject({ documentId: DOCUMENT_ID, projectId: PROJECT_ID, state: 'bound' })
    await expect(
      new DocumentSessionIndexStore({ rootDirectory: targetRoot }).current(DOCUMENT_ID),
    ).resolves.toMatchObject({ currentSessionId: SESSION_ID })

    const runtimeIds = [
      '44444444-4444-4444-8444-444444444441',
      '44444444-4444-4444-8444-444444444442',
      '44444444-4444-4444-8444-444444444443',
    ]
    const targetRuntime = createSessionRegistry({
      dataRoot: targetRoot,
      instanceId: 'device-b-runtime',
      cursorSecret: Buffer.alloc(32, 8),
      randomUUID: () => runtimeIds.shift() ?? '44444444-4444-4444-8444-444444444449',
    })
    const opened = await targetRuntime.open({
      operationId: 'open-restored-session',
      documentId: DOCUMENT_ID,
      sessionId: SESSION_ID,
    })
    expect(opened.snapshot.messages).toEqual([
      expect.objectContaining({ id: 'user-entry', role: 'user', text: 'hello' }),
      expect.objectContaining({ id: 'assistant-entry', role: 'assistant', text: 'source answer' }),
    ])
    await targetRuntime.prompt({
      operationId: 'continue-restored-session',
      documentId: DOCUMENT_ID,
      sessionId: SESSION_ID,
      text: 'continue on device b',
    })
    await targetRuntime.waitForIdle(SESSION_ID)
    const continued = await targetRuntime.snapshot({
      documentId: DOCUMENT_ID,
      sessionId: SESSION_ID,
    })
    expect(continued.messages.filter((message) => message.id === 'user-entry')).toHaveLength(1)
    expect(continued.messages.filter((message) => message.id === 'assistant-entry')).toHaveLength(1)
    expect(continued.messages.map((message) => message.text)).toEqual(
      expect.arrayContaining(['hello', 'source answer', 'continue on device b']),
    )
    await targetRuntime.shutdown()
  })

  it('keeps a divergent Local Current and imports the remote branch only as a new fork', async () => {
    const remoteRoot = await tempRoot('session-sync-remote-')
    await seedDocument(
      remoteRoot,
      sessionJsonl('remote answer', {
        parentSessionId: '55555555-5555-4555-8555-555555555555',
      }),
    )
    const remote = await service(remoteRoot).capture({ documentId: DOCUMENT_ID })

    const localRoot = await tempRoot('session-sync-local-')
    const { sessionPath } = await seedDocument(localRoot, sessionJsonl('local answer'))
    const localBefore = await readFile(sessionPath)
    const restored = await service(localRoot, { randomUUID: () => FORK_ID }).restore(
      remote.entries,
      {
        documentId: DOCUMENT_ID,
        targetDocumentPath: join(localRoot, 'documents', 'report.docx'),
        availableCredentialSlots: [],
        activeResourceHashes: [],
      },
    )
    expect(restored.status).toBe('fork_candidates')
    expect(restored.forkCandidates).toEqual([
      expect.objectContaining({
        sourceSessionId: SESSION_ID,
        candidateId: expect.stringMatching(/^[a-f0-9]{64}$/),
        messageCount: 2,
      }),
    ])
    expect(await readFile(sessionPath)).toEqual(localBefore)
    await expect(
      new DocumentSessionIndexStore({ rootDirectory: localRoot }).current(DOCUMENT_ID),
    ).resolves.toMatchObject({ currentSessionId: SESSION_ID })

    const imported = await service(localRoot, { randomUUID: () => FORK_ID }).importFork({
      documentId: DOCUMENT_ID,
      candidateId: restored.forkCandidates[0]!.candidateId,
    })
    expect(imported).toMatchObject({
      sessionId: FORK_ID,
      parentSessionId: SESSION_ID,
      sourceSessionId: SESSION_ID,
    })
    const fork = await readFile(
      join(localRoot, 'agent', 'sessions', DOCUMENT_ID, `${FORK_ID}.jsonl`),
      'utf8',
    )
    const lines = fork
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ type: 'session', id: FORK_ID })
    expect(lines.filter((line) => line.type === 'message').map((line) => line.id)).toEqual([
      'user-entry',
      'assistant-entry',
    ])
    expect(lines.at(-1)).toMatchObject({
      customType: 'genoffice.session-fork',
      data: { documentId: DOCUMENT_ID, parentSessionId: SESSION_ID },
    })
    await expect(
      readFile(join(localRoot, 'state', 'session-bindings', `${FORK_ID}.json`), 'utf8').then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({ parentSessionId: SESSION_ID })
    await expect(
      new DocumentSessionIndexStore({ rootDirectory: localRoot }).current(DOCUMENT_ID),
    ).resolves.toMatchObject({ currentSessionId: FORK_ID })
  })

  it('returns explanatory rebind and collision states without changing existing bindings', async () => {
    const sourceRoot = await tempRoot('session-sync-status-source-')
    await seedDocument(sourceRoot)
    const captured = await service(sourceRoot).capture({ documentId: DOCUMENT_ID })
    const targetRoot = await tempRoot('session-sync-status-target-')

    await expect(
      service(targetRoot).restore(captured.entries, {
        documentId: DOCUMENT_ID,
        availableCredentialSlots: [],
        activeResourceHashes: [],
      }),
    ).resolves.toMatchObject({ status: 'needs_rebind' })

    const occupiedPath = join(targetRoot, 'occupied.docx')
    await writeFile(occupiedPath, 'occupied')
    const occupiedId = '44444444-4444-4444-8444-444444444444'
    await new DocumentBindingStore({
      rootDirectory: targetRoot,
      randomUUID: () => occupiedId,
    }).openOrCreate({ projectId: 'other-project', format: 'pdf', canonicalPath: occupiedPath })
    await expect(
      service(targetRoot).restore(captured.entries, {
        documentId: DOCUMENT_ID,
        targetDocumentPath: occupiedPath,
        availableCredentialSlots: [],
        activeResourceHashes: [],
      }),
    ).resolves.toMatchObject({ status: 'binding_conflict' })
    await expect(
      new DocumentBindingStore({ rootDirectory: targetRoot }).get(occupiedId),
    ).resolves.toMatchObject({ projectId: 'other-project', documentId: occupiedId })
    expect(await readFile(occupiedPath, 'utf8')).toBe('occupied')
  })

  it('validates every bundle and transcript before writing target state', async () => {
    const sourceRoot = await tempRoot('session-sync-decode-source-')
    await seedDocument(sourceRoot)
    const captured = await service(sourceRoot).capture({ documentId: DOCUMENT_ID })
    const targetRoot = await tempRoot('session-sync-decode-target-')
    const targetDocument = join(targetRoot, 'document.docx')
    await writeFile(targetDocument, 'document')
    const restore = (entries: typeof captured.entries) =>
      service(targetRoot).restore(entries, {
        documentId: DOCUMENT_ID,
        targetDocumentPath: targetDocument,
        availableCredentialSlots: [],
        activeResourceHashes: [],
      })
    await expect(restore([])).rejects.toThrow(/session_snapshot_bundle_missing/)
    await expect(restore([captured.entries[0]!, captured.entries[0]!])).rejects.toThrow(
      /session_snapshot_bundle_missing/,
    )
    await expect(
      restore([{ ...captured.entries[0]!, tombstone: true, bytes: undefined }]),
    ).rejects.toThrow(/session_snapshot_bundle_missing/)
    await expect(
      restore([{ ...captured.entries[0]!, bytes: new TextEncoder().encode('{') }]),
    ).rejects.toThrow(/session_snapshot_invalid/)

    const bundle = structuredClone(captured.bundle)
    bundle.documentId = FORK_ID
    await expect(
      restore([
        { ...captured.entries[0]!, bytes: new TextEncoder().encode(JSON.stringify(bundle)) },
        captured.entries[1]!,
      ]),
    ).rejects.toThrow(/session_snapshot_invalid/)
    expect(ProjectSessionSyncBundleSchema).toBeDefined()

    const missingCurrent = structuredClone(captured.bundle)
    missingCurrent.currentSessionId = FORK_ID
    await expect(
      restore([
        {
          ...captured.entries[0]!,
          bytes: new TextEncoder().encode(JSON.stringify(missingCurrent)),
        },
        captured.entries[1]!,
      ]),
    ).rejects.toThrow(/session_snapshot_current_missing/)

    await expect(restore([captured.entries[0]!])).rejects.toThrow(
      /session_snapshot_session_missing/,
    )
    await expect(
      restore([captured.entries[0]!, captured.entries[1]!, captured.entries[1]!]),
    ).rejects.toThrow(/session_snapshot_session_missing/)
    await expect(
      restore([
        captured.entries[0]!,
        { ...captured.entries[1]!, tombstone: true, bytes: undefined },
      ]),
    ).rejects.toThrow(/session_snapshot_session_missing/)
    await expect(
      restore([captured.entries[0]!, { ...captured.entries[1]!, bytes: sessionJsonl('tampered') }]),
    ).rejects.toThrow(/session_snapshot_invalid/)
  })

  it('requires explicit rebind confirmation and preserves matching sessions idempotently', async () => {
    const sourceRoot = await tempRoot('session-sync-rebind-source-')
    await seedDocument(sourceRoot)
    const captured = await service(sourceRoot).capture({ documentId: DOCUMENT_ID })
    const targetRoot = await tempRoot('session-sync-rebind-target-')
    const original = await seedDocument(targetRoot)
    const moved = join(targetRoot, 'documents', 'moved.docx')
    await writeFile(moved, 'office-document')
    const sync = service(targetRoot)
    await expect(
      sync.restore(captured.entries, {
        documentId: DOCUMENT_ID,
        availableCredentialSlots: [],
        activeResourceHashes: [],
      }),
    ).resolves.toMatchObject({ status: 'restored' })
    const options = {
      documentId: DOCUMENT_ID,
      targetDocumentPath: moved,
      availableCredentialSlots: [],
      activeResourceHashes: [],
    }
    await expect(sync.restore(captured.entries, options)).resolves.toMatchObject({
      status: 'needs_rebind',
    })
    expect(
      (await new DocumentBindingStore({ rootDirectory: targetRoot }).get(DOCUMENT_ID))
        .canonicalPath,
    ).not.toContain('moved.docx')
    await expect(
      sync.restore(captured.entries, { ...options, confirmRebind: true }),
    ).resolves.toMatchObject({ status: 'restored', restoredSessionIds: [SESSION_ID] })
    expect(await readFile(original.sessionPath)).toEqual(Buffer.from(sessionJsonl('source answer')))
    await expect(
      sync.restore(captured.entries, { ...options, confirmRebind: true }),
    ).resolves.toMatchObject({ status: 'restored', restoredSessionIds: [SESSION_ID] })

    const mismatched = structuredClone(captured.bundle)
    mismatched.projectId = 'different-project'
    await expect(
      sync.restore(
        [
          {
            ...captured.entries[0]!,
            bytes: new TextEncoder().encode(JSON.stringify(mismatched)),
          },
          captured.entries[1]!,
        ],
        { ...options, confirmRebind: true },
      ),
    ).resolves.toMatchObject({ status: 'binding_conflict' })
  })

  it('binds an unsaved synced document and keeps a missing document pending until confirmation', async () => {
    const sourceRoot = await tempRoot('session-sync-unbound-source-')
    await seedDocument(sourceRoot)
    const captured = await service(sourceRoot).capture({ documentId: DOCUMENT_ID })

    const unsavedRoot = await tempRoot('session-sync-unsaved-target-')
    await new DocumentBindingStore({
      rootDirectory: unsavedRoot,
      randomUUID: () => DOCUMENT_ID,
    }).createUnsaved({ projectId: PROJECT_ID, format: 'docx' })
    const unsavedPath = join(unsavedRoot, 'unsaved.docx')
    await writeFile(unsavedPath, 'document')
    await expect(
      service(unsavedRoot).restore(captured.entries, {
        documentId: DOCUMENT_ID,
        targetDocumentPath: unsavedPath,
        availableCredentialSlots: [],
        activeResourceHashes: [],
      }),
    ).resolves.toMatchObject({ status: 'restored' })

    const missingRoot = await tempRoot('session-sync-missing-target-')
    const missingBindings = new DocumentBindingStore({
      rootDirectory: missingRoot,
      randomUUID: () => DOCUMENT_ID,
    })
    await missingBindings.createUnsaved({ projectId: PROJECT_ID, format: 'docx' })
    await missingBindings.markMissing(DOCUMENT_ID)
    const missingPath = join(missingRoot, 'rebound.docx')
    await writeFile(missingPath, 'document')
    const missingSync = service(missingRoot)
    const input = {
      documentId: DOCUMENT_ID,
      targetDocumentPath: missingPath,
      availableCredentialSlots: [],
      activeResourceHashes: [],
    }
    await expect(missingSync.restore(captured.entries, input)).resolves.toMatchObject({
      status: 'needs_rebind',
    })
    await expect(
      missingSync.restore(captured.entries, { ...input, confirmRebind: true }),
    ).resolves.toMatchObject({ status: 'restored' })
  })

  it('rejects invalid or tampered fork candidates without changing the current session', async () => {
    const remoteRoot = await tempRoot('session-sync-candidate-remote-')
    await seedDocument(remoteRoot, sessionJsonl('remote'))
    const remote = await service(remoteRoot).capture({ documentId: DOCUMENT_ID })
    const localRoot = await tempRoot('session-sync-candidate-local-')
    await seedDocument(localRoot, sessionJsonl('local'))
    const sync = service(localRoot)
    const restored = await sync.restore(remote.entries, {
      documentId: DOCUMENT_ID,
      targetDocumentPath: join(localRoot, 'documents', 'report.docx'),
      availableCredentialSlots: [],
      activeResourceHashes: [],
    })
    const candidateId = restored.forkCandidates[0]!.candidateId
    await expect(sync.importFork({ documentId: 'bad', candidateId })).rejects.toThrow(
      /session_fork_candidate_invalid/,
    )
    await expect(sync.importFork({ documentId: DOCUMENT_ID, candidateId: 'bad' })).rejects.toThrow(
      /session_fork_candidate_invalid/,
    )
    await expect(
      sync.importFork({ documentId: DOCUMENT_ID, candidateId: '0'.repeat(64) }),
    ).rejects.toThrow(/session_fork_candidate_invalid/)

    const conflictDirectory = join(
      localRoot,
      'sync',
      'conflicts',
      'project',
      createHash('sha256').update(DOCUMENT_ID).digest('hex'),
      candidateId,
    )
    await expect(
      service(localRoot, { randomUUID: () => 'bad-fork-id' }).importFork({
        documentId: DOCUMENT_ID,
        candidateId,
      }),
    ).rejects.toThrow(/session_fork_candidate_invalid/)
    await writeFile(join(conflictDirectory, 'candidate.json'), '{}')
    await expect(sync.importFork({ documentId: DOCUMENT_ID, candidateId })).rejects.toThrow(
      /session_fork_candidate_invalid/,
    )
    await sync.restore(remote.entries, {
      documentId: DOCUMENT_ID,
      targetDocumentPath: join(localRoot, 'documents', 'report.docx'),
      availableCredentialSlots: [],
      activeResourceHashes: [],
    })
    await writeFile(join(conflictDirectory, 'session.jsonl'), sessionJsonl('tampered'))
    await expect(sync.importFork({ documentId: DOCUMENT_ID, candidateId })).rejects.toThrow(
      /session_fork_candidate_invalid/,
    )
    await expect(
      new DocumentSessionIndexStore({ rootDirectory: localRoot }).current(DOCUMENT_ID),
    ).resolves.toMatchObject({ currentSessionId: SESSION_ID })

    await expect(
      service(await tempRoot('session-sync-no-binding-')).importFork({
        documentId: DOCUMENT_ID,
        candidateId,
      }),
    ).rejects.toThrow(/session_snapshot_binding_missing/)
  })

  it('uses the Runtime idle/fsync barrier for a real Pi Session file', async () => {
    const root = await tempRoot('session-sync-runtime-barrier-')
    const documentPath = join(root, 'document.docx')
    await writeFile(documentPath, 'document')
    await new DocumentBindingStore({
      rootDirectory: root,
      randomUUID: () => DOCUMENT_ID,
    }).openOrCreate({ projectId: PROJECT_ID, format: 'docx', canonicalPath: documentPath })
    const ids = [SESSION_ID]
    const registry = createSessionRegistry({
      dataRoot: root,
      instanceId: 'runtime-sync',
      cursorSecret: Buffer.alloc(32, 7),
      randomUUID: () => ids.shift() ?? FORK_ID,
    })
    const created = await registry.create({ operationId: 'create-sync', documentId: DOCUMENT_ID })
    await new DocumentSessionIndexStore({ rootDirectory: root }).setCurrent(
      DOCUMENT_ID,
      created.sessionId,
    )
    const captured = await new ProjectSessionSyncService({
      rootDirectory: root,
      withCommittedReadBarrier: (sessionId, read) =>
        registry.withCommittedReadBarrier({ sessionId, documentId: DOCUMENT_ID }, read),
    }).capture({ documentId: DOCUMENT_ID })
    expect(captured.bundle.sessions).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, messageCount: 0 }),
    ])
    await registry.shutdown()
  })
})
