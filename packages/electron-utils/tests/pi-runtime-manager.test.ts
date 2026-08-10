import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  type BootstrapRecord,
  type RuntimeBundleManifest,
} from '@genoffice/agent-runtime-protocol'
import type { VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import {
  PiRuntimeManager,
  PiRuntimeManagerError,
  createPrivateRuntimeEndpoint,
  type PiRuntimeChild,
  type PiRuntimeManagerDependencies,
} from '../src'

function verifiedBundle(): VerifiedPiRuntimeBundle {
  const manifest = {
    runtimeName: RUNTIME_NAME,
    runtimeVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  } as RuntimeBundleManifest
  return Object.freeze({
    kind: 'verified-pi-runtime-bundle',
    root: '/installed/pi-agent-runtime',
    executablePath: '/installed/pi-agent-runtime/node/open-genoffice-pi-agent-runtime',
    entryPath: '/installed/pi-agent-runtime/app/main.mjs',
    capabilitySmokeEntryPath: '/installed/pi-agent-runtime/self-test/native-capability-smoke.mjs',
    windowsJobLauncherPath: '/installed/pi-agent-runtime/node/open-genoffice-job-launcher.exe',
    manifest,
    manifestSha256: 'f'.repeat(64),
  })
}

class FakeRuntimeSocket extends Duplex {
  readonly hostResponses: unknown[] = []
  constructor(
    private readonly bootstrap: () => BootstrapRecord,
    private readonly child: FakeRuntimeChild,
    private readonly options: ManagerHarnessOptions,
  ) {
    super()
  }

  _read() {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const request = JSON.parse(chunk.toString('utf8').trim())
    if (request.kind === 'response') {
      this.hostResponses.push(request)
      callback()
      return
    }
    const instanceId = 'runtime-instance-1'
    const runtimePid = this.options.helloPid ?? 8128
    if (this.options.prelude && request.method === 'runtime.hello') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'request',
          id: 'runtime-prelude',
          method: 'runtime.status',
          correlationId: 'runtime-prelude-correlation',
          params: {},
        })}\n`,
      )
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: 'unknown-response',
          correlationId: 'unknown-response-correlation',
          result: {},
        })}\n`,
      )
    }
    if (this.options.credentialPrelude && request.method === 'runtime.hello') {
      for (const credentialRequest of this.options.credentialPrelude) {
        this.push(`${JSON.stringify(credentialRequest)}\n`)
      }
    }
    if (this.options.officePrelude && request.method === 'runtime.hello') {
      for (const officeRequest of this.options.officePrelude) {
        this.push(`${JSON.stringify(officeRequest)}\n`)
      }
    }
    if (this.options.mediaPrelude && request.method === 'runtime.hello') {
      for (const mediaRequest of this.options.mediaPrelude) {
        this.push(`${JSON.stringify(mediaRequest)}\n`)
      }
    }
    if (request.method === 'runtime.status' && this.options.statusMode === 'hang') {
      callback()
      return
    }
    if (request.method === 'runtime.status' && this.options.statusMode === 'protocol-error') {
      this.push('{invalid}\n')
      callback()
      return
    }
    const snapshot = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      messages: [],
      lastSequence: 1,
      cursor: 'cursor-1',
    }
    const defaultResult =
      request.method === 'runtime.hello'
        ? {
            pid: runtimePid,
            instanceId,
            capabilities: [
              'runtime.status',
              'runtime.shutdown',
              'session.create',
              'session.open',
              'session.prompt',
              'session.abort',
              'session.subagent.resume',
              'session.mutation-grant.issue',
              'session.mutation-grant.deny',
              'session.mutation-grant.revoke',
              'session.mutation-grant.revoke-document',
              'session.user-action.answer',
              'session.fork',
              'session.navigate',
              'session.snapshot',
              'session.subscribe',
              'credential.put',
              'credential.status',
              'credential.delete',
              'model.catalog',
              'model.select',
              'model.provider.configure',
              'model.oauth.start',
              'model.oauth.status',
              'model.oauth.respond',
              'model.oauth.cancel',
              'model.logout',
              'resource.catalog',
              'project.trust.grant',
              'project.trust.revoke',
              'package.catalog',
              'package.install.local',
              'package.install.npm',
              'package.install.git',
              'package.activate',
              'package.enable',
              'package.disable',
              'package.uninstall',
              'mcp.catalog',
              'mcp.activate',
              'mcp.enable',
              'mcp.disable',
              'mcp.retry',
              'mcp.oauth.start',
              'mcp.oauth.complete',
              'mcp.oauth.cancel',
              'mcp.tool.enable',
              'mcp.tool.disable',
            ],
          }
        : request.method === 'runtime.status'
          ? { pid: runtimePid, instanceId, runtimeVersion: RUNTIME_VERSION }
          : request.method.startsWith('model.oauth.')
            ? {
                operationId: request.params.operationId,
                providerId: 'openai-codex',
                state: 'running',
              }
            : request.method === 'resource.catalog' || request.method.startsWith('project.trust.')
              ? {
                  catalogId: 'a'.repeat(64),
                  projectState:
                    request.method === 'project.trust.grant'
                      ? 'trusted'
                      : request.method === 'project.trust.revoke'
                        ? 'untrusted'
                        : request.params.projectRoot
                          ? 'untrusted'
                          : 'none',
                  resources: [],
                }
              : request.method.startsWith('package.')
                ? { globalGeneration: 1, packages: [] }
                : request.method === 'mcp.oauth.start'
                  ? {
                      operationId: request.params.operationId,
                      authorizationUrl: 'https://issuer.example.test/authorize?state=safe-state',
                      expiresAt: 123_456,
                    }
                  : request.method.startsWith('mcp.')
                    ? { projectState: 'none', servers: [] }
                    : request.method.startsWith('model.')
                      ? {
                          providers: [],
                          selections:
                            request.method === 'model.select'
                              ? {
                                  [request.params.role]: {
                                    providerId: request.params.providerId,
                                    modelId: request.params.modelId,
                                    capabilities: ['text-input'],
                                  },
                                }
                              : {},
                        }
                      : request.method === 'credential.put'
                        ? {
                            providerId: request.params.providerId,
                            persistence: request.params.persistence,
                            status: 'available',
                            kind: 'api_key',
                          }
                        : request.method === 'credential.status'
                          ? {
                              providerId: request.params.providerId,
                              persistence: 'persistent',
                              status: 'missing',
                            }
                          : request.method === 'credential.delete'
                            ? {
                                providerId: request.params.providerId,
                                persistence: 'persistent',
                                status: 'missing',
                              }
                            : request.method === 'session.create' ||
                                request.method === 'session.open'
                              ? {
                                  sessionId: snapshot.sessionId,
                                  documentId: snapshot.documentId,
                                  snapshot,
                                  cursor: snapshot.cursor,
                                }
                              : request.method === 'session.prompt'
                                ? { runId: 'run-1', acceptedCursor: 'cursor-1' }
                                : request.method === 'session.abort'
                                  ? {
                                      runId: 'run-1',
                                      state: 'cancelling',
                                      acceptedCursor: 'cursor-2',
                                    }
                                  : request.method === 'session.subagent.resume'
                                    ? {
                                        runId: 'subagent-run-1',
                                        attempt: 2,
                                        acceptedCursor: 'cursor-3',
                                      }
                                    : request.method === 'session.mutation-grant.issue'
                                      ? {
                                          sessionId: request.params.sessionId,
                                          documentId: request.params.documentId,
                                          grant: {
                                            requestId: request.params.requestId,
                                            subagentRunId: request.params.receipt.subagentRunId,
                                            role: 'Reviewer',
                                            exactToolIds: request.params.receipt.exactToolIds,
                                            requestedAt: request.params.receipt.issuedAt,
                                            expiresAt: request.params.receipt.expiresAt,
                                            status: 'active',
                                            grantId: request.params.receipt.grantId,
                                          },
                                          acceptedCursor: 'cursor-4',
                                        }
                                      : request.method === 'session.mutation-grant.deny'
                                        ? {
                                            sessionId: request.params.sessionId,
                                            documentId: request.params.documentId,
                                            grant: {
                                              requestId: request.params.requestId,
                                              subagentRunId: 'subagent-run-1',
                                              role: 'Reviewer',
                                              exactToolIds: ['office:docs:insert_content'],
                                              requestedAt: '2026-08-10T00:00:00.000Z',
                                              expiresAt: '2026-08-10T00:05:00.000Z',
                                              status: 'denied',
                                            },
                                            acceptedCursor: 'cursor-4',
                                          }
                                        : request.method === 'session.mutation-grant.revoke'
                                          ? {
                                              sessionId: request.params.sessionId,
                                              documentId: request.params.documentId,
                                              grant: {
                                                requestId: 'grant-request-1',
                                                subagentRunId: 'subagent-run-1',
                                                role: 'Reviewer',
                                                exactToolIds: ['office:docs:insert_content'],
                                                requestedAt: '2026-08-10T00:00:00.000Z',
                                                expiresAt: '2026-08-10T00:05:00.000Z',
                                                status: 'revoked',
                                                grantId: request.params.grantId,
                                              },
                                              acceptedCursor: 'cursor-4',
                                            }
                                          : request.method ===
                                              'session.mutation-grant.revoke-document'
                                            ? { revoked: true }
                                            : request.method === 'session.user-action.answer'
                                              ? {
                                                  sessionId: request.params.sessionId,
                                                  documentId: request.params.documentId,
                                                  action: {
                                                    requestId: request.params.requestId,
                                                    runId: 'run-1',
                                                    mode: 'confirm',
                                                    question: 'Continue?',
                                                    requestedAt: '2026-08-11T00:00:00.000Z',
                                                    status: 'answered',
                                                  },
                                                  acceptedCursor: 'cursor-5',
                                                }
                                              : request.method === 'session.fork'
                                                ? {
                                                    sessionId:
                                                      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                                                    parentSessionId: snapshot.sessionId,
                                                    documentId: snapshot.documentId,
                                                    snapshot: {
                                                      ...snapshot,
                                                      sessionId:
                                                        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                                                      branch: {
                                                        parentSessionId: snapshot.sessionId,
                                                        nodes: [],
                                                      },
                                                    },
                                                    cursor: snapshot.cursor,
                                                  }
                                                : request.method === 'session.navigate'
                                                  ? {
                                                      sessionId: snapshot.sessionId,
                                                      documentId: snapshot.documentId,
                                                      activeLeafId: 'navigation-leaf',
                                                      snapshot: {
                                                        ...snapshot,
                                                        branch: {
                                                          activeLeafId: 'navigation-leaf',
                                                          nodes: [],
                                                        },
                                                      },
                                                      cursor: snapshot.cursor,
                                                    }
                                                  : request.method === 'session.snapshot'
                                                    ? snapshot
                                                    : request.method === 'session.subscribe'
                                                      ? {
                                                          resetRequired: false,
                                                          snapshot,
                                                          events: [],
                                                        }
                                                      : { shuttingDown: true }
    const result =
      request.method === 'runtime.hello' && 'helloResult' in this.options
        ? this.options.helloResult
        : request.method === 'runtime.status' && 'statusResult' in this.options
          ? this.options.statusResult
          : request.method.startsWith('model.') && 'modelResult' in this.options
            ? this.options.modelResult
            : (request.method === 'resource.catalog' ||
                  request.method.startsWith('project.trust.')) &&
                'resourceResult' in this.options
              ? this.options.resourceResult
              : request.method.startsWith('package.') && 'packageResult' in this.options
                ? this.options.packageResult
                : request.method.startsWith('mcp.') && 'mcpResult' in this.options
                  ? this.options.mcpResult
                  : request.method.startsWith('credential.') && 'credentialResult' in this.options
                    ? this.options.credentialResult
                    : request.method.startsWith('session.') && 'sessionResult' in this.options
                      ? this.options.sessionResult
                      : defaultResult
    if (request.method === 'runtime.status' && this.options.statusMode === 'error-response') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'unavailable',
            message: 'unavailable',
            retryable: true,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    if (request.method.startsWith('session.') && this.options.sessionMode === 'error-response') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'unavailable',
            message: 'unavailable',
            retryable: true,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    if (request.method.startsWith('model.') && this.options.modelMode === 'error-response') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'model_not_found',
            message: 'model_not_found',
            retryable: false,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    if (
      (request.method === 'resource.catalog' || request.method.startsWith('project.trust.')) &&
      this.options.resourceMode === 'error-response'
    ) {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'invalid_request',
            message: 'invalid_request',
            retryable: false,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    if (request.method.startsWith('package.') && this.options.packageMode === 'error-response') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'package_source_invalid',
            message: 'package_source_invalid',
            retryable: false,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    if (request.method.startsWith('mcp.') && this.options.mcpMode === 'error-response') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'mcp_unavailable',
            message: 'mcp_unavailable',
            retryable: false,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    if (
      request.method.startsWith('credential.') &&
      this.options.credentialMode === 'error-response'
    ) {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'secure_storage_unavailable',
            message: 'secure_storage_unavailable',
            retryable: false,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    this.push(
      `${JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'response',
        id: request.id,
        correlationId: request.correlationId,
        result,
      })}\n`,
    )
    if (request.method === 'runtime.shutdown') {
      queueMicrotask(() => {
        this.push(null)
        this.child.emit('exit', 0, null)
      })
    }
    callback()
  }
}

