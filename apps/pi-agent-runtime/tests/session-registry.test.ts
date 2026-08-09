import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { RuntimeSessionError, createSessionRegistry } from '../src'

const roots: string[] = []
const operationId = '11111111-1111-4111-8111-111111111111'

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-registry-'))
  roots.push(dataRoot)
  let uuid = 0
  const registry = createSessionRegistry({
    dataRoot,
    instanceId: 'instance-1',
    cursorSecret: Buffer.alloc(32, 7),
    randomUUID: () => {
      uuid += 1
      return `${String(uuid).padStart(8, '0')}-0000-4000-8000-000000000000`
    },
    now: () => new Date('2026-08-09T12:00:00.000Z'),
  })
  return { dataRoot, registry }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakePiSession(options: {
  sessionFile?: string
  messages?: Array<Record<string, unknown>>
  prompt?: (emit: (event: AgentSessionEvent) => void) => Promise<void>
}) {
  let listener: (event: AgentSessionEvent) => void = () => {}
  const dispose = () => {}
  return {
    handle: {
      session: { sessionFile: options.sessionFile },
      sessionManager: { getBranch: () => options.messages ?? [] },
      subscribe: (next: (event: AgentSessionEvent) => void) => {
        listener = next
        return dispose
      },
      prompt: async () => options.prompt?.(listener),
      dispose,
    },
    emit: (event: AgentSessionEvent) => listener(event),
  }
}

