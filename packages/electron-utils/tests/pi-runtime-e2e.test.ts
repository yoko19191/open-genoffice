import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { RUNTIME_VERSION, parseProtocolFrame } from '@genoffice/agent-runtime-protocol'
import { verifyPiRuntimeBundle, type VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import {
  applyAgentSessionEvent,
  createAgentSessionProjection,
  restoreAgentSessionProjection,
} from '@genoffice/ui/agent-session-projection'
import {
  AgentSessionBroker,
  SecureStorageBroker,
  createInstalledPiRuntimeService,
  createPiRuntimeManager,
  createPiRuntimeSupervisor,
} from '../src'

const execFileAsync = promisify(execFile)

function createFakeCredentialBroker(rootDirectory: string) {
  return SecureStorageBroker.create({
    rootDirectory,
    runtimeVersion: RUNTIME_VERSION,
    platform: process.platform,
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptStringAsync: async (value) => Buffer.from(`cipher:${value}`),
      decryptStringAsync: async (value) => ({
        result: value.toString().slice('cipher:'.length),
        shouldReEncrypt: false,
      }),
    },
  })
}

async function buildCopiedRuntime(root: string): Promise<VerifiedPiRuntimeBundle> {
  const notices = join(root, 'THIRD-PARTY-NOTICES.txt')
  const outputDirectory = join(root, 'bundle')
  await writeFile(notices, 'Runtime E2E fixture notices\n')
  const repoRoot = resolve(import.meta.dirname, '../../..')
  const windowsJobLauncher = process.env.GENOFFICE_WINDOWS_JOB_LAUNCHER
  if (process.platform === 'win32' && !windowsJobLauncher) {
    throw new Error('GENOFFICE_WINDOWS_JOB_LAUNCHER is required on Windows')
  }
  await execFileAsync(
    process.execPath,
    [
      'tools/build-pi-runtime-bundle.mjs',
      '--output',
      outputDirectory,
      '--node-executable',
      process.execPath,
      '--node-license',
      resolve(dirname(process.execPath), process.platform === 'win32' ? 'LICENSE' : '../LICENSE'),
      '--entry',
      resolve(repoRoot, 'apps/pi-agent-runtime/src/main.ts'),
      '--capability-smoke-entry',
      resolve(repoRoot, 'apps/pi-agent-runtime/fixtures/native-capability-smoke.ts'),
      '--capability-extension',
      resolve(repoRoot, 'apps/pi-agent-runtime/fixtures/native-smoke-extension.mjs'),
      '--mcp-smoke-server',
      resolve(repoRoot, 'apps/pi-agent-runtime/fixtures/mcp-stdio-server.mjs'),
      '--lockfile',
      resolve(repoRoot, 'package-lock.json'),
      '--notices',
      notices,
      '--platform',
      process.platform,
      '--arch',
      process.arch,
      ...(windowsJobLauncher
        ? [
            '--windows-job-launcher',
            windowsJobLauncher,
            '--windows-native-addon',
            resolve(
              repoRoot,
              'node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-console-mode.node',
            ),
          ]
        : []),
    ],
    { cwd: repoRoot },
  )
  return verifyPiRuntimeBundle(outputDirectory, {
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    arch: process.arch as 'arm64' | 'x64',
  })
}

