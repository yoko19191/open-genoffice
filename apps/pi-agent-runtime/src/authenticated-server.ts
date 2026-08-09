import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
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
import { initializeAgentResourceHome } from '@genoffice/agent-resource'
import { ModelCatalogError, ModelCatalogService } from './model-catalog-service'
import {
  loadModelCatalogSettings,
  saveModelSelection,
  saveOpenAICompatibleProvider,
} from './model-settings'
import { OpenGenOfficeCredentialStoreError } from './open-genoffice-credential-store'
import { createDeterministicPiSession } from './pi-session-factory'
import { RuntimeCredentialBrokerClient } from './runtime-credential-broker-client'
import { RuntimeCredentialStore } from './runtime-credential-store'
import { RunResourceService } from './run-resource-service'
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

  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  })
  const ownedModelCatalog = options.modelCatalog
    ? undefined
    : new ModelCatalogService(modelRuntime, await loadModelCatalogSettings(options.resourceHome))
  const modelCatalog = options.modelCatalog ?? ownedModelCatalog!
  const runResources = new RunResourceService({
    resourceHome: options.resourceHome,
    deviceId: resourceHome.schema.deviceId,
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

  const sessionRegistry =
    options.sessionRegistry ??
    createSessionRegistry({
      dataRoot: options.resourceHome,
      instanceId: options.instanceId,
      cursorSecret: randomBytes(32),
      credentials,
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
              }),
          }
        : {}),
    })

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
              ],
            }),
          )
          continue
        }
        if (frame.kind === 'response') {
          if (!credentialClient.handleResponse(frame as ResponseEnvelope)) socket.destroy()
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
      }
    })
  })

  function beginShutdown(): Promise<void> {
    if (closeStarted) return closed
    closeStarted = true
    credentialClient.close('runtime_connection_closed')
    void sessionRegistry.shutdown().finally(() => {
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
    if (request.method === 'resource.catalog' || request.method.startsWith('project.trust.')) {
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
      socket.write(
        response(request, await runResources.revokeProjectTrust(command.params.projectRoot)),
      )
    } catch {
      socket.write(errorResponse(request, 'invalid_request'))
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
            }),
          ),
        )
        return
      }
      if (request.method === 'session.abort') {
        socket.write(response(request, await sessionRegistry.abort(request.params)))
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
          error instanceof RuntimeSessionError ? error.code : 'internal_error',
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

  return { closed, shutdown: beginShutdown, credentials }
}