describe('document-bound Pi Session registry', () => {
  it('creates one real Pi AgentSession and projects its native stream in journal order', async () => {
    const { dataRoot, registry } = await harness()
    const published: string[] = []
    registry.onEvent((event) => published.push(event.type))

    const created = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    const prompted = await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      text: 'exercise the native Pi stream',
    })
    await registry.waitForIdle(created.sessionId)

    const snapshot = await registry.snapshot({
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    const journal = await registry.readJournal(created.sessionId)
    expect(prompted).toMatchObject({
      runId: expect.any(String),
      acceptedCursor: expect.any(String),
    })
    expect(journal.map((event) => event.sequence)).toEqual(
      journal.map((_event, index) => index + 1),
    )
    expect(published).toEqual(journal.map((event) => event.type))
    expect(journal.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'session.opened',
        'run.queued',
        'run.started',
        'message.started',
        'thinking.started',
        'thinking.delta',
        'thinking.completed',
        'message.delta',
        'tool.requested',
        'tool.started',
        'tool.completed',
        'message.completed',
        'compaction.started',
        'compaction.completed',
        'branch.created',
        'run.completed',
      ]),
    )
    expect(journal.at(-1)?.type).toBe('run.completed')
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ])
    expect(snapshot.lastSequence).toBe(journal.length)
    expect(snapshot.cursor).toBe(journal.at(-1)?.cursor)

    const binding = JSON.parse(
      await readFile(
        join(dataRoot, 'state', 'session-bindings', `${created.sessionId}.json`),
        'utf8',
      ),
    )
    const transcript = await readFile(binding.sessionFile, 'utf8')
    expect(transcript).toContain('"type":"session"')
    expect(transcript).toContain('exercise the native Pi stream')
    expect(transcript).toContain('genoffice.document-binding')
    expect(transcript).toContain('"type":"compaction"')
    expect(transcript).toContain('genoffice.contract-branch')
    expect(binding.sessionFile).toContain(`/agent/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/`)
    expect(binding.sessionFile).toMatch(new RegExp(`${created.sessionId}\\.jsonl$`))
    expect(transcript).not.toContain('run.queued')
    await registry.shutdown()
  })

  it('returns the first receipt for an identical operation and rejects payload drift', async () => {
    const { registry } = await harness()
    const first = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    await expect(
      registry.create({ operationId, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }),
    ).resolves.toEqual(first)
    await expect(
      registry.create({ operationId, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' }),
    ).rejects.toEqual(new RuntimeSessionError('duplicate_operation_mismatch'))
    expect(await registry.listBindings()).toHaveLength(1)
    await registry.shutdown()
  })

  it('fails closed on a different document before opening or changing the Pi transcript', async () => {
    const { registry } = await harness()
    const created = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      text: 'create a transcript before the mismatch probe',
    })
    await registry.waitForIdle(created.sessionId)
    const binding = (await registry.listBindings())[0]!
    const before = await stat(binding.sessionFile)

    await expect(
      registry.open({
        operationId: '33333333-3333-4333-8333-333333333333',
        sessionId: created.sessionId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      }),
    ).rejects.toEqual(new RuntimeSessionError('document_mismatch'))
    await expect(
      registry.prompt({
        operationId: '44444444-4444-4444-8444-444444444444',
        sessionId: created.sessionId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        text: 'must never reach Pi',
      }),
    ).rejects.toEqual(new RuntimeSessionError('document_mismatch'))

    const after = await stat(binding.sessionFile)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    await registry.shutdown()
  })

  it('opens the persisted Pi JSONL and returns replay events after a valid cursor', async () => {
    const { dataRoot, registry } = await harness()
    const created = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    const firstCursor = created.cursor
    await registry.shutdown()

    const reopened = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-2',
      cursorSecret: Buffer.alloc(32, 8),
      randomUUID: () => '99999999-9999-4999-8999-999999999999',
      now: () => new Date('2026-08-09T12:01:00.000Z'),
    })
    const result = await reopened.open({
      operationId: '44444444-4444-4444-8444-444444444444',
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    expect(result.snapshot.messages).toEqual([])
    expect(result.cursor).not.toBe(firstCursor)

    const subscription = await reopened.subscribe({
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      afterCursor: result.cursor,
    })
    expect(subscription).toMatchObject({ resetRequired: false, events: [] })
    await reopened.shutdown()
  })

  it('covers reset cursors, missing sessions, busy runs, and provider failures without duplicating work', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-errors-'))
    roots.push(dataRoot)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = fakePiSession({
      sessionFile: join(dataRoot, 'fake-session.jsonl'),
      prompt: async (emit) => {
        emit({ type: 'agent_start' })
        await blocked
        throw new Error('synthetic provider failure')
      },
    })
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-errors',
      cursorSecret: Buffer.alloc(32, 4),
      randomUUID: (() => {
        let id = 0
        return () => `${String(++id).padStart(8, '0')}-0000-4000-8000-000000000000`
      })(),
      createPiSession: async () => fake.handle as never,
    })
    const created = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    fake.emit({ type: 'agent_start' })
    await expect(registry.waitForIdle('ffffffff-ffff-4fff-8fff-ffffffffffff')).rejects.toEqual(
      new RuntimeSessionError('session_not_found'),
    )
    await expect(
      registry.subscribe({
        sessionId: created.sessionId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).resolves.toMatchObject({ resetRequired: true })
    await expect(
      registry.subscribe({
        sessionId: created.sessionId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        afterCursor: 'malformed',
      }),
    ).resolves.toMatchObject({ resetRequired: true })

    await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      text: 'blocked run',
    })
    await expect(
      registry.prompt({
        operationId: '33333333-3333-4333-8333-333333333333',
        sessionId: created.sessionId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        text: 'must be rejected while busy',
      }),
    ).rejects.toEqual(new RuntimeSessionError('invalid_state'))
    release()
    await registry.waitForIdle(created.sessionId)
    expect((await registry.readJournal(created.sessionId)).at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { reason: 'provider_error' },
    })
    await registry.shutdown()
  })

  it('projects failure/progress event branches and only exposes render-safe transcript fields', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-projector-'))
    roots.push(dataRoot)
    const sessionFile = join(dataRoot, 'fake-session.jsonl')
    await writeFile(sessionFile, '{"type":"session"}\n')
    const fake = fakePiSession({
      sessionFile,
      messages: [
        {
          type: 'message',
          id: 'user-entry',
          message: { role: 'user', content: 'plain user text', timestamp: 1 },
        },
        {
          type: 'message',
          id: 'assistant-entry',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hidden' },
              { type: 'toolCall', id: 'tool-1', name: 'probe', arguments: {} },
            ],
            stopReason: 'error',
          },
        },
        { type: 'message', id: 'custom-entry', message: { role: 'custom', content: 'hidden' } },
      ],
      prompt: async (emit) => {
        emit({ type: 'agent_start' })
        emit({
          type: 'message_update',
          message: {} as never,
          assistantMessageEvent: { type: 'start', partial: {} as never },
        })
        emit({
          type: 'tool_execution_update',
          toolCallId: 'tool-1',
          toolName: 'probe',
          args: {},
          partialResult: {},
        })
        emit({
          type: 'tool_execution_end',
          toolCallId: 'tool-1',
          toolName: 'probe',
          result: {},
          isError: true,
        })
        emit({
          type: 'compaction_start',
          reason: 'manual',
        })
        emit({
          type: 'compaction_end',
          reason: 'manual',
          result: undefined,
          aborted: true,
          willRetry: false,
        })
        emit({
          type: 'compaction_end',
          reason: 'threshold',
          result: undefined,
          aborted: false,
          willRetry: false,
        })
        emit({
          type: 'agent_end',
          messages: [],
          willRetry: true,
        })
        emit({
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [],
              stopReason: 'error',
            } as never,
          ],
          willRetry: false,
        })
      },
    })
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-projector',
      cursorSecret: Buffer.alloc(32, 5),
      randomUUID: (() => {
        let id = 0
        return () => `${String(++id).padStart(8, '0')}-0000-4000-8000-000000000000`
      })(),
      createPiSession: async () => fake.handle as never,
    })
    const created = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      text: 'project events',
    })
    await registry.waitForIdle(created.sessionId)
    const snapshot = await registry.snapshot({
      sessionId: created.sessionId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    expect(snapshot.messages).toEqual([
      { id: 'user-entry', role: 'user', text: 'plain user text' },
      { id: 'assistant-entry', role: 'assistant', text: '' },
    ])
    expect((await registry.readJournal(created.sessionId)).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'tool.progress',
        'tool.failed',
        'compaction.started',
        'compaction.failed',
        'run.failed',
      ]),
    )
    await registry.shutdown()
  })

  it('rejects invalid bindings and cursors before opening Pi state', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-invalid-'))
    roots.push(dataRoot)
    const bindingsRoot = join(dataRoot, 'state', 'session-bindings')
    await mkdir(bindingsRoot, { recursive: true })
    await writeFile(join(bindingsRoot, 'not-json.txt'), 'ignored')
    const malformedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await writeFile(join(bindingsRoot, `${malformedId}.json`), '{"version":2}')
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-invalid',
      cursorSecret: Buffer.alloc(32, 6),
      randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      createPiSession: async () => fakePiSession({}).handle as never,
    })
    await expect(
      registry.open({
        operationId,
        sessionId: malformedId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).rejects.toEqual(new RuntimeSessionError('session_not_found'))
    await rm(join(bindingsRoot, `${malformedId}.json`))
    await expect(
      registry.open({
        operationId: '22222222-2222-4222-8222-222222222222',
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).rejects.toEqual(new RuntimeSessionError('session_not_found'))
    expect(await registry.listBindings()).toEqual([])

    const noFile = fakePiSession({})
    const noFileRegistry = createSessionRegistry({
      dataRoot: join(dataRoot, 'no-file'),
      instanceId: 'instance-no-file',
      cursorSecret: Buffer.alloc(32, 7),
      randomUUID: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      createPiSession: async () => noFile.handle as never,
    })
    await expect(
      noFileRegistry.create({ operationId, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }),
    ).rejects.toEqual(new RuntimeSessionError('invalid_state'))
    await registry.shutdown()
    await noFileRegistry.shutdown()
  })

  it('rejects cursors signed for another instance, session, signature, or sequence', async () => {
    const { dataRoot, registry } = await harness()
    const first = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    const second = await registry.create({
      operationId: '22222222-2222-4222-8222-222222222222',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    for (const [sessionId, cursor] of [
      [second.sessionId, first.cursor],
      [first.sessionId, `${first.cursor}extra`],
      [first.sessionId, `${first.cursor}.extra`],
    ]) {
      await expect(
        registry.subscribe({
          sessionId,
          documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          afterCursor: cursor,
        }),
      ).resolves.toMatchObject({ resetRequired: true })
    }

    const body = Buffer.from(`instance-1\0${first.sessionId}\0-1`).toString('base64url')
    const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(body).digest('base64url')
    await expect(
      registry.subscribe({
        sessionId: first.sessionId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        afterCursor: `${body}.${signature}`,
      }),
    ).resolves.toMatchObject({ resetRequired: true })

    const reopened = createSessionRegistry({
      dataRoot,
      instanceId: 'other-instance',
      cursorSecret: Buffer.alloc(32, 7),
      randomUUID: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    })
    await expect(
      reopened.subscribe({
        sessionId: first.sessionId,
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        afterCursor: first.cursor,
      }),
    ).resolves.toMatchObject({ resetRequired: true })
    await registry.shutdown()
    await reopened.shutdown()
  })
})