type ManagerHarnessOptions = {
  helloPid?: number
  helloResult?: unknown
  statusResult?: unknown
  statusMode?: 'hang' | 'protocol-error' | 'error-response'
  prelude?: boolean
  endpointFailure?: boolean
  childError?: boolean
  sessionResult?: unknown
  sessionMode?: 'error-response'
  credentialResult?: unknown
  credentialMode?: 'error-response'
  credentialPrelude?: readonly unknown[]
  officePrelude?: readonly unknown[]
  mediaPrelude?: readonly unknown[]
  modelResult?: unknown
  modelMode?: 'error-response'
  resourceResult?: unknown
  resourceMode?: 'error-response'
  packageResult?: unknown
  packageMode?: 'error-response'
  mcpResult?: unknown
  mcpMode?: 'error-response'
}

class FakeRuntimeChild extends EventEmitter implements PiRuntimeChild {
  readonly pid = 8128
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly writes: string[] = []
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(chunk.toString('utf8'))
      callback()
    },
  })
  readonly kill = vi.fn(() => {
    this.emit('exit', null, 'SIGTERM')
    return true
  })
}

function managerHarness(options: ManagerHarnessOptions = {}) {
  const child = new FakeRuntimeChild()
  const cleanup = vi.fn(async () => {})
  const spawn = vi.fn(() => child)
  let parsedBootstrap: BootstrapRecord | undefined
  let socket: FakeRuntimeSocket | undefined
  const dependencies: PiRuntimeManagerDependencies = {
    spawn,
    createEndpoint: vi.fn(async () => {
      if (options.endpointFailure) throw new Error('private endpoint detail')
      return {
        endpoint: '/private/runtime.sock',
        cleanup,
      }
    }),
    connect: vi.fn(async () => {
      parsedBootstrap = JSON.parse(child.writes[0]!)
      if (options.childError) {
        queueMicrotask(() => child.emit('error', new Error('private spawn detail')))
        return new Promise<FakeRuntimeSocket>(() => {})
      }
      socket = new FakeRuntimeSocket(() => parsedBootstrap!, child, options)
      return socket
    }),
    randomBytes: vi.fn(() => Buffer.alloc(32, 0xab)),
    randomUUID: vi.fn(() => 'abababab-abab-4bab-8bab-abababababab'),
  }
  return {
    child,
    cleanup,
    dependencies,
    spawn,
    bootstrap: () => parsedBootstrap!,
    socket: () => socket!,
  }
}

