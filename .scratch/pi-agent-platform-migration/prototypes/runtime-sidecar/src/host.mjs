import { chmodSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'

import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  createJsonLineDecoder,
  encodeMessage,
  errorEnvelope,
  secureTokenEqual,
  validateBootstrap,
} from './protocol.mjs'
import { runRuntimeProbes } from './runtime-probes.mjs'

const debugStdio = process.argv.includes('--debug-stdio')

async function readBootstrap() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim()) return validateBootstrap(JSON.parse(line))
  }
  throw new Error('bootstrap was not provided')
}

async function executeRequest(request, context) {
  switch (request.method) {
    case 'status':
      return {
        pid: process.pid,
        ppid: process.ppid,
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: RUNTIME_VERSION,
      }
    case 'probe.runtime':
      return runRuntimeProbes(request.params)
    case 'crash':
      process.exitCode = 70
      setImmediate(() => process.exit(70))
      return { crashing: true }
    case 'shutdown':
      context.shutdownRequested = true
      return { shuttingDown: true }
    default:
      throw Object.assign(new Error(`unknown method: ${request.method}`), {
        code: 'method_not_found',
      })
  }
}

function installRequestStream(input, output, context, onClosed) {
  let queue = Promise.resolve()
  const decoder = createJsonLineDecoder(
    (request) => {
      queue = queue.then(async () => {
        try {
          const result = await executeRequest(request, context)
          output.write(encodeMessage({ id: request.id ?? null, result }))
          if (context.shutdownRequested) onClosed()
        } catch (error) {
          output.write(
            encodeMessage(errorEnvelope(request.id, error.code ?? 'internal_error', error.message)),
          )
        }
      })
    },
    (error) => output.write(encodeMessage(errorEnvelope(null, 'invalid_json', error.message))),
  )
  input.on('data', (chunk) => decoder.push(chunk))
  input.on('end', () => decoder.end())
}

function runDebugStdio() {
  const context = { shutdownRequested: false }
  installRequestStream(process.stdin, process.stdout, context, () => process.exit(0))
}

function runSocket(bootstrap) {
  let authenticated = false
  let token = bootstrap.token
  let activeSocket
  let closing = false
  const context = { shutdownRequested: false }
  const server = createServer((socket) => {
    if (authenticated) {
      socket.end(encodeMessage(errorEnvelope(null, 'already_authenticated', 'token consumed')))
      return
    }

    let handshaken = false
    const decoder = createJsonLineDecoder(
      (request) => {
        if (handshaken) return
        if (request.method !== 'hello') {
          socket.end(encodeMessage(errorEnvelope(request.id, 'hello_required', 'hello required')))
          return
        }
        const params = request.params ?? {}
        if (!secureTokenEqual(params.token, token)) {
          socket.end(encodeMessage(errorEnvelope(request.id, 'unauthorized', 'invalid token')))
          return
        }
        if (params.protocolVersion !== PROTOCOL_VERSION) {
          socket.end(
            encodeMessage(
              errorEnvelope(request.id, 'protocol_mismatch', 'unsupported protocol version'),
            ),
          )
          return
        }
        if (params.runtimeVersion !== RUNTIME_VERSION) {
          socket.end(
            encodeMessage(
              errorEnvelope(request.id, 'runtime_mismatch', 'runtime version mismatch'),
            ),
          )
          return
        }

        handshaken = true
        authenticated = true
        token = undefined
        activeSocket = socket
        socket.write(
          encodeMessage({
            id: request.id ?? null,
            result: {
              pid: process.pid,
              ppid: process.ppid,
              protocolVersion: PROTOCOL_VERSION,
              runtimeVersion: RUNTIME_VERSION,
            },
          }),
        )
        installRequestStream(socket, socket, context, closeRuntime)
      },
      (error) => socket.end(encodeMessage(errorEnvelope(null, 'invalid_json', error.message))),
    )
    socket.on('data', (chunk) => decoder.push(chunk))
  })

  function closeRuntime() {
    if (closing) return
    closing = true
    activeSocket?.end()
    server.close(() => process.exit(0))
  }

  process.stdin.once('end', closeRuntime)
  server.listen(
    {
      path: bootstrap.endpoint,
      exclusive: true,
      readableAll: false,
      writableAll: false,
    },
    () => {
      if (process.platform !== 'win32') chmodSync(bootstrap.endpoint, 0o600)
    },
  )
  server.on('close', () => {
    if (process.platform !== 'win32') {
      try {
        unlinkSync(bootstrap.endpoint)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  })
  server.on('error', (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exit(69)
  })
}

try {
  if (debugStdio) runDebugStdio()
  else runSocket(await readBootstrap())
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exit(64)
}
