import { describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
} from '@genoffice/agent-runtime-protocol'
import type { VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import { PiRuntimeService, type PiRuntimeManagerOptions } from '../src'

const verified = {
  kind: 'verified-pi-runtime-bundle',
  root: '/resources/pi-runtime',
  executablePath: '/resources/pi-runtime/node/open-genoffice-pi-agent-runtime',
  entryPath: '/resources/pi-runtime/app/main.mjs',
  manifest: { runtimeVersion: RUNTIME_VERSION },
  manifestSha256: 'a'.repeat(64),
} as unknown as VerifiedPiRuntimeBundle

function manager(overrides: Record<string, unknown> = {}) {
  const snapshot = {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    messages: [],
    lastSequence: 0,
    cursor: 'cursor-1',
  }
  return {
    state: 'stopped',
    start: vi.fn(async () => ({
      state: 'ready' as const,
      pid: 42,
      instanceId: 'private-instance',
      runtimeVersion: RUNTIME_VERSION,
    })),
    status: vi.fn(async () => ({ pid: 42, instanceId: 'private-instance' })),
    shutdown: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({
      sessionId: snapshot.sessionId,
      documentId: snapshot.documentId,
      snapshot,
      cursor: snapshot.cursor,
    })),
    openSession: vi.fn(async () => ({
      sessionId: snapshot.sessionId,
      documentId: snapshot.documentId,
      snapshot,
      cursor: snapshot.cursor,
    })),
    promptSession: vi.fn(async () => ({ runId: 'run-1', acceptedCursor: 'cursor-1' })),
    abortSession: vi.fn(async () => ({
      runId: 'run-1',
      state: 'cancelling' as const,
      acceptedCursor: 'cursor-2',
    })),
    resumeSubagent: vi.fn(async () => ({
      runId: 'subagent-run-1',
      attempt: 2,
      acceptedCursor: 'cursor-2',
    })),
    issueMutationGrant: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      documentId: input.documentId,
      grant: {
        requestId: input.requestId,
        subagentRunId: input.receipt.subagentRunId,
        role: 'Reviewer',
        exactToolIds: input.receipt.exactToolIds,
        requestedAt: input.receipt.issuedAt,
        expiresAt: input.receipt.expiresAt,
        status: 'active' as const,
        grantId: input.receipt.grantId,
      },
      acceptedCursor: 'cursor-2',
    })),
    denyMutationGrant: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      documentId: input.documentId,
      grant: {
        requestId: input.requestId,
        subagentRunId: 'subagent-run-1',
        role: 'Reviewer',
        exactToolIds: ['office:docs:insert_content'],
        requestedAt: '2026-08-10T00:00:00.000Z',
        expiresAt: '2026-08-10T00:05:00.000Z',
        status: 'denied' as const,
      },
      acceptedCursor: 'cursor-2',
    })),
    revokeMutationGrant: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      documentId: input.documentId,
      grant: {
        requestId: 'grant-request-1',
        subagentRunId: 'subagent-run-1',
        role: 'Reviewer',
        exactToolIds: ['office:docs:insert_content'],
        requestedAt: '2026-08-10T00:00:00.000Z',
        expiresAt: '2026-08-10T00:05:00.000Z',
        status: 'revoked' as const,
        grantId: input.grantId,
      },
      acceptedCursor: 'cursor-2',
    })),
    revokeDocumentMutationGrants: vi.fn(async () => ({ revoked: true as const })),
    answerUserAction: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      documentId: input.documentId,
      action: {
        requestId: input.requestId,
        runId: 'run-1',
        mode: 'confirm' as const,
        question: 'Continue?',
        requestedAt: '2026-08-11T00:00:00.000Z',
        status: 'answered' as const,
      },
      acceptedCursor: 'cursor-1',
    })),
    forkSession: vi.fn(async () => ({
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      parentSessionId: snapshot.sessionId,
      documentId: snapshot.documentId,
      snapshot: {
        ...snapshot,
        sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        branch: { parentSessionId: snapshot.sessionId, nodes: [] },
      },
      cursor: snapshot.cursor,
    })),
    navigateSession: vi.fn(async () => ({
      sessionId: snapshot.sessionId,
      documentId: snapshot.documentId,
      activeLeafId: 'navigation-leaf',
      snapshot: { ...snapshot, branch: { activeLeafId: 'navigation-leaf', nodes: [] } },
      cursor: snapshot.cursor,
    })),
    snapshotSession: vi.fn(async () => snapshot),
    subscribeSession: vi.fn(async () => ({ resetRequired: false, snapshot, events: [] })),
    onSessionEvent: vi.fn(() => () => {}),
    putCredential: vi.fn(async (input) => ({
      providerId: input.providerId,
      persistence: input.persistence,
      status: 'available' as const,
      kind: 'api_key' as const,
    })),
    credentialStatus: vi.fn(async (input) => ({
      providerId: input.providerId,
      persistence: 'persistent' as const,
      status: 'missing' as const,
    })),
    deleteCredential: vi.fn(async (input) => ({
      providerId: input.providerId,
      persistence: 'persistent' as const,
      status: 'missing' as const,
    })),
    modelCatalog: vi.fn(async () => ({ providers: [], selections: {} })),
    selectModel: vi.fn(async (input) => ({
      providers: [],
      selections: {
        [input.role]: {
          providerId: input.providerId,
          modelId: input.modelId,
          capabilities: ['text-input' as const],
        },
      },
    })),
    configureModelProvider: vi.fn(async () => ({ providers: [], selections: {} })),
    startModelOAuth: vi.fn(async (input) => ({
      operationId: input.operationId,
      providerId: input.providerId,
      state: 'running' as const,
    })),
    modelOAuthStatus: vi.fn(async (input) => ({
      operationId: input.operationId,
      providerId: 'openai-codex',
      state: 'running' as const,
    })),
    respondModelOAuth: vi.fn(async (input) => ({
      operationId: input.operationId,
      providerId: 'openai-codex',
      state: 'running' as const,
    })),
    cancelModelOAuth: vi.fn(async (input) => ({
      operationId: input.operationId,
      providerId: 'openai-codex',
      state: 'cancelled' as const,
    })),
    logoutModel: vi.fn(async () => ({ providers: [], selections: {} })),
    resourceCatalog: vi.fn(async (input = {}) => ({
      catalogId: 'a'.repeat(64),
      projectState: input.projectRoot ? ('untrusted' as const) : ('none' as const),
      resources: [],
    })),
    grantProjectTrust: vi.fn(async () => ({
      catalogId: 'a'.repeat(64),
      projectState: 'trusted' as const,
      resources: [],
    })),
    revokeProjectTrust: vi.fn(async () => ({
      catalogId: 'a'.repeat(64),
      projectState: 'untrusted' as const,
      resources: [],
    })),
    packageCatalog: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    installLocalPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    installNpmPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    installGitPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    activatePackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    enablePackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    disablePackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    uninstallPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    mcpCatalog: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    activateMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    enableMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    disableMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    retryMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    startMcpOAuth: vi.fn(async (input) => ({
      operationId: input.operationId,
      authorizationUrl: 'https://issuer.example.test/authorize?state=safe-state',
      expiresAt: 123_456,
    })),
    completeMcpOAuth: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    cancelMcpOAuth: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    enableMcpTool: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    disableMcpTool: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
    ...overrides,
  }
}