describe('PiRuntimeManager', () => {
  it('dispatches only Runtime-initiated credential methods to the main-process broker', async () => {
    const secretPayload = '{"type":"api_key","key":"manager-secret-canary"}'
    const credentialPrelude = [
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'credential-status-1',
        method: 'credential.status',
        correlationId: 'credential-status-correlation-1',
        params: { slot: 'model/openai/default' },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'credential-put-1',
        method: 'credential.put',
        correlationId: 'credential-put-correlation-1',
        params: {
          slot: 'model/openai/default',
          providerId: 'openai',
          kind: 'api_key',
          expectedGeneration: 0,
          secretPayload,
        },
      },
    ]
    const harness = managerHarness({ credentialPrelude })
    const metadata = {
      credentialId: '11111111-1111-4111-8111-111111111111',
      slot: 'model/openai/default',
      providerId: 'openai',
      kind: 'api_key' as const,
      generation: 1,
      status: 'available' as const,
    }
    const credentialBroker = {
      status: vi.fn(async () => ({ slot: metadata.slot, status: 'missing' as const })),
      put: vi.fn(async () => metadata),
      get: vi.fn(),
      rotate: vi.fn(),
      delete: vi.fn(),
    }
    const manager = new PiRuntimeManager(
      {
        bundle: verifiedBundle(),
        platform: 'darwin',
        parentPid: 7070,
        credentialBroker,
      },
      harness.dependencies,
    )

    await manager.start()
    await vi.waitFor(() => expect(harness.socket().hostResponses).toHaveLength(2))
    expect(credentialBroker.status).toHaveBeenCalledWith('model/openai/default')
    expect(credentialBroker.put).toHaveBeenCalledWith(credentialPrelude[1]!.params)
    expect(JSON.stringify(harness.socket().hostResponses)).not.toContain(secretPayload)
    expect(harness.socket().hostResponses).toEqual([
      expect.objectContaining({
        id: 'credential-status-1',
        result: { slot: 'model/openai/default', status: 'missing' },
      }),
      expect.objectContaining({ id: 'credential-put-1', result: metadata }),
    ])
    await manager.shutdown()
  })

  it('dispatches one validated Runtime Office Tool request to the main-process host', async () => {
    const invocation = {
      operationId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      documentId: '33333333-3333-4333-8333-333333333333',
      runId: 'run-1',
      toolCallId: 'tool-call-1',
      toolId: 'office:pdf:read_pages',
      toolOrder: 0,
      actor: {
        type: 'parent',
        actorId: '22222222-2222-4222-8222-222222222222',
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
      permissionSnapshot: {
        snapshotId: 'snapshot-1',
        createdForRunId: 'run-1',
        permissionVersion: 'permission-1',
        toolIds: ['office:pdf:read_pages'],
      },
      input: { start: 1 },
    }
    const officePrelude = [
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'office-tool-request-1',
        method: 'office.tool.invoke',
        correlationId: 'office-tool-correlation-1',
        params: invocation,
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'office-tool-abort-1',
        method: 'office.tool.abort',
        correlationId: 'office-tool-abort-correlation-1',
        params: { operationId: invocation.operationId, documentId: invocation.documentId },
      },
    ]
    const officeToolHost = {
      invoke: vi.fn(async () => ({
        operationId: invocation.operationId,
        toolCallId: invocation.toolCallId,
        toolId: invocation.toolId,
        status: 'completed' as const,
        output: '[Page 1]\nhello',
        provenance: {
          actorId: invocation.actor.actorId,
          runId: invocation.runId,
          documentId: invocation.documentId,
        },
      })),
      abort: vi.fn(async () => true),
    }
    const harness = managerHarness({ officePrelude })
    const manager = new PiRuntimeManager(
      {
        bundle: verifiedBundle(),
        platform: 'darwin',
        parentPid: 7070,
        officeToolHost,
      },
      harness.dependencies,
    )

    await manager.start()
    await vi.waitFor(() => expect(harness.socket().hostResponses).toHaveLength(2))
    expect(officeToolHost.invoke).toHaveBeenCalledWith(invocation)
    expect(officeToolHost.abort).toHaveBeenCalledWith({
      operationId: invocation.operationId,
      documentId: invocation.documentId,
    })
    expect(harness.socket().hostResponses[0]).toMatchObject({
      id: 'office-tool-request-1',
      correlationId: 'office-tool-correlation-1',
      result: expect.objectContaining({ toolId: invocation.toolId, status: 'completed' }),
    })
    expect(harness.socket().hostResponses[1]).toMatchObject({
      id: 'office-tool-abort-1',
      result: { aborted: true },
    })
    await manager.shutdown()
  })

  it('dispatches validated media prepare and Stop requests to the main-process host', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const documentId = '22222222-2222-4222-8222-222222222222'
    const artifact = {
      artifactId: '33333333-3333-4333-8333-333333333333',
      mediaType: 'video/mp4' as const,
      byteLength: 24,
      sha256: 'a'.repeat(64),
    }
    const params = { operationId, documentId, runId: 'run-1', artifact, strategy: 'frames' }
    const mediaPrelude = [
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'media-prepare-1',
        method: 'media.prepare',
        correlationId: 'media-prepare-correlation-1',
        params,
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'media-abort-1',
        method: 'media.prepare.abort',
        correlationId: 'media-abort-correlation-1',
        params: { operationId, documentId },
      },
    ]
    const mediaPreparationHost = {
      prepare: vi.fn(async () => ({
        operationId,
        inputKind: 'video' as const,
        strategy: 'frames' as const,
        durationMs: 2_000,
        artifacts: [{ ...artifact, mediaType: 'image/png' as const }],
        timestampsMs: [500],
      })),
      abort: vi.fn(async () => true),
    }
    const harness = managerHarness({ mediaPrelude })
    const manager = new PiRuntimeManager(
      {
        bundle: verifiedBundle(),
        platform: 'darwin',
        parentPid: 7070,
        mediaPreparationHost,
      },
      harness.dependencies,
    )

    await manager.start()
    await vi.waitFor(() => expect(harness.socket().hostResponses).toHaveLength(2))
    expect(mediaPreparationHost.prepare).toHaveBeenCalledWith(params, expect.any(AbortSignal))
    expect(mediaPreparationHost.abort).toHaveBeenCalledWith({ operationId, documentId })
    expect(harness.socket().hostResponses).toEqual([
      expect.objectContaining({
        id: 'media-prepare-1',
        result: expect.objectContaining({ strategy: 'frames' }),
      }),
      expect.objectContaining({ id: 'media-abort-1', result: { aborted: true } }),
    ])
    await manager.shutdown()
  })

  it('fails closed when the media preparation host is unavailable', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const documentId = '22222222-2222-4222-8222-222222222222'
    const mediaPrelude = [
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'media-prepare-missing',
        method: 'media.prepare',
        correlationId: 'media-prepare-missing-correlation',
        params: {
          operationId,
          documentId,
          runId: 'run-1',
          artifact: {
            artifactId: '33333333-3333-4333-8333-333333333333',
            mediaType: 'video/mp4',
            byteLength: 24,
            sha256: 'a'.repeat(64),
          },
          strategy: 'native',
        },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'media-abort-missing',
        method: 'media.prepare.abort',
        correlationId: 'media-abort-missing-correlation',
        params: { operationId, documentId },
      },
    ]
    const harness = managerHarness({ mediaPrelude })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )

    await manager.start()
    await vi.waitFor(() => expect(harness.socket().hostResponses).toHaveLength(2))
    expect(harness.socket().hostResponses).toEqual([
      expect.objectContaining({
        id: 'media-prepare-missing',
        error: expect.objectContaining({ code: 'executor_unavailable' }),
      }),
      expect.objectContaining({
        id: 'media-abort-missing',
        error: expect.objectContaining({ code: 'executor_unavailable' }),
      }),
    ])
    await manager.shutdown()
  })

  it('starts only the verified executable, authenticates, serves health, and shuts down', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )

    const firstStart = manager.start()
    const secondStart = manager.start()
    await expect(firstStart).resolves.toMatchObject({
      state: 'ready',
      pid: 8128,
      instanceId: 'runtime-instance-1',
      runtimeVersion: RUNTIME_VERSION,
    })
    await expect(secondStart).resolves.toEqual(await firstStart)
    await expect(manager.start()).resolves.toEqual(await firstStart)
    expect(harness.spawn).toHaveBeenCalledTimes(1)
    expect(harness.spawn).toHaveBeenCalledWith(
      '/installed/pi-agent-runtime/node/open-genoffice-pi-agent-runtime',
      ['/installed/pi-agent-runtime/app/main.mjs'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      },
    )
    expect(harness.bootstrap()).toMatchObject({
      kind: 'bootstrap',
      parentPid: 7070,
      endpoint: '/private/runtime.sock',
      token: 'ab'.repeat(32),
    })
    expect(JSON.stringify(harness.spawn.mock.calls)).not.toContain('ab'.repeat(32))
    await expect(manager.status()).resolves.toMatchObject({ state: 'ready', pid: 8128 })
    await expect(manager.shutdown()).resolves.toBeUndefined()
    await expect(manager.shutdown()).resolves.toBeUndefined()
    expect(manager.state).toBe('stopped')
    expect(harness.cleanup).toHaveBeenCalledOnce()
  })

  it('uses narrow typed Session methods and forwards validated native events in socket order', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const operationId = 'abababab-abab-4bab-8bab-abababababab'
    await expect(
      manager.createSession({ operationId, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }),
    ).resolves.toMatchObject({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cursor: 'cursor-1',
    })
    await expect(
      manager.openSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).resolves.toMatchObject({ documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' })
    await expect(
      manager.promptSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        text: 'hello',
      }),
    ).resolves.toEqual({ runId: 'run-1', acceptedCursor: 'cursor-1' })
    await expect(
      manager.abortSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        runId: 'run-1',
      }),
    ).resolves.toEqual({ runId: 'run-1', state: 'cancelling', acceptedCursor: 'cursor-2' })
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
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
    await expect(
      manager.issueMutationGrant({
        operationId,
        ...bound,
        requestId: 'grant-request-1',
        receipt: grantReceipt,
      }),
    ).resolves.toMatchObject({ grant: { status: 'active' } })
    await expect(
      manager.denyMutationGrant({
        operationId,
        ...bound,
        requestId: 'grant-request-1',
        userActionId: 'user-action-2',
      }),
    ).resolves.toMatchObject({ grant: { status: 'denied' } })
    await expect(
      manager.revokeMutationGrant({
        operationId,
        ...bound,
        grantId: 'grant-1',
        userActionId: 'user-action-3',
      }),
    ).resolves.toMatchObject({ grant: { status: 'revoked' } })
    await expect(manager.revokeDocumentMutationGrants({ operationId, ...bound })).resolves.toEqual({
      revoked: true,
    })
    await expect(
      manager.answerUserAction({
        operationId,
        ...bound,
        requestId: 'question-1',
        userActionId: 'user-action-4',
        answer: { confirmed: true },
      }),
    ).resolves.toMatchObject({ action: { requestId: 'question-1', status: 'answered' } })
    await expect(
      manager.forkSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).resolves.toMatchObject({
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      parentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    await expect(
      manager.navigateSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        targetEntryId: 'target-leaf',
      }),
    ).resolves.toMatchObject({ activeLeafId: 'navigation-leaf' })
    await expect(
      manager.snapshotSession({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).resolves.toMatchObject({ lastSequence: 1 })
    await expect(
      manager.subscribeSession({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        afterCursor: 'cursor-1',
      }),
    ).resolves.toMatchObject({ resetRequired: false, events: [] })
    await manager.shutdown()
  })

  it('uses write-only credential management methods and validates redacted status results', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const secretPayload = '{"type":"api_key","key":"manager-management-canary"}'
    await expect(
      manager.putCredential({
        providerId: 'openai',
        persistence: 'memory_only',
        secretPayload,
      }),
    ).resolves.toEqual({
      providerId: 'openai',
      persistence: 'memory_only',
      status: 'available',
      kind: 'api_key',
    })
    await expect(manager.credentialStatus({ providerId: 'openai' })).resolves.toEqual({
      providerId: 'openai',
      persistence: 'persistent',
      status: 'missing',
    })
    await expect(manager.deleteCredential({ providerId: 'openai' })).resolves.toEqual({
      providerId: 'openai',
      persistence: 'persistent',
      status: 'missing',
    })
    expect(JSON.stringify(await manager.credentialStatus({ providerId: 'openai' }))).not.toContain(
      'manager-management-canary',
    )
    await manager.shutdown()
  })

  it('uses typed model catalog, selection, OAuth, and logout methods', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const operationId = '55555555-5555-4555-8555-555555555555'
    await expect(manager.modelCatalog()).resolves.toEqual({ providers: [], selections: {} })
    await expect(
      manager.selectModel({ role: 'conversation', providerId: 'openai', modelId: 'gpt-5.4' }),
    ).resolves.toMatchObject({
      selections: { conversation: { providerId: 'openai', modelId: 'gpt-5.4' } },
    })
    await expect(
      manager.configureModelProvider({
        providerId: 'local-openai',
        name: 'Local OpenAI',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            modelId: 'qwen-test',
            name: 'Qwen Test',
            capabilities: ['text-input', 'tool-use'],
          },
        ],
      }),
    ).resolves.toEqual({ providers: [], selections: {} })
    await expect(
      manager.startModelOAuth({ operationId, providerId: 'openai-codex' }),
    ).resolves.toMatchObject({ operationId, state: 'running' })
    await expect(manager.modelOAuthStatus({ operationId })).resolves.toMatchObject({ operationId })
    await expect(
      manager.respondModelOAuth({ operationId, value: 'write-only-response' }),
    ).resolves.toMatchObject({ operationId })
    await expect(manager.cancelModelOAuth({ operationId })).resolves.toMatchObject({ operationId })
    await expect(manager.logoutModel({ providerId: 'openai-codex' })).resolves.toEqual({
      providers: [],
      selections: {},
    })
    await manager.shutdown()
  })

  it('validates resource catalog and Project Trust projections at the Electron boundary', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    await expect(manager.resourceCatalog()).resolves.toMatchObject({ projectState: 'none' })
    await expect(
      manager.resourceCatalog({ projectRoot: '/selected/project' }),
    ).resolves.toMatchObject({ projectState: 'untrusted' })
    const trust = {
      operationId: '55555555-5555-4555-8555-555555555555',
      projectRoot: '/selected/project',
    }
    await expect(manager.grantProjectTrust(trust)).resolves.toMatchObject({
      projectState: 'trusted',
    })
    await expect(manager.revokeProjectTrust(trust)).resolves.toMatchObject({
      projectState: 'untrusted',
    })
    await manager.shutdown()

    const invalidHarness = managerHarness({ resourceResult: { path: '/private/project' } })
    const invalid = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      invalidHarness.dependencies,
    )
    await invalid.start()
    await expect(invalid.resourceCatalog()).rejects.toEqual(
      new PiRuntimeManagerError('resource_catalog_invalid'),
    )
    await invalid.shutdown()

    const errorHarness = managerHarness({ resourceMode: 'error-response' })
    const failed = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      errorHarness.dependencies,
    )
    await failed.start()
    await expect(failed.grantProjectTrust(trust)).rejects.toEqual(
      new PiRuntimeManagerError('invalid_request'),
    )
    await failed.shutdown()
  })

  it('validates Package projections and preserves Package Runtime errors', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const operationId = '55555555-5555-4555-8555-555555555555'
    const mutation = {
      namespace: 'global' as const,
      operationId,
      packageId: 'safe-extension',
    }
    await expect(manager.packageCatalog({ namespace: 'global' })).resolves.toEqual({
      globalGeneration: 1,
      packages: [],
    })
    await expect(
      manager.installLocalPackage({ ...mutation, localPath: '/trusted/main/selection' }),
    ).resolves.toMatchObject({ globalGeneration: 1 })
    await expect(
      manager.installNpmPackage({ ...mutation, name: 'safe-extension', version: '1.2.3' }),
    ).resolves.toMatchObject({ globalGeneration: 1 })
    await expect(
      manager.installGitPackage({
        ...mutation,
        url: 'https://example.com/safe-extension.git',
        commit: 'a'.repeat(40),
      }),
    ).resolves.toMatchObject({ globalGeneration: 1 })
    await expect(manager.activatePackage(mutation)).resolves.toMatchObject({ globalGeneration: 1 })
    await expect(manager.enablePackage(mutation)).resolves.toMatchObject({ globalGeneration: 1 })
    await expect(manager.disablePackage(mutation)).resolves.toMatchObject({ globalGeneration: 1 })
    await expect(manager.uninstallPackage(mutation)).resolves.toMatchObject({ globalGeneration: 1 })
    await manager.shutdown()

    const invalid = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness({ packageResult: { localPath: '/leak' } }).dependencies,
    )
    await invalid.start()
    await expect(invalid.packageCatalog({ namespace: 'global' })).rejects.toEqual(
      new PiRuntimeManagerError('package_catalog_invalid'),
    )
    await invalid.shutdown()

    const failed = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness({ packageMode: 'error-response' }).dependencies,
    )
    await failed.start()
    await expect(failed.activatePackage(mutation)).rejects.toEqual(
      new PiRuntimeManagerError('package_source_invalid'),
    )
    await failed.shutdown()
  })

  it('validates MCP projections and preserves stable MCP Runtime errors', async () => {
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness().dependencies,
    )
    await manager.start()
    const operationId = '55555555-5555-4555-8555-555555555555'
    const mutation = {
      namespace: 'global' as const,
      operationId,
      serverId: 'fixture',
    }
    await expect(manager.mcpCatalog()).resolves.toEqual({ projectState: 'none', servers: [] })
    await expect(manager.activateMcp(mutation)).resolves.toMatchObject({ servers: [] })
    await expect(manager.enableMcp(mutation)).resolves.toMatchObject({ servers: [] })
    await expect(manager.disableMcp(mutation)).resolves.toMatchObject({ servers: [] })
    await expect(manager.retryMcp(mutation)).resolves.toMatchObject({ servers: [] })
    await expect(
      manager.startMcpOAuth({
        ...mutation,
        redirectUrl: `http://127.0.0.1:53682/mcp/oauth/callback/${operationId}`,
      }),
    ).resolves.toEqual({
      operationId,
      authorizationUrl: 'https://issuer.example.test/authorize?state=safe-state',
      expiresAt: 123_456,
    })
    await expect(
      manager.completeMcpOAuth({
        ...mutation,
        callbackUrl: `http://127.0.0.1:53682/mcp/oauth/callback/${operationId}?code=x&state=y&iss=https%3A%2F%2Fissuer.example.test`,
      }),
    ).resolves.toMatchObject({ servers: [] })
    await expect(manager.cancelMcpOAuth(mutation)).resolves.toMatchObject({ servers: [] })
    await expect(
      manager.enableMcpTool({ ...mutation, toolName: 'read_fixture' }),
    ).resolves.toMatchObject({ servers: [] })
    await expect(
      manager.disableMcpTool({ ...mutation, toolName: 'read_fixture' }),
    ).resolves.toMatchObject({ servers: [] })
    await manager.shutdown()

    const invalid = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness({ mcpResult: { command: '/bin/leak' } }).dependencies,
    )
    await invalid.start()
    await expect(invalid.mcpCatalog()).rejects.toEqual(
      new PiRuntimeManagerError('mcp_catalog_invalid'),
    )
    await invalid.shutdown()

    const invalidOAuth = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness({
        mcpResult: {
          operationId,
          authorizationUrl: 'http://attacker.example.test/authorize?state=unsafe',
          expiresAt: 123_456,
        },
      }).dependencies,
    )
    await invalidOAuth.start()
    await expect(
      invalidOAuth.startMcpOAuth({
        ...mutation,
        redirectUrl: `http://127.0.0.1:53682/mcp/oauth/callback/${operationId}`,
      }),
    ).rejects.toEqual(new PiRuntimeManagerError('mcp_oauth_start_invalid'))
    await invalidOAuth.shutdown()

    const failed = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness({ mcpMode: 'error-response' }).dependencies,
    )
    await failed.start()
    await expect(failed.retryMcp(mutation)).rejects.toEqual(
      new PiRuntimeManagerError('mcp_unavailable'),
    )
    await failed.shutdown()
  })

  it('validates model projections and preserves stable Runtime errors', async () => {
    const invalidHarness = managerHarness({ modelResult: { apiKey: 'secret-canary' } })
    const invalid = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      invalidHarness.dependencies,
    )
    await invalid.start()
    await expect(invalid.modelCatalog()).rejects.toEqual(
      new PiRuntimeManagerError('model_catalog_invalid'),
    )
    await expect(
      invalid.configureModelProvider({
        providerId: 'local-openai',
        name: 'Local OpenAI',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            modelId: 'qwen-test',
            name: 'Qwen Test',
            capabilities: ['text-input'],
          },
        ],
      }),
    ).rejects.toEqual(new PiRuntimeManagerError('model_catalog_invalid'))
    await expect(
      invalid.startModelOAuth({
        operationId: '55555555-5555-4555-8555-555555555555',
        providerId: 'openai-codex',
      }),
    ).rejects.toEqual(new PiRuntimeManagerError('oauth_operation_projection_invalid'))
    await expect(invalid.logoutModel({ providerId: 'openai-codex' })).rejects.toEqual(
      new PiRuntimeManagerError('model_catalog_invalid'),
    )
    await invalid.shutdown()

    const errorHarness = managerHarness({ modelMode: 'error-response' })
    const failed = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      errorHarness.dependencies,
    )
    await failed.start()
    await expect(failed.modelCatalog()).rejects.toEqual(
      new PiRuntimeManagerError('model_not_found'),
    )
    await expect(
      failed.selectModel({ role: 'conversation', providerId: 'openai', modelId: 'missing' }),
    ).rejects.toEqual(new PiRuntimeManagerError('model_not_found'))
    await expect(
      failed.configureModelProvider({
        providerId: 'local-openai',
        name: 'Local OpenAI',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            modelId: 'qwen-test',
            name: 'Qwen Test',
            capabilities: ['text-input'],
          },
        ],
      }),
    ).rejects.toEqual(new PiRuntimeManagerError('model_not_found'))
    await expect(
      failed.startModelOAuth({
        operationId: '55555555-5555-4555-8555-555555555555',
        providerId: 'openai-codex',
      }),
    ).rejects.toEqual(new PiRuntimeManagerError('model_not_found'))
    await failed.shutdown()
  })

  it.each(['putCredential', 'credentialStatus', 'deleteCredential'] as const)(
    'maps an invalid %s result to a stable redacted error',
    async (method) => {
      const harness = managerHarness({ credentialResult: null })
      const manager = new PiRuntimeManager(
        { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
        harness.dependencies,
      )
      await manager.start()
      const call =
        method === 'putCredential'
          ? manager.putCredential({
              providerId: 'openai',
              persistence: 'persistent' as const,
              secretPayload: '{"type":"api_key","key":"invalid-result-canary"}',
            })
          : method === 'credentialStatus'
            ? manager.credentialStatus({ providerId: 'openai' })
            : manager.deleteCredential({ providerId: 'openai' })
      await expect(call).rejects.toEqual(
        new PiRuntimeManagerError('provider_credential_status_invalid'),
      )
      await manager.shutdown()
    },
  )

  it('preserves stable Runtime errors across every credential management method', async () => {
    const harness = managerHarness({ credentialMode: 'error-response' })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    await Promise.all([
      expect(
        manager.putCredential({
          providerId: 'openai',
          persistence: 'persistent',
          secretPayload: '{"type":"api_key","key":"runtime-error-canary"}',
        }),
      ).rejects.toEqual(new PiRuntimeManagerError('secure_storage_unavailable')),
      expect(manager.credentialStatus({ providerId: 'openai' })).rejects.toEqual(
        new PiRuntimeManagerError('secure_storage_unavailable'),
      ),
      expect(manager.deleteCredential({ providerId: 'openai' })).rejects.toEqual(
        new PiRuntimeManagerError('secure_storage_unavailable'),
      ),
    ])
    await manager.shutdown()
  })

  it('starts Windows Runtime through the kill-on-close Job Object launcher', async () => {
    const harness = managerHarness({ helloPid: 9001 })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'win32', parentPid: 7070 },
      harness.dependencies,
    )

    await expect(manager.start()).resolves.toMatchObject({ pid: 9001 })
    expect(harness.spawn).toHaveBeenCalledWith(
      '/installed/pi-agent-runtime/node/open-genoffice-job-launcher.exe',
      [
        '--owner-pid',
        '7070',
        '--',
        '/installed/pi-agent-runtime/node/open-genoffice-pi-agent-runtime',
        '/installed/pi-agent-runtime/app/main.mjs',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
      },
    )
    expect(harness.bootstrap()).toMatchObject({ parentPid: 8128 })
    await manager.shutdown()
  })

  it.each([
    ['createSession', 'session_connection_receipt_invalid'],
    ['openSession', 'session_connection_receipt_invalid'],
    ['promptSession', 'session_prompt_receipt_invalid'],
    ['abortSession', 'session_abort_receipt_invalid'],
    ['resumeSubagent', 'session_subagent_resume_receipt_invalid'],
    ['forkSession', 'session_fork_receipt_invalid'],
    ['navigateSession', 'session_navigate_receipt_invalid'],
    ['snapshotSession', 'session_snapshot_invalid'],
    ['subscribeSession', 'session_subscription_receipt_invalid'],
  ] as const)('maps an invalid %s result to a stable redacted error', async (method, code) => {
    const harness = managerHarness({ sessionResult: null })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
    const input =
      method === 'createSession'
        ? { operationId: 'abababab-abab-4bab-8bab-abababababab', documentId: bound.documentId }
        : method === 'openSession'
          ? { operationId: 'abababab-abab-4bab-8bab-abababababab', ...bound }
          : method === 'promptSession'
            ? {
                operationId: 'abababab-abab-4bab-8bab-abababababab',
                ...bound,
                text: 'hello',
              }
            : method === 'abortSession'
              ? {
                  operationId: 'abababab-abab-4bab-8bab-abababababab',
                  ...bound,
                  runId: 'run-1',
                }
              : method === 'resumeSubagent'
                ? {
                    operationId: 'abababab-abab-4bab-8bab-abababababab',
                    ...bound,
                    runId: 'subagent-run-1',
                  }
                : method === 'navigateSession'
                  ? {
                      operationId: 'abababab-abab-4bab-8bab-abababababab',
                      ...bound,
                      targetEntryId: 'target-leaf',
                    }
                  : method === 'forkSession'
                    ? { operationId: 'abababab-abab-4bab-8bab-abababababab', ...bound }
                    : bound
    await expect(manager[method](input as never)).rejects.toEqual(new PiRuntimeManagerError(code))
    await manager.shutdown()
  })

  it('maps invalid and Runtime-error Mutation Grant receipts to stable errors', async () => {
    const operationId = 'abababab-abab-4bab-8bab-abababababab'
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
    const receipt = {
      grantId: 'grant-1',
      subagentRunId: 'subagent-run-1',
      documentId: bound.documentId,
      exactToolIds: ['office:docs:insert_content'],
      issuedByUserActionId: 'user-action-1',
      issuedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'active' as const,
    }
    const invalid = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness({ sessionResult: null }).dependencies,
    )
    await invalid.start()
    await Promise.all(
      [
        invalid.issueMutationGrant({
          operationId,
          ...bound,
          requestId: 'grant-request-1',
          receipt,
        }),
        invalid.denyMutationGrant({
          operationId,
          ...bound,
          requestId: 'grant-request-1',
          userActionId: 'user-action-2',
        }),
        invalid.revokeMutationGrant({
          operationId,
          ...bound,
          grantId: 'grant-1',
          userActionId: 'user-action-3',
        }),
        invalid.revokeDocumentMutationGrants({ operationId, ...bound }),
      ].map((call) =>
        expect(call).rejects.toEqual(
          new PiRuntimeManagerError('session_mutation_grant_receipt_invalid'),
        ),
      ),
    )
    await expect(
      invalid.answerUserAction({
        operationId,
        ...bound,
        requestId: 'question-1',
        userActionId: 'user-action-4',
        answer: { confirmed: true },
      }),
    ).rejects.toEqual(new PiRuntimeManagerError('session_user_action_receipt_invalid'))
    await invalid.shutdown()

    const runtimeError = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness({ sessionMode: 'error-response' }).dependencies,
    )
    await runtimeError.start()
    await expect(
      runtimeError.denyMutationGrant({
        operationId,
        ...bound,
        requestId: 'grant-request-1',
        userActionId: 'user-action-2',
      }),
    ).rejects.toEqual(new PiRuntimeManagerError('unavailable'))
    await runtimeError.shutdown()
  })

  it('preserves stable Runtime errors across every narrow Session method', async () => {
    const harness = managerHarness({ sessionMode: 'error-response' })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const operationId = 'abababab-abab-4bab-8bab-abababababab'
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
    const calls = [
      manager.createSession({ operationId, documentId: bound.documentId }),
      manager.openSession({ operationId, ...bound }),
      manager.promptSession({ operationId, ...bound, text: 'hello' }),
      manager.abortSession({ operationId, ...bound, runId: 'run-1' }),
      manager.resumeSubagent({ operationId, ...bound, runId: 'subagent-run-1' }),
      manager.answerUserAction({
        operationId,
        ...bound,
        requestId: 'question-1',
        userActionId: 'user-action-1',
        answer: { confirmed: true },
      }),
      manager.forkSession({ operationId, ...bound }),
      manager.navigateSession({ operationId, ...bound, targetEntryId: 'target-leaf' }),
      manager.snapshotSession(bound),
      manager.subscribeSession(bound),
    ]
    await Promise.all(
      calls.map((call) => expect(call).rejects.toEqual(new PiRuntimeManagerError('unavailable'))),
    )
    await manager.shutdown()
  })

  it('fails closed on a mismatched hello and kills the child without leaking the token', async () => {
    const harness = managerHarness({ helloResult: null })
    const diagnostic = vi.fn()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'win32', parentPid: 7070, diagnostic },
      harness.dependencies,
    )
    await expect(manager.start()).rejects.toEqual(
      new PiRuntimeManagerError('runtime_hello_invalid'),
    )
    expect(manager.state).toBe('crashed')
    expect(harness.child.kill).toHaveBeenCalledOnce()
    expect(harness.cleanup).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledWith('runtime_hello_invalid')
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('ab'.repeat(32))
    await expect(manager.shutdown()).resolves.toBeUndefined()
  })

  it('maps raw startup errors and unavailable status to stable manager errors', async () => {
    const unavailable = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness().dependencies,
    )
    await expect(unavailable.status()).rejects.toEqual(
      new PiRuntimeManagerError('runtime_unavailable'),
    )

    const harness = managerHarness({ endpointFailure: true })
    const diagnostic = vi.fn()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070, diagnostic },
      harness.dependencies,
    )
    await expect(manager.start()).rejects.toEqual(new PiRuntimeManagerError('runtime_start_failed'))
    expect(diagnostic).toHaveBeenCalledWith('runtime_start_failed')

    const childFailure = managerHarness({ childError: true })
    const childFailureManager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      childFailure.dependencies,
    )
    await expect(childFailureManager.start()).rejects.toEqual(
      new PiRuntimeManagerError('runtime_start_failed'),
    )
    expect(childFailure.child.kill).toHaveBeenCalledOnce()
    expect(childFailure.cleanup).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'an invalid status payload',
      options: { statusResult: null },
      code: 'runtime_status_invalid',
    },
    {
      name: 'a Runtime error response',
      options: { statusMode: 'error-response' as const },
      code: 'unavailable',
    },
    {
      name: 'an invalid protocol frame',
      options: { statusMode: 'protocol-error' as const },
      code: 'runtime_protocol_invalid',
    },
  ])('rejects $name without corrupting the manager', async ({ options, code }) => {
    const harness = managerHarness({ ...options, prelude: true })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    await expect(manager.status()).rejects.toEqual(new PiRuntimeManagerError(code))
    harness.child.emit('exit', 70, null)
  })

  it('rejects an in-flight request when the socket errors or the child crashes', async () => {
    for (const failure of ['socket', 'child'] as const) {
      const harness = managerHarness({ statusMode: 'hang' })
      const manager = new PiRuntimeManager(
        { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
        harness.dependencies,
      )
      await manager.start()
      const status = manager.status()
      if (failure === 'socket') {
        ;(harness.dependencies.connect as ReturnType<typeof vi.fn>).mock.results[0]!.value.then(
          (socket: FakeRuntimeSocket) => socket.emit('error', new Error('private socket detail')),
        )
        await expect(status).rejects.toEqual(new PiRuntimeManagerError('runtime_connection_error'))
      } else {
        harness.child.emit('exit', 70, null)
        await expect(status).rejects.toEqual(new PiRuntimeManagerError('runtime_crashed'))
      }
    }
  })

  it('marks an unexpected child exit as crashed', async () => {
    const harness = managerHarness()
    const diagnostic = vi.fn()
    const lifecycle: string[] = []
    harness.cleanup.mockImplementation(async () => {
      lifecycle.push('cleanup')
    })
    const onCrash = vi.fn(() => {
      lifecycle.push('crash')
    })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'linux', parentPid: 7070, diagnostic, onCrash },
      harness.dependencies,
    )
    await manager.start()
    harness.child.emit('exit', 70, null)
    await vi.waitFor(() => expect(onCrash).toHaveBeenCalledOnce())
    harness.child.emit('exit', 70, null)
    expect(diagnostic).toHaveBeenCalledWith('runtime_crashed')
    expect(harness.cleanup).toHaveBeenCalledOnce()
    expect(onCrash).toHaveBeenCalledOnce()
    expect(lifecycle).toEqual(['cleanup', 'crash'])
  })
})

describe('private Runtime endpoints', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it

  posixIt('creates a 0700 POSIX instance directory and removes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-endpoint-test-'))
    await chmod(root, 0o700)
    const endpoint = await createPrivateRuntimeEndpoint(
      'darwin',
      () => Buffer.alloc(12, 0xcd),
      root,
    )
    expect(endpoint.endpoint.endsWith(`${sep}runtime.sock`)).toBe(true)
    expect((await stat(join(endpoint.endpoint, '..'))).mode & 0o777).toBe(0o700)
    await endpoint.cleanup()
    await expect(stat(join(endpoint.endpoint, '..'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates a 96-bit Windows Named Pipe without a temp directory', async () => {
    const endpoint = await createPrivateRuntimeEndpoint('win32', () => Buffer.alloc(12, 0xcd))
    expect(endpoint.endpoint).toBe(`\\\\.\\pipe\\open-genoffice-${'cd'.repeat(12)}`)
    await expect(endpoint.cleanup()).resolves.toBeUndefined()
  })
})
