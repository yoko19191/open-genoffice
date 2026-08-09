import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseProtocolFrame } from '@genoffice/agent-runtime-protocol'
import { verifyPiRuntimeBundle, type VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import {
  applyAgentSessionEvent,
  createAgentSessionProjection,
  restoreAgentSessionProjection,
} from '@genoffice/ui/agent-session-projection'
import { AgentSessionBroker, createInstalledPiRuntimeService, createPiRuntimeManager } from '../src'

const execFileAsync = promisify(execFile)

async function buildCopiedRuntime(root: string): Promise<VerifiedPiRuntimeBundle> {
  const notices = join(root, 'THIRD-PARTY-NOTICES.txt')
  const outputDirectory = join(root, 'bundle')
  await writeFile(notices, 'Runtime E2E fixture notices\n')
  const repoRoot = resolve(import.meta.dirname, '../../..')
  await execFileAsync(
    process.execPath,
    [
      'tools/build-pi-runtime-bundle.mjs',
      '--output',
      outputDirectory,
      '--node-executable',
      process.execPath,
      '--node-license',
      resolve(dirname(process.execPath), '../LICENSE'),
      '--entry',
      resolve(repoRoot, 'apps/pi-agent-runtime/src/main.ts'),
      '--lockfile',
      resolve(repoRoot, 'package-lock.json'),
      '--notices',
      notices,
      '--platform',
      process.platform,
      '--arch',
      process.arch,
    ],
    { cwd: repoRoot },
  )
  return verifyPiRuntimeBundle(outputDirectory, {
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    arch: process.arch as 'arm64' | 'x64',
  })
}

describe('copied Pi Runtime end to end', () => {
  it('verifies, spawns, authenticates, queries, and shuts down without residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-e2e-'))
    const verified = await buildCopiedRuntime(root)
    const resourceHome = join(root, 'resource-home')
    const diagnostics: string[] = []
    const manager = createPiRuntimeManager({
      bundle: verified,
      platform: process.platform,
      parentPid: process.pid,
      resourceHome,
      startupTimeoutMs: 5_000,
      diagnostic: (code) => diagnostics.push(code),
    })

    const health = await manager.start()
    expect(health.pid).toBeGreaterThan(0)
    await expect(manager.status()).resolves.toEqual(health)
    const events: Parameters<typeof applyAgentSessionEvent>[1][] = []
    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve
    })
    const unsubscribe = manager.onSessionEvent((event) => {
      events.push(event)
      if (event.type === 'run.completed') resolveTerminal()
    })
    const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const created = await manager.createSession({
      operationId: '11111111-1111-4111-8111-111111111111',
      documentId,
    })
    await manager.promptSession({
      operationId: '22222222-2222-4222-8222-222222222222',
      sessionId: created.sessionId,
      documentId,
      text: 'project the native Pi stream through Electron main',
    })
    await terminal
    unsubscribe()
    const visible = events
      .filter((event) => event.sequence > created.snapshot.lastSequence)
      .reduce(applyAgentSessionEvent, createAgentSessionProjection(created.snapshot))
    expect(visible.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ])
    expect(visible.messages.map((message) => message.text)).toEqual([
      'project the native Pi stream through Electron main',
      'contract ready',
      'contract probe acknowledged',
    ])
    expect(visible.tools).toEqual([
      {
        toolCallId: 'contract-tool-call',
        toolName: 'genoffice_contract_probe',
        state: 'completed',
      },
    ])
    expect(visible.activeRun?.state).toBe('completed')
    expect(visible.compaction).toMatchObject({ state: 'completed' })
    expect(visible.branch).toMatchObject({ state: 'created' })
    expect(events.at(-1)?.type).toBe('run.completed')

    const journal = (
      await readFile(
        join(resourceHome, 'state', 'session-journals', `${created.sessionId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map(parseProtocolFrame)
    expect(events.map((event) => event.eventId)).toEqual(
      journal.map((event) => (event.kind === 'event' ? event.eventId : 'not-event')),
    )
    const transcript = await readFile(
      join(resourceHome, 'agent', 'sessions', documentId, `${created.sessionId}.jsonl`),
      'utf8',
    )
    expect(transcript).toContain('genoffice.document-binding')
    expect(transcript).not.toContain('run.started')

    const abortDocumentId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
    const abortCreated = await manager.createSession({
      operationId: randomUUID(),
      documentId: abortDocumentId,
    })
    const abortedEvents: Parameters<typeof applyAgentSessionEvent>[1][] = []
    let resolveAborted!: () => void
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve
    })
    const unsubscribeAborted = manager.onSessionEvent((event) => {
      if (event.sessionId !== abortCreated.sessionId) return
      abortedEvents.push(event)
      if (event.type === 'run.aborted') resolveAborted()
    })
    const abortPrompt = await manager.promptSession({
      operationId: randomUUID(),
      sessionId: abortCreated.sessionId,
      documentId: abortDocumentId,
      text: 'abort this deliberately long model response',
    })
    const abortOperationId = randomUUID()
    const abortStartedAt = Date.now()
    const abortReceipt = await manager.abortSession({
      operationId: abortOperationId,
      sessionId: abortCreated.sessionId,
      documentId: abortDocumentId,
      runId: abortPrompt.runId,
    })
    expect(Date.now() - abortStartedAt).toBeLessThan(2_000)
    expect(abortReceipt).toMatchObject({ runId: abortPrompt.runId, state: 'cancelling' })
    await expect(
      manager.abortSession({
        operationId: abortOperationId,
        sessionId: abortCreated.sessionId,
        documentId: abortDocumentId,
        runId: abortPrompt.runId,
      }),
    ).resolves.toEqual(abortReceipt)
    await aborted
    expect(abortedEvents.filter((event) => event.type === 'run.aborted')).toHaveLength(1)
    expect(
      (
        await manager.snapshotSession({
          sessionId: abortCreated.sessionId,
          documentId: abortDocumentId,
        })
      ).activeRun?.state,
    ).toBe('aborted')

    let resolveAfterAbort!: () => void
    const afterAbort = new Promise<void>((resolve) => {
      resolveAfterAbort = resolve
    })
    const unsubscribeAfterAbort = manager.onSessionEvent((event) => {
      if (event.sessionId === abortCreated.sessionId && event.type === 'run.completed') {
        resolveAfterAbort()
      }
    })
    await manager.promptSession({
      operationId: randomUUID(),
      sessionId: abortCreated.sessionId,
      documentId: abortDocumentId,
      text: 'continue after abort',
    })
    await afterAbort
    unsubscribeAfterAbort()
    unsubscribeAborted()

    const reloadDocumentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
    const reloadEvents: Parameters<typeof applyAgentSessionEvent>[1][] = []
    const broker = new AgentSessionBroker(manager, {
      authorize: () => true,
      randomUUID,
    })
    let reconnected = await broker.connect(500, { documentId: reloadDocumentId }, (event) =>
      reloadEvents.push(event),
    )
    let resolveReloadTerminal!: () => void
    const reloadTerminal = new Promise<void>((resolve) => {
      resolveReloadTerminal = resolve
    })
    const unsubscribeReloadTerminal = manager.onSessionEvent((event) => {
      if (event.sessionId === reconnected.sessionId && event.type === 'run.completed') {
        resolveReloadTerminal()
      }
    })
    await broker.command(500, {
      type: 'prompt',
      operationId: randomUUID(),
      sessionId: reconnected.sessionId,
      documentId: reloadDocumentId,
      text: 'survive renderer reload',
    })
    let observedActiveDuringReload = false
    for (let reload = 0; reload < 50; reload += 1) {
      broker.disconnect(500)
      reconnected = await broker.connect(
        500,
        {
          documentId: reloadDocumentId,
          sessionId: reconnected.sessionId,
          afterCursor: reconnected.snapshot.cursor,
        },
        (event) => reloadEvents.push(event),
      )
      observedActiveDuringReload ||=
        reconnected.snapshot.activeRun?.state === 'queued' ||
        reconnected.snapshot.activeRun?.state === 'running'
    }
    expect(observedActiveDuringReload).toBe(true)
    await reloadTerminal
    unsubscribeReloadTerminal()
    broker.disconnect(500)
    reconnected = await broker.connect(
      500,
      {
        documentId: reloadDocumentId,
        sessionId: reconnected.sessionId,
        afterCursor: reconnected.snapshot.cursor,
      },
      (event) => reloadEvents.push(event),
    )
    expect(restoreAgentSessionProjection(reconnected).activeRun?.state).toBe('completed')
    expect(new Set(reloadEvents.map((event) => event.eventId)).size).toBe(reloadEvents.length)
    const reloadJournal = (
      await readFile(
        join(resourceHome, 'state', 'session-journals', `${reconnected.sessionId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map(parseProtocolFrame)
    expect(
      reloadJournal.filter((event) => event.kind === 'event' && event.type === 'run.completed'),
    ).toHaveLength(1)
    await broker.close()
    await manager.shutdown()
    expect(manager.state).toBe('stopped')
    expect(diagnostics).toEqual([])
    expect(() => process.kill(health.pid, 0)).toThrow()

    const service = createInstalledPiRuntimeService({
      bundleRoot: verified.root,
      platform: process.platform,
      arch: process.arch as 'arm64' | 'x64',
      parentPid: process.pid,
      startupTimeoutMs: 5_000,
    })
    await expect(service.initialize()).resolves.toMatchObject({ state: 'ready' })
    await service.shutdown()
    expect(service.health()).toMatchObject({ state: 'stopped' })

    await rm(root, { recursive: true, force: true })
  }, 15_000)

  it('runs debug stdio with a disposable HOME, fake credentials, and blocked network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-debug-e2e-'))
    const verified = await buildCopiedRuntime(root)
    const home = join(root, 'home')
    const temporaryDirectory = join(root, 'tmp')
    const legacyHome = join(home, '.open-genoffice')
    const canary = join(home, 'real-home-canary')
    const networkBlocker = join(root, 'block-network.cjs')
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(temporaryDirectory, { recursive: true }),
    ])
    await Promise.all([
      writeFile(canary, 'must remain unread and unchanged\n'),
      writeFile(
        networkBlocker,
        [
          "const net = require('node:net')",
          "const http = require('node:http')",
          "const https = require('node:https')",
          "const fail = () => { throw new Error('network_forbidden') }",
          'net.connect = fail',
          'net.createConnection = fail',
          'http.request = fail',
          'http.get = fail',
          'https.request = fail',
          'https.get = fail',
          'globalThis.fetch = fail',
          "require('node:module').syncBuiltinESMExports()",
        ].join('\n'),
      ),
    ])

    const { stdout, stderr } = await execFileAsync(
      verified.executablePath,
      ['--require', networkBlocker, verified.entryPath, '--debug-stdio'],
      {
        env: {
          HOME: home,
          USERPROFILE: home,
          TMPDIR: temporaryDirectory,
          TMP: temporaryDirectory,
          TEMP: temporaryDirectory,
          CI: 'true',
        },
      },
    )
    const frames = stdout.trim().split('\n').map(parseProtocolFrame)
    expect(frames).toHaveLength(9)
    expect(frames[0]).toMatchObject({ kind: 'event', type: 'session.opened' })
    expect(frames.at(-1)).toMatchObject({ kind: 'event', type: 'run.completed' })
    expect(stderr).toBe('')
    expect(await readFile(canary, 'utf8')).toBe('must remain unread and unchanged\n')
    await expect(access(legacyHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(temporaryDirectory)).toEqual([])

    await rm(root, { recursive: true, force: true })
  })
})
