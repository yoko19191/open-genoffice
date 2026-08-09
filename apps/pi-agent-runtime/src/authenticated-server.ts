import { timingSafeEqual } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import {
  RUNTIME_VERSION,
  createNdjsonFrameDecoder,
  type BootstrapRecord,
  type ProtocolEnvelope,
  type RequestEnvelope,
} from '@genoffice/agent-runtime-protocol'

export type AuthenticatedRuntimeServerOptions = {
  bootstrap: BootstrapRecord
  actualParentPid: number
  instanceId: string
  platform?: NodeJS.Platform
}

export type AuthenticatedRuntimeServer = {
  closed: Promise<void>
  shutdown: () => Promise<void>
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

function tokenMatches(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex')
  const actualBytes = Buffer.from(actual, 'hex')
  return timingSafeEqual(actualBytes, expectedBytes)
}

export async function createAuthenticatedRuntimeServer(
  options: AuthenticatedRuntimeServerOptions,
): Promise<AuthenticatedRuntimeServer> {
  if (options.bootstrap.parentPid !== options.actualParentPid) throw new Error('invalid_parent_pid')

  let authenticatedSocket: Socket | undefined
  let tokenConsumed = false
  let closeStarted = false
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
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
        if (frame.kind !== 'request') {
          socket.destroy()
          return
        }
        if (!authenticated) {
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
              capabilities: ['runtime.status', 'runtime.shutdown'],
            }),
          )
          continue
        }
        handleAuthenticatedRequest(socket, frame)
      }
    })

    socket.once('close', () => {
      if (authenticatedSocket === socket) authenticatedSocket = undefined
    })
  })

  function beginShutdown(): Promise<void> {
    if (closeStarted) return closed
    closeStarted = true
    authenticatedSocket?.end()
    server.close(() => resolveClosed())
    return closed
  }

  function handleAuthenticatedRequest(socket: Socket, request: RequestEnvelope) {
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
    socket.destroy()
  }

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

  return { closed, shutdown: beginShutdown }
}