function service(options: {
  verify?: () => Promise<VerifiedPiRuntimeBundle>
  runtimeManager?: ReturnType<typeof manager>
  resourceHome?: string
  beforeStart?: () => Promise<void>
  credentialBroker?: PiRuntimeManagerOptions['credentialBroker']
  officeToolHost?: PiRuntimeManagerOptions['officeToolHost']
}) {
  const runtimeManager = options.runtimeManager ?? manager()
  const createManager = vi.fn(() => runtimeManager)
  return {
    runtimeManager,
    createManager,
    instance: new PiRuntimeService(
      {
        bundleRoot: '/resources/pi-runtime',
        platform: 'darwin',
        arch: 'arm64',
        parentPid: 123,
        ...(options.resourceHome ? { resourceHome: options.resourceHome } : {}),
        ...(options.beforeStart ? { beforeStart: options.beforeStart } : {}),
        ...(options.credentialBroker ? { credentialBroker: options.credentialBroker } : {}),
        ...(options.officeToolHost ? { officeToolHost: options.officeToolHost } : {}),
      },
      {
        verifyBundle: options.verify ?? (async () => verified),
        createManager,
      },
    ),
  }
}

describe('installed Pi Runtime service', () => {
  it('verifies once, starts once, and exposes only a frozen typed health projection', async () => {
    const fixture = service({})
    const first = fixture.instance.initialize()
    const second = fixture.instance.initialize()
    expect(first).toBe(second)
    await expect(first).resolves.toEqual({
      state: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(fixture.createManager).toHaveBeenCalledWith({
      bundle: verified,
      platform: 'darwin',
      parentPid: 123,
    })
    expect(fixture.runtimeManager.start).toHaveBeenCalledOnce()
    expect(fixture.instance.health()).not.toHaveProperty('pid')
    expect(Object.isFrozen(fixture.instance.health())).toBe(true)
  })

  it('fails closed when the installed bundle is absent or Runtime startup fails', async () => {
    const missing = service({
      verify: async () => {
        throw new Error('/private/bundle/path')
      },
    })
    await expect(missing.instance.initialize()).resolves.toMatchObject({
      state: 'unavailable',
      diagnosticCode: 'runtime_bundle_unavailable',
    })
    expect(missing.createManager).not.toHaveBeenCalled()

    const failedManager = manager({
      start: vi.fn(async () => {
        throw new Error('private token and endpoint')
      }),
    })
    const failed = service({ runtimeManager: failedManager })
    await expect(failed.instance.initialize()).resolves.toMatchObject({
      state: 'crashed',
      diagnosticCode: 'runtime_start_failed',
    })
    expect(JSON.stringify(failed.instance.health())).not.toContain('private')
  })

  it('runs the reviewed pre-start migration only after bundle verification and before Runtime spawn', async () => {
    const lifecycle: string[] = []
    const beforeStart = vi.fn(async () => {
      lifecycle.push('migration')
    })
    const runtimeManager = manager({
      start: vi.fn(async () => {
        lifecycle.push('runtime')
        return {
          state: 'ready' as const,
          pid: 42,
          instanceId: 'private-instance',
          runtimeVersion: RUNTIME_VERSION,
        }
      }),
    })
    const fixture = service({
      verify: async () => {
        lifecycle.push('verify')
        return verified
      },
      beforeStart,
      runtimeManager,
    })

    await expect(fixture.instance.initialize()).resolves.toMatchObject({ state: 'ready' })
    expect(lifecycle).toEqual(['verify', 'migration', 'runtime'])
    expect(beforeStart).toHaveBeenCalledOnce()

    const invalidBundleHook = vi.fn(async () => undefined)
    const invalid = service({
      verify: async () => {
        throw new Error('invalid bundle')
      },
      beforeStart: invalidBundleHook,
    })
    await expect(invalid.instance.initialize()).resolves.toMatchObject({ state: 'unavailable' })
    expect(invalidBundleHook).not.toHaveBeenCalled()

    const rejected = service({
      beforeStart: async () => {
        throw new Error('private migration detail')
      },
    })
    await expect(rejected.instance.initialize()).resolves.toMatchObject({
      state: 'crashed',
      diagnosticCode: 'runtime_start_failed',
    })
    expect(rejected.createManager).not.toHaveBeenCalled()
    expect(JSON.stringify(rejected.instance.health())).not.toContain('private')
  })

  it('owns the narrow Session client and refuses commands when Runtime is unavailable', async () => {
    const fixture = service({})
    await fixture.instance.createSession({
      operationId: '11111111-1111-4111-8111-111111111111',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    expect(fixture.runtimeManager.createSession).toHaveBeenCalledOnce()
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
    await fixture.instance.openSession({
      operationId: '22222222-2222-4222-8222-222222222222',
      ...bound,
    })
    await fixture.instance.promptSession({
      operationId: '33333333-3333-4333-8333-333333333333',
      ...bound,
      text: 'hello',
    })
    await fixture.instance.abortSession({
      operationId: '44444444-4444-4444-8444-444444444444',
      ...bound,
      runId: 'run-1',
    })
    await fixture.instance.resumeSubagent({
      sessionId: 'session-1',
      documentId: 'document-1',
      operationId: 'operation-resume',
      runId: 'subagent-run-1',
    })
    const grantReceipt = {
      grantId: 'grant-1',
      subagentRunId: 'subagent-run-1',
      documentId: bound.documentId,
      exactToolIds: ['office:docs:insert_content'],
      issuedByUserActionId: 'user-action-1',
      issuedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'active' as const,
    }
    await fixture.instance.issueMutationGrant({
      operationId: 'operation-grant',
      ...bound,
      requestId: 'grant-request-1',
      receipt: grantReceipt,
    })
    await fixture.instance.denyMutationGrant({
      operationId: 'operation-deny',
      ...bound,
      requestId: 'grant-request-1',
      userActionId: 'user-action-2',
    })
    await fixture.instance.revokeMutationGrant({
      operationId: 'operation-revoke',
      ...bound,
      grantId: 'grant-1',
      userActionId: 'user-action-3',
    })
    await fixture.instance.revokeDocumentMutationGrants({
      operationId: 'operation-close',
      ...bound,
    })
    await fixture.instance.answerUserAction({
      operationId: 'operation-answer',
      ...bound,
      requestId: 'question-1',
      userActionId: 'user-action-4',
      answer: { confirmed: true },
    })
    await fixture.instance.forkSession({
      operationId: '55555555-5555-4555-8555-555555555555',
      ...bound,
    })
    await fixture.instance.navigateSession({
      operationId: '66666666-6666-4666-8666-666666666666',
      ...bound,
      targetEntryId: 'target-leaf',
    })
    await fixture.instance.snapshotSession(bound)
    await fixture.instance.subscribeSession({ ...bound, afterCursor: 'cursor-1' })
    expect(fixture.runtimeManager.openSession).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.promptSession).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.abortSession).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.resumeSubagent).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.issueMutationGrant).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.denyMutationGrant).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.revokeMutationGrant).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.revokeDocumentMutationGrants).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.answerUserAction).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.forkSession).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.navigateSession).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.snapshotSession).toHaveBeenCalledOnce()
    expect(fixture.runtimeManager.subscribeSession).toHaveBeenCalledOnce()
    const listener = vi.fn()
    await expect(fixture.instance.onSessionEvent(listener)).resolves.toEqual(expect.any(Function))
    expect(fixture.runtimeManager.onSessionEvent).toHaveBeenCalledWith(listener)

    const missing = service({
      verify: async () => {
        throw new Error('missing')
      },
    })
    await expect(
      missing.instance.createSession({
        operationId: '11111111-1111-4111-8111-111111111111',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).rejects.toThrowError('runtime_unavailable')
  })

  it('passes an explicit Resource Home only to the owned Runtime manager', async () => {
    const fixture = service({ resourceHome: '/private/resource-home' })
    await fixture.instance.initialize()
    expect(fixture.createManager).toHaveBeenCalledWith({
      bundle: verified,
      platform: 'darwin',
      parentPid: 123,
      resourceHome: '/private/resource-home',
    })
  })

  it('forwards only typed credential management commands to the ready Runtime', async () => {
    const fixture = service({})
    const secretPayload = '{"type":"api_key","key":"service-management-canary"}'
    await expect(
      fixture.instance.putCredential({
        providerId: 'openai',
        persistence: 'persistent',
        secretPayload,
      }),
    ).resolves.toMatchObject({ status: 'available', kind: 'api_key' })
    await expect(
      fixture.instance.credentialStatus({ providerId: 'openai' }),
    ).resolves.toMatchObject({ status: 'missing' })
    await expect(
      fixture.instance.deleteCredential({ providerId: 'openai' }),
    ).resolves.toMatchObject({ status: 'missing' })
    expect(fixture.runtimeManager.putCredential).toHaveBeenCalledWith({
      providerId: 'openai',
      persistence: 'persistent',
      secretPayload,
    })
  })

  it('forwards typed model catalog, selection, OAuth control, and logout commands', async () => {
    const fixture = service({})
    const operationId = '55555555-5555-4555-8555-555555555555'
    await expect(fixture.instance.modelCatalog()).resolves.toEqual({
      providers: [],
      selections: {},
    })
    await fixture.instance.selectModel({
      role: 'conversation',
      providerId: 'openai',
      modelId: 'gpt-5.4',
    })
    const localProvider = {
      providerId: 'local-openai',
      name: 'Local OpenAI',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [
        {
          modelId: 'qwen-test',
          name: 'Qwen Test',
          capabilities: ['text-input', 'tool-use'] as ('text-input' | 'tool-use')[],
        },
      ],
    }
    await fixture.instance.configureModelProvider(localProvider)
    await fixture.instance.startModelOAuth({ operationId, providerId: 'openai-codex' })
    await fixture.instance.modelOAuthStatus({ operationId })
    await fixture.instance.respondModelOAuth({ operationId, value: 'write-only-response' })
    await fixture.instance.cancelModelOAuth({ operationId })
    await fixture.instance.logoutModel({ providerId: 'openai-codex' })
    expect(fixture.runtimeManager.selectModel).toHaveBeenCalledWith({
      role: 'conversation',
      providerId: 'openai',
      modelId: 'gpt-5.4',
    })
    expect(fixture.runtimeManager.configureModelProvider).toHaveBeenCalledWith(localProvider)
    expect(fixture.runtimeManager.respondModelOAuth).toHaveBeenCalledWith({
      operationId,
      value: 'write-only-response',
    })
    expect(fixture.runtimeManager.logoutModel).toHaveBeenCalledWith({
      providerId: 'openai-codex',
    })
  })

  it('keeps resource paths in the main-process service while forwarding trust controls', async () => {
    const fixture = service({})
    const projectRoot = '/selected/project'
    const trust = {
      operationId: '55555555-5555-4555-8555-555555555555',
      projectRoot,
    }
    await expect(fixture.instance.resourceCatalog({ projectRoot })).resolves.toMatchObject({
      projectState: 'untrusted',
    })
    await expect(fixture.instance.grantProjectTrust(trust)).resolves.toMatchObject({
      projectState: 'trusted',
    })
    await expect(fixture.instance.revokeProjectTrust(trust)).resolves.toMatchObject({
      projectState: 'untrusted',
    })
    expect(fixture.runtimeManager.resourceCatalog).toHaveBeenCalledWith({ projectRoot })
    expect(fixture.runtimeManager.grantProjectTrust).toHaveBeenCalledWith(trust)
    expect(fixture.runtimeManager.revokeProjectTrust).toHaveBeenCalledWith(trust)

    const mutation = {
      namespace: 'global' as const,
      operationId: trust.operationId,
      packageId: 'safe-extension',
    }
    await fixture.instance.packageCatalog({ namespace: 'global' })
    await fixture.instance.installLocalPackage({ ...mutation, localPath: '/main/selected/package' })
    await fixture.instance.installNpmPackage({
      ...mutation,
      name: 'safe-extension',
      version: '1.2.3',
    })
    await fixture.instance.installGitPackage({
      ...mutation,
      url: 'https://example.com/safe-extension.git',
      commit: 'a'.repeat(40),
    })
    await fixture.instance.activatePackage(mutation)
    await fixture.instance.enablePackage(mutation)
    await fixture.instance.disablePackage(mutation)
    await fixture.instance.uninstallPackage(mutation)
    expect(fixture.runtimeManager.installLocalPackage).toHaveBeenCalledWith({
      ...mutation,
      localPath: '/main/selected/package',
    })
    expect(fixture.runtimeManager.uninstallPackage).toHaveBeenCalledWith(mutation)

    const mcpMutation = {
      namespace: 'global' as const,
      operationId: trust.operationId,
      serverId: 'fixture',
    }
    await fixture.instance.mcpCatalog()
    await fixture.instance.activateMcp(mcpMutation)
    await fixture.instance.enableMcp(mcpMutation)
    await fixture.instance.disableMcp(mcpMutation)
    await fixture.instance.retryMcp(mcpMutation)
    await fixture.instance.startMcpOAuth({
      ...mcpMutation,
      redirectUrl: `http://127.0.0.1:53682/mcp/oauth/callback/${mcpMutation.operationId}`,
    })
    await fixture.instance.completeMcpOAuth({
      ...mcpMutation,
      callbackUrl: `http://127.0.0.1:53682/mcp/oauth/callback/${mcpMutation.operationId}?code=x&state=y&iss=https%3A%2F%2Fissuer.example.test`,
    })
    await fixture.instance.cancelMcpOAuth(mcpMutation)
    await fixture.instance.enableMcpTool({ ...mcpMutation, toolName: 'read_fixture' })
    await fixture.instance.disableMcpTool({ ...mcpMutation, toolName: 'read_fixture' })
    expect(fixture.runtimeManager.mcpCatalog).toHaveBeenCalledWith({})
    expect(fixture.runtimeManager.disableMcpTool).toHaveBeenCalledWith({
      ...mcpMutation,
      toolName: 'read_fixture',
    })
    expect(fixture.runtimeManager.cancelMcpOAuth).toHaveBeenCalledWith(mcpMutation)
  })

  it('passes the main-process credential broker only to the owned Runtime manager', async () => {
    const credentialBroker = {
      put: vi.fn(),
      rotate: vi.fn(),
      get: vi.fn(),
      status: vi.fn(),
      delete: vi.fn(),
    } as unknown as NonNullable<PiRuntimeManagerOptions['credentialBroker']>
    const fixture = service({ credentialBroker })
    await fixture.instance.initialize()
    expect(fixture.createManager).toHaveBeenCalledWith({
      bundle: verified,
      platform: 'darwin',
      parentPid: 123,
      credentialBroker,
    })
  })

  it('passes the main-process Office Tool host only to the owned Runtime manager', async () => {
    const officeToolHost = { invoke: vi.fn() }
    const fixture = service({ officeToolHost })
    await fixture.instance.initialize()
    expect(fixture.createManager).toHaveBeenCalledWith({
      bundle: verified,
      platform: 'darwin',
      parentPid: 123,
      officeToolHost,
    })
  })

  it('shuts down the owned manager after initialization and remains stopped', async () => {
    const fixture = service({})
    await fixture.instance.initialize()
    await fixture.instance.shutdown()
    expect(fixture.runtimeManager.shutdown).toHaveBeenCalledOnce()
    expect(fixture.instance.health()).toMatchObject({ state: 'stopped' })
    await fixture.instance.shutdown()
    expect(fixture.runtimeManager.shutdown).toHaveBeenCalledOnce()

    const neverStarted = service({})
    await neverStarted.instance.shutdown()
    expect(neverStarted.instance.health()).toMatchObject({ state: 'stopped' })

    const failingManager = manager({
      shutdown: vi.fn(async () => {
        throw new Error('private shutdown detail')
      }),
    })
    const failing = service({ runtimeManager: failingManager })
    await failing.instance.initialize()
    await failing.instance.shutdown()
    expect(failing.instance.health()).toMatchObject({
      state: 'crashed',
      diagnosticCode: 'runtime_shutdown_failed',
    })
  })

  it('waits for in-flight verification before shutting down during app exit', async () => {
    let resolveVerification!: (bundle: VerifiedPiRuntimeBundle) => void
    const fixture = service({
      verify: () =>
        new Promise<VerifiedPiRuntimeBundle>((resolve) => {
          resolveVerification = resolve
        }),
    })
    void fixture.instance.initialize()
    const shutdown = fixture.instance.shutdown()
    expect(fixture.runtimeManager.shutdown).not.toHaveBeenCalled()
    resolveVerification(verified)
    await shutdown
    expect(fixture.runtimeManager.shutdown).toHaveBeenCalledOnce()
    expect(fixture.instance.health()).toMatchObject({ state: 'stopped' })
  })
})