describe('copied Pi Runtime end to end', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip

  windowsIt(
    'loads Pi ESM, a dynamic Extension, a native addon, and stdio MCP',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pi-runtime-capability-e2e-'))
      const verified = await buildCopiedRuntime(root)
      const launcher = verified.windowsJobLauncherPath
      if (!launcher) throw new Error('runtime_job_launcher_missing')
      const { stdout, stderr } = await execFileAsync(launcher, [
        '--owner-pid',
        String(process.pid),
        '--',
        verified.executablePath,
        verified.capabilitySmokeEntryPath,
      ])
      expect(stderr).toBe('')
      const capabilityResult = JSON.parse(stdout)
      expect(capabilityResult).toMatchObject({
        status: 'passed',
        piEsm: true,
        extension: 'native_smoke_extension',
        nativeAddon: 'win32-console-mode.node',
        mcp: { tool: 'native_smoke_echo', result: 'mcp:windows-native' },
      })
      const capabilityOutput = process.env.GENOFFICE_WINDOWS_CAPABILITY_OUTPUT
      if (capabilityOutput) {
        await mkdir(dirname(capabilityOutput), { recursive: true })
        await writeFile(capabilityOutput, `${JSON.stringify(capabilityResult, null, 2)}\n`)
      }
      await rm(root, { recursive: true, force: true })
    },
    15_000,
  )

  it('verifies, spawns, authenticates, queries, and shuts down without residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-e2e-'))
    const verified = await buildCopiedRuntime(root)
    const resourceHome = join(root, 'resource-home')
    const credentialBroker = await createFakeCredentialBroker(resourceHome)
    const diagnostics: string[] = []
    const manager = createPiRuntimeManager({
      bundle: verified,
      platform: process.platform,
      parentPid: process.pid,
      resourceHome,
      startupTimeoutMs: 5_000,
      diagnostic: (code) => diagnostics.push(code),
      credentialBroker,
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
      resourceHome,
      credentialBroker,
    })
    await expect(service.initialize()).resolves.toMatchObject({ state: 'ready' })
    await service.shutdown()
    expect(service.health()).toMatchObject({ state: 'stopped' })

    const nativeRuntimeOutput = process.env.GENOFFICE_WINDOWS_RUNTIME_OUTPUT
    if (process.platform === 'win32' && nativeRuntimeOutput) {
      await mkdir(dirname(nativeRuntimeOutput), { recursive: true })
      await writeFile(
        nativeRuntimeOutput,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            platform: verified.manifest.platform,
            arch: verified.manifest.arch,
            manifestSha256: verified.manifestSha256,
            treeSha256: verified.manifest.treeSha256,
            nodeVersion: verified.manifest.nodeVersion,
            piVersion: verified.manifest.piVersion,
            protocolVersion: verified.manifest.protocolVersion,
            namedPipe: {
              hello: true,
              status: true,
              session: true,
              shutdown: true,
            },
            exit: { runtimeGone: true },
          },
          null,
          2,
        )}\n`,
      )
    }

    await rm(root, { recursive: true, force: true })
  }, 15_000)

  it('restarts after a forced process crash and interrupts the persisted run without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-crash-e2e-'))
    const runtimeDirectoriesBefore = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith('open-genoffice-runtime-')),
    )
    const verified = await buildCopiedRuntime(root)
    const resourceHome = join(root, 'resource-home')
    const credentialBroker = await createFakeCredentialBroker(resourceHome)
    const supervisor = createPiRuntimeSupervisor({
      bundle: verified,
      platform: process.platform,
      parentPid: process.pid,
      resourceHome,
      startupTimeoutMs: 5_000,
      credentialBroker,
    })
    const coldStartedAt = Date.now()
    const firstHealth = await supervisor.start()
    expect(Date.now() - coldStartedAt).toBeLessThan(5_000)

    const documentId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
    const created = await supervisor.createSession({ operationId: randomUUID(), documentId })
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const unsubscribe = supervisor.onSessionEvent((event) => {
      if (event.sessionId === created.sessionId && event.type === 'run.started') resolveStarted()
    })
    const prompted = await supervisor.promptSession({
      operationId: randomUUID(),
      sessionId: created.sessionId,
      documentId,
      text: 'force a process crash during the active model response',
    })
    await started

    const restartStartedAt = Date.now()
    process.kill(firstHealth.pid, 'SIGKILL')
    await vi.waitFor(() => expect(supervisor.state).not.toBe('ready'))
    const secondHealth = await supervisor.waitUntilReady()
    expect(Date.now() - restartStartedAt).toBeLessThan(8_000)
    expect(secondHealth.instanceId).not.toBe(firstHealth.instanceId)
    expect(secondHealth.pid).not.toBe(firstHealth.pid)
    expect(() => process.kill(firstHealth.pid, 0)).toThrow()

    const reopened = await supervisor.openSession({
      operationId: randomUUID(),
      sessionId: created.sessionId,
      documentId,
    })
    expect(reopened.snapshot.activeRun).toEqual({ runId: prompted.runId, state: 'interrupted' })
    await expect(
      supervisor.subscribeSession({
        sessionId: created.sessionId,
        documentId,
        afterCursor: prompted.acceptedCursor,
      }),
    ).resolves.toMatchObject({ resetRequired: true, events: [] })

    const journalPath = join(
      resourceHome,
      'state',
      'session-journals',
      `${created.sessionId}.jsonl`,
    )
    const recoveredJournal = (await readFile(journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map(parseProtocolFrame)
    expect(
      recoveredJournal.filter(
        (event) =>
          event.kind === 'event' &&
          event.runId === prompted.runId &&
          event.type === 'run.interrupted',
      ),
    ).toHaveLength(1)
    expect(
      recoveredJournal.some(
        (event) =>
          event.kind === 'event' &&
          event.runId === prompted.runId &&
          event.type === 'run.completed',
      ),
    ).toBe(false)

    let resolveNextStarted!: () => void
    let resolveAborted!: () => void
    const nextStarted = new Promise<void>((resolve) => {
      resolveNextStarted = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve
    })
    const unsubscribeNextRun = supervisor.onSessionEvent((event) => {
      if (event.sessionId !== created.sessionId) return
      if (event.type === 'run.started') resolveNextStarted()
      if (event.type === 'run.aborted') resolveAborted()
    })
    const nextPrompt = await supervisor.promptSession({
      operationId: randomUUID(),
      sessionId: created.sessionId,
      documentId,
      text: 'continue only after the interrupted run is visible',
    })
    await nextStarted
    await expect(
      supervisor.abortSession({
        operationId: randomUUID(),
        sessionId: created.sessionId,
        documentId,
        runId: nextPrompt.runId,
      }),
    ).resolves.toMatchObject({ state: 'cancelling' })
    await aborted
    unsubscribeNextRun()
    unsubscribe()
    await supervisor.shutdown()

    const runtimeDirectoriesAfter = (await readdir(tmpdir())).filter((name) =>
      name.startsWith('open-genoffice-runtime-'),
    )
    expect(runtimeDirectoriesAfter.filter((name) => !runtimeDirectoriesBefore.has(name))).toEqual(
      [],
    )
    await rm(root, { recursive: true, force: true })
  }, 30_000)

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
  }, 15_000)
})
