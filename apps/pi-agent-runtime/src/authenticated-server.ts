import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, stat } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import type { CredentialStore } from '@earendil-works/pi-ai'
import { InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  RUNTIME_VERSION,
  createNdjsonFrameDecoder,
  parseCredentialManagementRequest,
  parseModelManagementRequest,
  parseResourceManagementRequest,
  type BootstrapRecord,
  type ProtocolEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'
import { resolveOfficeToolCatalogMetadata } from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import { resolvePlatformToolDefinition } from '@genoffice/agent-runtime-protocol/platform-tool-catalog'
import {
  PackageLockError,
  ProviderOperationStore,
  ScopedArtifactStore,
  initializeAgentResourceHome,
  type BuiltInResource,
} from '@genoffice/agent-resource'
import { ModelCatalogError, ModelCatalogService } from './model-catalog-service'
import { McpConfigError } from './mcp-config-resolver'
import { McpOAuthError } from './mcp-oauth-controller'
import {
  loadModelCatalogSettings,
  saveModelSelection,
  saveOpenAICompatibleProvider,
} from './model-settings'
import { OpenGenOfficeCredentialStoreError } from './open-genoffice-credential-store'
import { createDeterministicPiSession } from './pi-session-factory'
import { RuntimeCredentialBrokerClient } from './runtime-credential-broker-client'
import { RuntimeCredentialStore } from './runtime-credential-store'
import { RuntimeOfficeToolHostClient } from './runtime-office-tool-host-client'
import { RuntimeMediaPreparationClient } from './runtime-media-preparation-client'
import { CodexOAuthImageProvider } from './codex-oauth-image-provider'
import { PlatformToolService } from './platform-tool-service'
import { ModelMediaProvider } from './model-media-provider'
import { PiModelMediaClient } from './pi-model-media-client'
import { PackageSourceResolverError } from './package-source-resolver'
import { RunResourceService, RunResourceServiceError } from './run-resource-service'
import { PiSubagentEngine } from './pi-subagent-engine'
import { PiSlidesQcPlanner } from './pi-slides-qc-planner'
import { SlidesQcCoordinator } from './slides-qc-coordinator'
import { SubagentCoordinator, type SubagentToolDescriptor } from './subagent-coordinator'
import { SubagentRunRegistry } from './subagent-run-registry'
import { MutationGrantRegistry, MutationGrantRegistryError } from './mutation-grant-registry'
import {
  RuntimeSessionError,
  createSessionRegistry,
  type SessionRegistry,
} from './session-registry'

export type AuthenticatedRuntimeServerOptions = {
  bootstrap: BootstrapRecord
  actualParentPid: number
  instanceId: string
  resourceHome: string
  platform?: NodeJS.Platform
  sessionRegistry?: SessionRegistry
  modelCatalog?: Pick<
    ModelCatalogService,
    | 'catalog'
    | 'select'
    | 'configureProvider'
    | 'startOAuth'
    | 'oauthStatus'
    | 'respondOAuth'
    | 'cancelOAuth'
    | 'logout'
  >
}

export type AuthenticatedRuntimeServer = {
  closed: Promise<void>
  shutdown: () => Promise<void>
  credentials: CredentialStore
  officeTools?: RuntimeOfficeToolHostClient
  mediaPreparation?: RuntimeMediaPreparationClient
}

export async function resolveInstalledBuiltInResources(
  runtimeEntry: string | undefined,
): Promise<readonly BuiltInResource[]> {
  if (!runtimeEntry) return []
  const skills = [
    ['open-genoffice/sheets-workbook', 'open-genoffice-sheets-workbook'],
    ['open-genoffice/slides-authoring', 'open-genoffice-slides-authoring'],
  ] as const
  const root = resolve(dirname(runtimeEntry), '..', 'built-in', 'skills')
  const installed = await Promise.all(
    skills.map(async ([resourceId, directory]) => {
      const path = join(root, directory)
      const present = await stat(join(path, 'SKILL.md'))
        .then((metadata) => metadata.isFile())
        .catch(() => false)
      return present ? ({ resourceId, kind: 'skill', path } satisfies BuiltInResource) : undefined
    }),
  )
  return installed.filter(
    (resource): resource is NonNullable<(typeof installed)[number]> => resource !== undefined,
  )
}

function response(request: RequestEnvelope, result: unknown): string {
  return `${JSON.stringify({
    protocolVersion: request.protocolVersion,
    kind: 'response',
    id: request.id,
    correlationId: request.correlationId,
    result,
  })}\n`
}

function errorResponse(request: RequestEnvelope, code: string): string {
  return `${JSON.stringify({
    protocolVersion: request.protocolVersion,
    kind: 'response',
    id: request.id,
    correlationId: request.correlationId,
    error: {
      code,
      message: code,
      retryable: false,
      correlationId: request.correlationId,
    },
  })}\n`
}

function tokenMatches(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex')
  const actualBytes = Buffer.from(actual, 'hex')
  return timingSafeEqual(actualBytes, expectedBytes)
}

export async function createAuthenticatedRuntimeServer(
  options: AuthenticatedRuntimeServerOptions,
): Promise<AuthenticatedRuntimeServer> {
  if (options.bootstrap.parentPid !== options.actualParentPid) throw new Error('invalid_parent_pid')

  const resourceHome = await initializeAgentResourceHome({
    rootDirectory: options.resourceHome,
    runtimeVersion: RUNTIME_VERSION,
    ...(options.platform ? { platform: options.platform } : {}),
  })

  let authenticatedSocket: Socket | undefined
  let tokenConsumed = false
  let closeStarted = false
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const credentialClient = new RuntimeCredentialBrokerClient({
    send: (request) => {
      if (!authenticatedSocket) throw new Error('runtime_connection_closed')
      authenticatedSocket.write(`${JSON.stringify(request)}\n`)
    },
  })
  const credentials = new RuntimeCredentialStore({
    broker: credentialClient,
  })
  const officeTools = new RuntimeOfficeToolHostClient({
    send: (request) => {
      if (!authenticatedSocket) throw new Error('runtime_connection_closed')
      authenticatedSocket.write(`${JSON.stringify(request)}\n`)
    },
  })
  const mediaPreparation = new RuntimeMediaPreparationClient({
    send: (request) => {
      if (!authenticatedSocket) throw new Error('runtime_connection_closed')
      authenticatedSocket.write(`${JSON.stringify(request)}\n`)
    },
  })

  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  })
  const imageProvider = new CodexOAuthImageProvider({
    rootDirectory: options.resourceHome,
    modelRuntime,
  })
  const artifactStore = new ScopedArtifactStore({
    rootDirectory: join(options.resourceHome, 'assets', 'artifacts'),
  })
  const platformTools = new PlatformToolService({
    artifactStore,
    credentials,
  })
  const mediaProvider = new ModelMediaProvider({
    operationStore: new ProviderOperationStore({ rootDirectory: options.resourceHome }),
    prepare: (input, signal) => mediaPreparation.prepare(input, signal),
    client: new PiModelMediaClient({
      modelRuntime,
      resolveModel: (providerId, modelId) => modelRuntime.getModel(providerId, modelId),
      artifactStore,
    }),
  })
  const ownedModelCatalog = options.modelCatalog
    ? undefined
    : new ModelCatalogService(modelRuntime, await loadModelCatalogSettings(options.resourceHome))
  const modelCatalog = options.modelCatalog ?? ownedModelCatalog!
  const builtInResources = await resolveInstalledBuiltInResources(process.argv[1])
  const runResources = new RunResourceService({
    resourceHome: options.resourceHome,
    deviceId: resourceHome.schema.deviceId,
    credentials,
    ...(builtInResources.length > 0 ? { builtInResources } : {}),
  })
  const initialModel = modelRuntime.getProviders().flatMap((provider) => provider.getModels())[0]
  if (!initialModel) throw new Error('model_catalog_empty')
  let settingsWrite = Promise.resolve()

  function enqueueSettingsWrite(writeSettings: () => Promise<void>): Promise<void> {
    const write = settingsWrite.then(writeSettings)
    settingsWrite = write.catch(() => undefined)
    return write
  }

  function persistModelSelection(selection: {
    providerId: string
    modelId: string
  }): Promise<void> {
    return enqueueSettingsWrite(() => saveModelSelection(options.resourceHome, selection))
  }

  let ownedSubagentCoordinator: SubagentCoordinator | undefined
  let ownedMutationGrants: MutationGrantRegistry | undefined
  let unsubscribeSlidesQcGrants = () => {}
  let sessionRegistry: SessionRegistry
  if (options.sessionRegistry) {
    sessionRegistry = options.sessionRegistry
  } else {
    const subagentRuns = new SubagentRunRegistry({ rootDirectory: options.resourceHome })
    await subagentRuns.initialize()
    ownedMutationGrants = new MutationGrantRegistry({
      rootDirectory: options.resourceHome,
      inspectRun: (runId) => {
        const run = subagentRuns.getInternal(runId)
        return run
          ? {
              runId: run.runId,
              parentRunId: run.parentRunId,
              parentSessionId: run.parentSessionId,
              documentId: run.documentId,
              role: run.role,
              status: run.status,
              grantableToolIds: run.grantableToolIds,
            }
          : undefined
      },
      resolveEffect: (toolId) => resolveSubagentToolDescriptor(toolId)?.effect,
    })
    await ownedMutationGrants.initialize()
    ownedSubagentCoordinator = new SubagentCoordinator({
      registry: subagentRuns,
      engine: new PiSubagentEngine({ resourceHome: options.resourceHome }),
      authorizeSnapshot: (snapshot, projectRoot) => runResources.verify(snapshot, projectRoot),
      resolveTool: resolveSubagentToolDescriptor,
      mutationGrants: ownedMutationGrants,
      resolveContext: async ({ parentSnapshot, projectRoot }) => ({
        resourceTexts: await runResources.subagentResourceTexts(parentSnapshot, projectRoot),
      }),
    })
    const slidesQcPlanner = ownedModelCatalog
      ? new PiSlidesQcPlanner({
          resourceHome: options.resourceHome,
          agentDir: join(options.resourceHome, 'agent'),
          modelRuntime,
          resolveModel: () => ownedModelCatalog.selectedModel('conversation'),
        })
      : undefined
    const slidesQc = slidesQcPlanner
      ? new SlidesQcCoordinator({
          subagents: ownedSubagentCoordinator,
          officeTools,
          planRepairs: (input, signal) => slidesQcPlanner.plan(input, signal),
        })
      : undefined
    if (slidesQc) {
      unsubscribeSlidesQcGrants = ownedMutationGrants.onEvent(({ projection }) => {
        void slidesQc.handleGrantProjection(projection).catch(() => undefined)
      })
    }
    sessionRegistry = createSessionRegistry({
      dataRoot: options.resourceHome,
      instanceId: options.instanceId,
      cursorSecret: randomBytes(32),
      credentials,
      subagents: ownedSubagentCoordinator,
      ...(slidesQc ? { slidesQc } : {}),
      mutationGrants: ownedMutationGrants,
      ...(ownedModelCatalog
        ? {
            createPiSession: (sessionOptions) =>
              createDeterministicPiSession({
                ...sessionOptions,
                modelRuntime,
                initialModel,
                resolveModel: () => ownedModelCatalog.selectedModel('conversation'),
                resolveModelMetadata: () => ownedModelCatalog.selectedModelMetadata('conversation'),
                runResources,
                officeToolHost: officeTools,
                generateImage: (input, signal) => imageProvider.generate(input, signal),
                platformTools,
                mediaProvider,
                spawnSubagent: (request, signal) => sessionRegistry.spawnSubagent(request, signal),
              }),
          }
        : {}),
    })
    await sessionRegistry.reconcileSubagents()
  }

  const server = createServer((socket) => {
    if (tokenConsumed || authenticatedSocket) {
      socket.destroy()
      return
    }

    const decoder = createNdjsonFrameDecoder()
    let authenticated = false

    socket.on('data', (chunk) => {
      let frames: ProtocolEnvelope[]
      try {
        frames = decoder.push(chunk)
      } catch {
        socket.destroy()
        return
      }

      for (const frame of frames) {
        if (!authenticated) {
          if (frame.kind !== 'request') {
            socket.destroy()
            return
          }
          if (
            frame.method !== 'runtime.hello' ||
            !tokenMatches(options.bootstrap.token, frame.params.token)
          ) {
            socket.destroy()
            return
          }
          authenticated = true
          tokenConsumed = true
          authenticatedSocket = socket
          socket.write(
            response(frame, {
              pid: process.pid,
              instanceId: options.instanceId,
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
            }),
          )
          continue
        }
        if (frame.kind === 'response') {
          const response = frame as ResponseEnvelope
          if (
            !credentialClient.handleResponse(response) &&
            !officeTools.handleResponse(response) &&
            !mediaPreparation.handleResponse(response)
          ) {
            socket.destroy()
          }
          continue
        }
        if (frame.kind !== 'request') {
          socket.destroy()
          return
        }
        handleAuthenticatedRequest(socket, frame)
      }
    })

    socket.once('close', () => {
      if (authenticatedSocket === socket) {
        authenticatedSocket = undefined
        credentialClient.close('runtime_connection_closed')
        officeTools.close('runtime_connection_closed')
        mediaPreparation.close('runtime_connection_closed')
      }
    })
  })

  function beginShutdown(): Promise<void> {
    if (closeStarted) return closed
    closeStarted = true
    credentialClient.close('runtime_connection_closed')
    mediaPreparation.close('runtime_connection_closed')
    void Promise.allSettled([sessionRegistry.shutdown(), runResources.shutdown()]).finally(() => {
      unsubscribeSlidesQcGrants()
      ownedSubagentCoordinator?.close()
      authenticatedSocket?.end()
      server.close(() => resolveClosed())
    })
    return closed
  }

  function handleAuthenticatedRequest(socket: Socket, request: RequestEnvelope) {
    if (request.method === 'runtime.hello') {
      socket.destroy()
      return
    }
    if (request.method === 'runtime.status') {
      socket.write(
        response(request, {
          pid: process.pid,
          instanceId: options.instanceId,
          runtimeVersion: RUNTIME_VERSION,
        }),
      )
      return
    }
    if (request.method === 'runtime.shutdown') {
      socket.end(response(request, { shuttingDown: true }))
      void beginShutdown()
      return
    }
    if (
      request.method === 'credential.put' ||
      request.method === 'credential.status' ||
      request.method === 'credential.delete'
    ) {
      void handleCredentialManagementRequest(socket, request)
      return
    }
    if (request.method.startsWith('model.')) {
      void handleModelManagementRequest(socket, request)
      return
    }
    if (
      request.method === 'resource.catalog' ||
      request.method.startsWith('project.trust.') ||
      request.method.startsWith('package.') ||
      request.method.startsWith('mcp.')
    ) {
      void handleResourceManagementRequest(socket, request)
      return
    }
    void handleSessionRequest(socket, request)
  }

  async function handleResourceManagementRequest(socket: Socket, request: RequestEnvelope) {
    try {
      const command = parseResourceManagementRequest(request)
      if (command.method === 'resource.catalog') {
        socket.write(response(request, await runResources.catalog(command.params.projectRoot)))
        return
      }
      if (command.method === 'project.trust.grant') {
        socket.write(
          response(request, await runResources.grantProjectTrust(command.params.projectRoot)),
        )
        return
      }
      if (command.method === 'project.trust.revoke') {
        socket.write(
          response(request, await runResources.revokeProjectTrust(command.params.projectRoot)),
        )
        return
      }
      if (command.method === 'mcp.catalog') {
        socket.write(response(request, await runResources.mcpCatalog(command.params.projectRoot)))
        return
      }
      if (
        command.method === 'mcp.oauth.start' ||
        command.method === 'mcp.oauth.complete' ||
        command.method === 'mcp.oauth.cancel'
      ) {
        const scope = {
          namespace: command.params.namespace,
          ...(command.params.projectRoot ? { projectRoot: command.params.projectRoot } : {}),
        }
        if (command.method === 'mcp.oauth.start') {
          socket.write(
            response(
              request,
              await runResources.startMcpOAuth(
                scope,
                command.params.serverId,
                command.params.operationId,
                command.params.redirectUrl,
              ),
            ),
          )
          return
        }
        if (command.method === 'mcp.oauth.complete') {
          socket.write(
            response(
              request,
              await runResources.completeMcpOAuth(
                scope,
                command.params.serverId,
                command.params.operationId,
                command.params.callbackUrl,
              ),
            ),
          )
          return
        }
        socket.write(
          response(
            request,
            await runResources.cancelMcpOAuth(
              scope,
              command.params.serverId,
              command.params.operationId,
            ),
          ),
        )
        return
      }
      if (
        command.method === 'mcp.activate' ||
        command.method === 'mcp.enable' ||
        command.method === 'mcp.disable' ||
        command.method === 'mcp.retry' ||
        command.method === 'mcp.tool.enable' ||
        command.method === 'mcp.tool.disable'
      ) {
        const scope = {
          namespace: command.params.namespace,
          ...(command.params.projectRoot ? { projectRoot: command.params.projectRoot } : {}),
        }
        if (command.method === 'mcp.activate') {
          socket.write(
            response(request, await runResources.activateMcp(scope, command.params.serverId)),
          )
          return
        }
        if (command.method === 'mcp.enable' || command.method === 'mcp.disable') {
          socket.write(
            response(
              request,
              await runResources.setMcpServerEnabled(
                scope,
                command.params.serverId,
                command.method === 'mcp.enable',
              ),
            ),
          )
          return
        }
        if (command.method === 'mcp.retry') {
          socket.write(
            response(request, await runResources.retryMcp(scope, command.params.serverId)),
          )
          return
        }
        const result = await runResources.setMcpToolEnabled(
          scope,
          command.params.serverId,
          command.params.toolName,
          command.method === 'mcp.tool.enable',
        )
        socket.write(response(request, result))
        return
      }
      const scope = {
        namespace: command.params.namespace,
        ...(command.params.projectRoot ? { projectRoot: command.params.projectRoot } : {}),
      }
      if (command.method === 'package.catalog') {
        socket.write(response(request, await runResources.packageCatalog(scope)))
        return
      }
      const mutation = {
        ...scope,
        operationId: command.params.operationId,
        packageId: command.params.packageId,
      }
      if (command.method === 'package.install.local') {
        socket.write(
          response(
            request,
            await runResources.installPackage({
              ...mutation,
              source: { type: 'local', path: command.params.localPath },
              ...(command.params.expectedPreviousContentSha256
                ? {
                    expectedPreviousContentSha256: command.params.expectedPreviousContentSha256,
                  }
                : {}),
            }),
          ),
        )
        return
      }
      if (command.method === 'package.install.npm') {
        socket.write(
          response(
            request,
            await runResources.installPackage({
              ...mutation,
              source: {
                type: 'npm',
                name: command.params.name,
                version: command.params.version,
                ...(command.params.integrity ? { integrity: command.params.integrity } : {}),
              },
              ...(command.params.expectedPreviousContentSha256
                ? {
                    expectedPreviousContentSha256: command.params.expectedPreviousContentSha256,
                  }
                : {}),
            }),
          ),
        )
        return
      }
      if (command.method === 'package.install.git') {
        socket.write(
          response(
            request,
            await runResources.installPackage({
              ...mutation,
              source: {
                type: 'git',
                url: command.params.url,
                commit: command.params.commit,
              },
              ...(command.params.expectedPreviousContentSha256
                ? {
                    expectedPreviousContentSha256: command.params.expectedPreviousContentSha256,
                  }
                : {}),
            }),
          ),
        )
        return
      }
      const result =
        command.method === 'package.activate'
          ? await runResources.activatePackage(mutation)
          : command.method === 'package.enable'
            ? await runResources.enablePackage(mutation)
            : command.method === 'package.disable'
              ? await runResources.disablePackage(mutation)
              : await runResources.uninstallPackage(mutation)
      socket.write(response(request, result))
    } catch (error) {
      const code =
        error instanceof PackageLockError ||
        error instanceof PackageSourceResolverError ||
        error instanceof RunResourceServiceError ||
        error instanceof McpConfigError ||
        error instanceof McpOAuthError
          ? error.code
          : 'invalid_request'
      socket.write(errorResponse(request, code))
    }
  }

  async function handleModelManagementRequest(socket: Socket, request: RequestEnvelope) {
    try {
      const command = parseModelManagementRequest(request)
      if (command.method === 'model.catalog') {
        socket.write(response(request, await modelCatalog.catalog()))
        return
      }
      if (command.method === 'model.select') {
        modelCatalog.select(command.params.role, command.params.providerId, command.params.modelId)
        if (command.params.role === 'conversation') {
          await persistModelSelection(command.params)
        }
        socket.write(response(request, await modelCatalog.catalog()))
        return
      }
      if (command.method === 'model.provider.configure') {
        modelCatalog.configureProvider(command.params)
        await enqueueSettingsWrite(() =>
          saveOpenAICompatibleProvider(options.resourceHome, command.params),
        )
        socket.write(response(request, await modelCatalog.catalog()))
        return
      }
      if (command.method === 'model.oauth.start') {
        socket.write(
          response(
            request,
            modelCatalog.startOAuth(command.params.operationId, command.params.providerId),
          ),
        )
        return
      }
      if (command.method === 'model.oauth.status') {
        socket.write(response(request, modelCatalog.oauthStatus(command.params.operationId)))
        return
      }
      if (command.method === 'model.oauth.respond') {
        modelCatalog.respondOAuth(command.params.operationId, command.params.value)
        socket.write(response(request, modelCatalog.oauthStatus(command.params.operationId)))
        return
      }
      if (command.method === 'model.oauth.cancel') {
        modelCatalog.cancelOAuth(command.params.operationId)
        socket.write(response(request, modelCatalog.oauthStatus(command.params.operationId)))
        return
      }
      await modelCatalog.logout(command.params.providerId)
      socket.write(response(request, await modelCatalog.catalog()))
    } catch (error) {
      socket.write(
        errorResponse(request, error instanceof ModelCatalogError ? error.code : 'invalid_request'),
      )
    }
  }

  async function handleCredentialManagementRequest(socket: Socket, request: RequestEnvelope) {
    try {
      const command = parseCredentialManagementRequest(request)
      if (command.method === 'credential.put') {
        socket.write(
          response(
            request,
            await credentials.put(
              command.params.providerId,
              command.params.persistence,
              command.params.secretPayload,
            ),
          ),
        )
        return
      }
      if (command.method === 'credential.status') {
        socket.write(response(request, await credentials.status(command.params.providerId)))
        return
      }
      await credentials.delete(command.params.providerId)
      socket.write(
        response(request, {
          providerId: command.params.providerId,
          persistence: 'persistent',
          status: 'missing',
        }),
      )
    } catch (error) {
      socket.write(
        errorResponse(
          request,
          error instanceof OpenGenOfficeCredentialStoreError ? error.code : 'invalid_request',
        ),
      )
    }
  }

  async function handleSessionRequest(socket: Socket, request: RequestEnvelope) {
    try {
      if (request.method === 'session.create') {
        socket.write(response(request, await sessionRegistry.create(request.params)))
        return
      }
      if (request.method === 'session.open') {
        socket.write(response(request, await sessionRegistry.open(request.params)))
        return
      }
      if (request.method === 'session.prompt') {
        socket.write(
          response(
            request,
            await sessionRegistry.prompt({
              operationId: request.params.operationId,
              sessionId: request.params.sessionId,
              documentId: request.params.documentId,
              text: request.params.text,
              ...(request.params.projectRoot ? { projectRoot: request.params.projectRoot } : {}),
              ...(request.params.artifacts ? { artifacts: request.params.artifacts } : {}),
            }),
          ),
        )
        return
      }
      if (request.method === 'session.abort') {
        socket.write(response(request, await sessionRegistry.abort(request.params)))
        return
      }
      if (request.method === 'session.subagent.resume') {
        socket.write(response(request, await sessionRegistry.resumeSubagent(request.params)))
        return
      }
      if (request.method === 'session.mutation-grant.issue') {
        socket.write(response(request, await sessionRegistry.issueMutationGrant(request.params)))
        return
      }
      if (request.method === 'session.mutation-grant.deny') {
        socket.write(response(request, await sessionRegistry.denyMutationGrant(request.params)))
        return
      }
      if (request.method === 'session.mutation-grant.revoke') {
        socket.write(response(request, await sessionRegistry.revokeMutationGrant(request.params)))
        return
      }
      if (request.method === 'session.mutation-grant.revoke-document') {
        socket.write(
          response(request, await sessionRegistry.revokeDocumentMutationGrants(request.params)),
        )
        return
      }
      if (request.method === 'session.fork') {
        socket.write(response(request, await sessionRegistry.fork(request.params)))
        return
      }
      if (request.method === 'session.navigate') {
        socket.write(response(request, await sessionRegistry.navigate(request.params)))
        return
      }
      if (request.method === 'session.snapshot') {
        socket.write(response(request, await sessionRegistry.snapshot(request.params)))
        return
      }
      if (request.method === 'session.subscribe') {
        socket.write(response(request, await sessionRegistry.subscribe(request.params)))
        return
      }
      socket.write(errorResponse(request, 'method_not_found'))
    } catch (error) {
      socket.write(
        errorResponse(
          request,
          error instanceof RuntimeSessionError
            ? error.code
            : error instanceof MutationGrantRegistryError
              ? error.code === 'mutation_grant_denied'
                ? 'mutation_grant_denied'
                : 'mutation_grant_invalid'
              : 'internal_error',
        ),
      )
    }
  }

  sessionRegistry.onEvent((event) => authenticatedSocket?.write(`${JSON.stringify(event)}\n`))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(
      options.platform === 'win32'
        ? { path: options.bootstrap.endpoint, readableAll: false, writableAll: false }
        : options.bootstrap.endpoint,
      resolve,
    )
  })
  if ((options.platform ?? process.platform) !== 'win32') {
    await chmod(options.bootstrap.endpoint, 0o600)
  }

  return { closed, shutdown: beginShutdown, credentials, officeTools, mediaPreparation }
}

export function resolveSubagentToolDescriptor(
  canonicalToolId: string,
): SubagentToolDescriptor | undefined {
  if (canonicalToolId === 'platform:subagent:spawn') {
    return { canonicalToolId, modelAlias: 'subagent', effect: 'orchestration' }
  }
  if (canonicalToolId === 'platform:resource:read') {
    return { canonicalToolId, modelAlias: 'read', effect: 'read' }
  }
  const platform = resolvePlatformToolDefinition(canonicalToolId)
  if (platform) {
    return {
      canonicalToolId,
      modelAlias: platform.modelAlias,
      effect: platform.effect,
    }
  }
  const office = resolveOfficeToolCatalogMetadata(canonicalToolId)
  if (office) {
    return { canonicalToolId, modelAlias: office.modelAlias, effect: office.effect }
  }
  if (canonicalToolId.startsWith('mcp:')) {
    const modelAlias = canonicalToolId.slice(canonicalToolId.lastIndexOf(':') + 1)
    return modelAlias ? { canonicalToolId, modelAlias, effect: 'read' } : undefined
  }
  return undefined
}
