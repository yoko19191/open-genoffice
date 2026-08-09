import { createHmac } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { RuntimeSessionError, createSessionRegistry } from '../src'

const roots: string[] = []
const operationId = '11111111-1111-4111-8111-111111111111'
const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

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
  abort?: () => Promise<void>
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
      abort: async () => options.abort?.(),
      dispose,
    },
    emit: (event: AgentSessionEvent) => listener(event),
  }
}

describe('document-bound Pi Session registry', () => {
  it('cancels one registered execution tree, drops late events, and accepts the next prompt', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-abort-'))
    roots.push(dataRoot)
    let releasePrompt!: () => void
    let promptCount = 0
    const blocked = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const fake = fakePiSession({
      sessionFile: join(dataRoot, 'fake-session.jsonl'),
      prompt: async (emit) => {
        promptCount += 1
        emit({ type: 'agent_start' })
        if (promptCount === 1) {
          await blocked
          emit({
            type: 'message_update',
            message: {} as never,
            assistantMessageEvent: {
              type: 'text_delta',
              contentIndex: 0,
              delta: 'late',
              partial: {} as never,
            },
          })
        }
      },
      abort: async () => releasePrompt(),
    })
    let uuid = 0
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-abort',
      cursorSecret: Buffer.alloc(32, 10),
      cooperativeAbortMs: 100,
      forceAbortMs: 200,
      randomUUID: () => `${String(++uuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
      createPiSession: async () => fake.handle as never,
    })
    const created = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    const prompted = await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId: created.documentId,
      text: 'long run',
    })
    let releaseDescendant!: () => void
    const descendantBlocked = new Promise<void>((resolve) => {
      releaseDescendant = resolve
    })
    const descendantAbort = vi.fn(async () => descendantBlocked)
    registry.registerRunDescendant(created.sessionId, prompted.runId, {
      id: 'mcp-call',
      kind: 'mcp',
      abort: descendantAbort,
    })

    const abortInput = {
      operationId: '33333333-3333-4333-8333-333333333333',
      sessionId: created.sessionId,
      documentId: created.documentId,
      runId: prompted.runId,
    }
    const receipt = await registry.abort(abortInput)
    expect(receipt).toMatchObject({ runId: prompted.runId, state: 'cancelling' })
    await expect(registry.abort(abortInput)).resolves.toEqual(receipt)
    expect(
      (await registry.readJournal(created.sessionId)).some((event) => event.type === 'run.aborted'),
    ).toBe(false)
    releaseDescendant()
    await registry.waitForIdle(created.sessionId)

    const journal = await registry.readJournal(created.sessionId)
    expect(journal.filter((event) => event.type === 'run.cancelling')).toHaveLength(1)
    expect(journal.filter((event) => event.type === 'run.aborted')).toHaveLength(1)
    expect(journal.some((event) => event.type === 'message.delta')).toBe(false)
    expect(journal.at(-1)?.type).toBe('run.aborted')
    expect(descendantAbort).toHaveBeenCalledOnce()
    await expect(
      registry.abort({
        ...abortInput,
        operationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).resolves.toMatchObject({ state: 'already_terminal' })

    await registry.prompt({
      operationId: '55555555-5555-4555-8555-555555555555',
      sessionId: created.sessionId,
      documentId: created.documentId,
      text: 'next run',
    })
    await registry.waitForIdle(created.sessionId)
    expect((await registry.snapshot(created)).activeRun?.state).toBe('completed')
    await registry.shutdown()
  })

  it('fails abort closed when a document mutation outcome is unknown', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-abort-incomplete-'))
    roots.push(dataRoot)
    let releasePrompt!: () => void
    const blocked = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const fake = fakePiSession({
      sessionFile: join(dataRoot, 'fake-session.jsonl'),
      prompt: async () => blocked,
      abort: async () => releasePrompt(),
    })
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-abort-incomplete',
      cursorSecret: Buffer.alloc(32, 11),
      randomUUID: (() => {
        let id = 0
        return () => `${String(++id).padStart(8, '0')}-0000-4000-8000-000000000000`
      })(),
      createPiSession: async () => fake.handle as never,
    })
    const created = await registry.create({ operationId, documentId })
    const prompted = await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId,
      text: 'uncertain write',
    })
    registry.registerRunDescendant(created.sessionId, prompted.runId, {
      id: 'office-write',
      kind: 'office',
      mutation: true,
      abort: async () => ({ mutationOutcome: 'unknown' }),
    })
    await registry.abort({
      operationId: '33333333-3333-4333-8333-333333333333',
      sessionId: created.sessionId,
      documentId,
      runId: prompted.runId,
    })
    await registry.waitForIdle(created.sessionId)
    expect((await registry.readJournal(created.sessionId)).at(-1)).toMatchObject({
      type: 'run.failed',
      payload: {
        code: 'abort_incomplete',
        mutationOutcome: 'unknown',
        documentNeedsReview: true,
      },
    })
    await registry.shutdown()
  })

  it('reports an incomplete non-mutation abort without marking the document uncertain', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-abort-rejected-'))
    roots.push(dataRoot)
    let releasePrompt!: () => void
    const blocked = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const fake = fakePiSession({
      sessionFile: join(dataRoot, 'fake-session.jsonl'),
      prompt: async () => blocked,
      abort: async () => releasePrompt(),
    })
    let uuid = 0
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-abort-rejected',
      cursorSecret: Buffer.alloc(32, 37),
      randomUUID: () => `${String(++uuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
      createPiSession: async () => fake.handle as never,
    })
    const created = await registry.create({ operationId, documentId })
    const prompted = await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId,
      text: 'cancel a rejected read-only descendant',
    })
    registry.registerRunDescendant(created.sessionId, prompted.runId, {
      id: 'read-only-mcp',
      kind: 'mcp',
      abort: async () => {
        throw new Error('synthetic cancellation failure')
      },
    })
    await registry.abort({
      operationId: '33333333-3333-4333-8333-333333333333',
      sessionId: created.sessionId,
      documentId,
      runId: prompted.runId,
    })
    await registry.waitForIdle(created.sessionId)
    expect((await registry.readJournal(created.sessionId)).at(-1)).toMatchObject({
      type: 'run.failed',
      payload: {
        code: 'abort_incomplete',
        mutationOutcome: 'not_started',
        documentNeedsReview: false,
      },
    })
    await registry.shutdown()
  })

  it('rejects an unknown run and aborts an active execution tree during Runtime shutdown', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-shutdown-abort-'))
    roots.push(dataRoot)
    let releasePrompt!: () => void
    const blocked = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const abortPi = vi.fn(async () => releasePrompt())
    const fake = fakePiSession({
      sessionFile: join(dataRoot, 'fake-session.jsonl'),
      prompt: async () => blocked,
      abort: abortPi,
    })
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-shutdown-abort',
      cursorSecret: Buffer.alloc(32, 12),
      randomUUID: (() => {
        let id = 0
        return () => `${String(++id).padStart(8, '0')}-0000-4000-8000-000000000000`
      })(),
      createPiSession: async () => fake.handle as never,
    })
    const created = await registry.create({ operationId, documentId })
    expect(() =>
      registry.registerRunDescendant('ffffffff-ffff-4fff-8fff-ffffffffffff', 'missing-run', {
        id: 'missing-session',
        kind: 'mcp',
        abort: async () => {},
      }),
    ).toThrowError('session_not_found')
    await expect(
      registry.abort({
        operationId: '22222222-2222-4222-8222-222222222222',
        sessionId: created.sessionId,
        documentId,
        runId: 'missing-run',
      }),
    ).rejects.toEqual(new RuntimeSessionError('invalid_state'))
    const prompted = await registry.prompt({
      operationId: '33333333-3333-4333-8333-333333333333',
      sessionId: created.sessionId,
      documentId,
      text: 'shutdown while active',
    })
    expect(() =>
      registry.registerRunDescendant(created.sessionId, 'other-run', {
        id: 'late',
        kind: 'mcp',
        abort: async () => {},
      }),
    ).toThrowError('invalid_state')

    await registry.shutdown()
    expect(abortPi).toHaveBeenCalledOnce()
    expect((await registry.readJournal(created.sessionId)).at(-1)).toMatchObject({
      type: 'run.aborted',
      runId: prompted.runId,
    })
  })

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
    expect(binding.sessionFile).toContain(
      join('agent', 'sessions', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
    )
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

  it('returns session_in_use to a second Runtime and releases the writer lease on shutdown', async () => {
    const { dataRoot, registry } = await harness()
    const created = await registry.create({ operationId, documentId })
    const second = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-2',
      cursorSecret: Buffer.alloc(32, 8),
      now: () => new Date('2026-08-09T12:00:00.000Z'),
    })
    const openInput = {
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId,
    }

    await expect(second.open(openInput)).rejects.toEqual(new RuntimeSessionError('session_in_use'))
    await registry.shutdown()
    await expect(
      second.open({
        ...openInput,
        operationId: '33333333-3333-4333-8333-333333333333',
      }),
    ).resolves.toMatchObject({
      sessionId: created.sessionId,
      documentId,
    })
    await second.shutdown()
  })

  it('single-flights concurrent opens inside one Runtime while retaining one writer lease', async () => {
    const { dataRoot, registry } = await harness()
    const created = await registry.create({ operationId, documentId })
    const binding = (await registry.listBindings())[0]!
    await registry.shutdown()

    const fake = fakePiSession({ sessionFile: binding.sessionFile })
    const createPiSession = vi.fn(async () => {
      await Promise.resolve()
      return fake.handle as never
    })
    const reopened = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-concurrent',
      cursorSecret: Buffer.alloc(32, 9),
      createPiSession,
    })
    const bound = { sessionId: created.sessionId, documentId }
    await expect(
      Promise.all([
        reopened.open({
          ...bound,
          operationId: '22222222-2222-4222-8222-222222222222',
        }),
        reopened.snapshot(bound),
      ]),
    ).resolves.toHaveLength(2)
    expect(createPiSession).toHaveBeenCalledOnce()
    await reopened.shutdown()
  })

  it('heartbeats an owned Session before TTL so another Runtime cannot take it over', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-lease-heartbeat-'))
    roots.push(dataRoot)
    let currentTime = Date.parse('2026-08-09T12:00:00.000Z')
    const now = () => {
      const value = new Date(currentTime)
      currentTime += 300
      return value
    }
    let uuid = 0
    const first = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-heartbeat',
      cursorSecret: Buffer.alloc(32, 34),
      randomUUID: () => `${String(++uuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
      now,
      sessionLeaseTtlMs: 1_000,
      sessionLeaseHeartbeatMs: 250,
    })
    const created = await first.create({ operationId, documentId })
    const leasePath = join(dataRoot, 'state', 'leases', `session-${created.sessionId}.json`)
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ generation: 2 })
    })

    const second = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-heartbeat-contender',
      cursorSecret: Buffer.alloc(32, 35),
      now,
      sessionLeaseTtlMs: 1_000,
    })
    await expect(
      second.open({
        operationId: '22222222-2222-4222-8222-222222222222',
        sessionId: created.sessionId,
        documentId,
      }),
    ).rejects.toEqual(new RuntimeSessionError('session_in_use'))
    await second.shutdown()
    await first.shutdown()
  })

  it('takes over an expired lease and makes the old Runtime fail closed without deleting the new lease', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-lease-expiry-'))
    roots.push(dataRoot)
    let currentTime = Date.parse('2026-08-09T12:00:00.000Z')
    const now = () => new Date(currentTime)
    let uuid = 0
    const first = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-before-expiry',
      cursorSecret: Buffer.alloc(32, 31),
      randomUUID: () => `${String(++uuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
      now,
      sessionLeaseTtlMs: 1_000,
      sessionLeaseHeartbeatMs: 60_000,
    })
    const created = await first.create({ operationId, documentId })
    currentTime += 1_001

    const second = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-after-expiry',
      cursorSecret: Buffer.alloc(32, 32),
      now,
      sessionLeaseTtlMs: 1_000,
      sessionLeaseHeartbeatMs: 60_000,
    })
    await second.open({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId,
    })
    await expect(
      first.prompt({
        operationId: '33333333-3333-4333-8333-333333333333',
        sessionId: created.sessionId,
        documentId,
        text: 'must not write after takeover',
      }),
    ).rejects.toEqual(new RuntimeSessionError('session_lease_lost'))
    await expect(
      first.prompt({
        operationId: '44444444-4444-4444-8444-444444444444',
        sessionId: created.sessionId,
        documentId,
        text: 'must remain blocked after lease loss',
      }),
    ).rejects.toEqual(new RuntimeSessionError('session_lease_lost'))
    await first.shutdown()

    const third = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-third',
      cursorSecret: Buffer.alloc(32, 33),
      now,
    })
    await expect(
      third.open({
        operationId: '55555555-5555-4555-8555-555555555555',
        sessionId: created.sessionId,
        documentId,
      }),
    ).rejects.toEqual(new RuntimeSessionError('session_in_use'))
    await third.shutdown()
    await second.shutdown()
  })

  it('interrupts a crashed run once, marks an uncertain mutation, and accepts a new prompt', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-crash-recovery-'))
    roots.push(dataRoot)
    const sessionFile = join(dataRoot, 'fake-session.jsonl')
    const blocked = new Promise<void>(() => {})
    const crashedPi = fakePiSession({
      sessionFile,
      prompt: async (emit) => {
        emit({ type: 'agent_start' })
        await blocked
      },
    })
    let crashTime = Date.parse('2026-08-09T12:00:00.000Z')
    const crashNow = () => new Date(crashTime)
    let firstUuid = 0
    const first = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-before-crash',
      cursorSecret: Buffer.alloc(32, 21),
      randomUUID: () => `${String(++firstUuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
      createPiSession: async () => crashedPi.handle as never,
      now: crashNow,
      sessionLeaseTtlMs: 1_000,
      sessionLeaseHeartbeatMs: 60_000,
    })
    const created = await first.create({ operationId, documentId })
    const prompted = await first.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId,
      text: 'crash during an Office mutation',
    })
    await vi.waitFor(async () => {
      expect(
        (await first.readJournal(created.sessionId)).some((item) => item.type === 'run.started'),
      ).toBe(true)
    })
    const beforeCrash = await first.readJournal(created.sessionId)
    const journalPath = join(dataRoot, 'state', 'session-journals', `${created.sessionId}.jsonl`)
    for (const [offset, type] of ['tool.requested', 'tool.started'].entries()) {
      await appendFile(
        journalPath,
        `${JSON.stringify({
          protocolVersion: '1',
          kind: 'event',
          eventId: `crash-tool-${offset}`,
          instanceId: 'instance-before-crash',
          sessionId: created.sessionId,
          documentId,
          runId: prompted.runId,
          sequence: beforeCrash.length + offset + 1,
          cursor: `old-tool-cursor-${offset}`,
          occurredAt: '2026-08-09T12:00:01.000Z',
          type,
          payload: {
            toolCallId: 'office-write',
            toolName: 'office:docs:replace',
            effect: 'mutation',
          },
        })}\n`,
      )
    }
    crashTime += 1_001

    const recoveredPi = fakePiSession({ sessionFile, prompt: async () => {} })
    let secondUuid = 100
    const second = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-after-crash',
      cursorSecret: Buffer.alloc(32, 22),
      randomUUID: () => `${String(++secondUuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
      createPiSession: async () => recoveredPi.handle as never,
      now: crashNow,
      sessionLeaseTtlMs: 1_000,
      sessionLeaseHeartbeatMs: 60_000,
    })
    const reopened = await second.open({
      operationId: '33333333-3333-4333-8333-333333333333',
      sessionId: created.sessionId,
      documentId,
    })
    expect(reopened.snapshot.activeRun).toEqual({ runId: prompted.runId, state: 'interrupted' })
    expect(
      await second.subscribe({
        sessionId: created.sessionId,
        documentId,
        afterCursor: prompted.acceptedCursor,
      }),
    ).toMatchObject({ resetRequired: true, events: [] })
    const recoveredJournal = await second.readJournal(created.sessionId)
    expect(recoveredJournal.filter((item) => item.type === 'run.interrupted')).toHaveLength(1)
    expect(recoveredJournal.find((item) => item.type === 'tool.failed')).toMatchObject({
      runId: prompted.runId,
      payload: {
        toolCallId: 'office-write',
        mutationOutcome: 'unknown',
        code: 'mutation_outcome_unknown',
        documentNeedsReview: true,
      },
    })

    await second.prompt({
      operationId: '44444444-4444-4444-8444-444444444444',
      sessionId: created.sessionId,
      documentId,
      text: 'continue after reviewing the document',
    })
    await second.waitForIdle(created.sessionId)
    await second.shutdown()

    const third = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-third-start',
      cursorSecret: Buffer.alloc(32, 23),
      randomUUID: () => '99999999-9999-4999-8999-999999999999',
      createPiSession: async () => fakePiSession({ sessionFile }).handle as never,
    })
    await third.open({
      operationId: '55555555-5555-4555-8555-555555555555',
      sessionId: created.sessionId,
      documentId,
    })
    expect(
      (await third.readJournal(created.sessionId)).filter(
        (item) => item.type === 'run.interrupted',
      ),
    ).toHaveLength(1)
    await third.shutdown()
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
              stopReason: 'aborted',
            } as never,
          ],
          willRetry: false,
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
        'run.aborted',
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

  it.each(['factory', 'attach', 'append', 'binding'] as const)(
    'releases the lease and leaves no binding when Session creation fails during %s',
    async (failurePoint) => {
      const dataRoot = await mkdtemp(join(tmpdir(), `genoffice-session-create-${failurePoint}-`))
      roots.push(dataRoot)
      const createdSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      const bindingPath = join(dataRoot, 'state', 'session-bindings', `${createdSessionId}.json`)
      const journalPath = join(dataRoot, 'state', 'session-journals', `${createdSessionId}.jsonl`)
      if (failurePoint === 'attach') mkdirSync(journalPath, { recursive: true })
      if (failurePoint === 'binding') {
        mkdirSync(`${bindingPath}.${process.pid}.tmp`, { recursive: true })
      }
      const fake = fakePiSession({ sessionFile: join(dataRoot, 'fake-session.jsonl') })
      const dispose = vi.fn()
      fake.handle.dispose = dispose
      if (failurePoint === 'append') {
        fake.handle.subscribe = () => {
          mkdirSync(journalPath, { recursive: true })
          return () => {}
        }
      }
      const registry = createSessionRegistry({
        dataRoot,
        instanceId: `instance-create-${failurePoint}`,
        cursorSecret: Buffer.alloc(32, 36),
        randomUUID: () => createdSessionId,
        createPiSession: async () => {
          if (failurePoint === 'factory') throw new Error('synthetic Pi factory failure')
          return fake.handle as never
        },
      })
      const unsubscribe = registry.onEvent(() => {})

      await expect(registry.create({ operationId, documentId })).rejects.toThrow()
      expect(dispose).toHaveBeenCalledTimes(failurePoint === 'factory' ? 0 : 1)
      await expect(
        readFile(join(dataRoot, 'state', 'leases', `session-${createdSessionId}.json`), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(bindingPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      unsubscribe()
      await registry.shutdown()
    },
  )

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

  it('expires cursors outside the bounded replay window without reopening the run', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-session-replay-window-'))
    roots.push(dataRoot)
    let uuid = 0
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-replay',
      cursorSecret: Buffer.alloc(32, 9),
      replayWindowSize: 2,
      randomUUID: () => `${String(++uuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
    })
    const created = await registry.create({
      operationId,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    await registry.prompt({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId: created.documentId,
      text: 'advance beyond the replay window',
    })
    await registry.waitForIdle(created.sessionId)

    await expect(
      registry.subscribe({
        sessionId: created.sessionId,
        documentId: created.documentId,
        afterCursor: created.cursor,
      }),
    ).resolves.toMatchObject({ resetRequired: true, events: [] })
    const current = await registry.snapshot({
      sessionId: created.sessionId,
      documentId: created.documentId,
    })
    await expect(
      registry.subscribe({
        sessionId: created.sessionId,
        documentId: created.documentId,
        afterCursor: current.cursor,
      }),
    ).resolves.toMatchObject({ resetRequired: false, events: [] })
    expect(current.activeRun?.state).toBe('completed')
    await registry.shutdown()
  })
})
