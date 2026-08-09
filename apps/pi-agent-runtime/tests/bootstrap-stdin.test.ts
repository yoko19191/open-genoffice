import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type BootstrapRecord,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'
import {
  RUNTIME_EXIT_CODES,
  RuntimeBootstrapError,
  RuntimeStartError,
  startRuntimeFromStdin,
} from '../src'

const token = 'c'.repeat(64)

async function endpoint(): Promise<string> {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\genoffice-runtime-stdin-${randomUUID()}`
  }
  const socketRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const directory = await mkdtemp(join(socketRoot, 'genoffice-runtime-stdin-'))
  await chmod(directory, 0o700)
  return join(directory, 'runtime.sock')
}

function bootstrap(socketPath: string): BootstrapRecord {
  return {
    kind: 'bootstrap',
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parentPid: 5150,
    endpoint: socketPath,
    token,
  }
}

function hello(): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    kind: 'request',
    id: 'hello-stdin',
    method: 'runtime.hello',
    correlationId: 'correlation-hello-stdin',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: SCHEMA_VERSION,
      token,
    },
  })
}

async function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => resolve(socket))
    socket.once('error', reject)
  })
}

async function nextLine(socket: Socket): Promise<ResponseEnvelope | null> {
  return new Promise((resolve, reject) => {
    let pending = ''
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      const newline = pending.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(pending.slice(0, newline)))
    })
    socket.once('close', () => resolve(null))
    socket.once('error', reject)
  })
}

describe('Runtime inherited stdin bootstrap', () => {
  it('reads one split record, keeps stdin as the lifetime sentinel, and cleans the endpoint on EOF', async () => {
    const socketPath = await endpoint()
    const stdin = new PassThrough()
    const line = `${JSON.stringify(bootstrap(socketPath))}\n`
    const started = startRuntimeFromStdin({
      stdin,
      actualParentPid: 5150,
      instanceId: 'stdin-instance-1',
    })
    stdin.write(line.slice(0, 31))
    stdin.write(line.slice(31))
    const runtime = await started

    const client = await connect(socketPath)
    const response = nextLine(client)
    client.write(`${hello()}\n`)
    expect(await response).toMatchObject({
      kind: 'response',
      result: { instanceId: 'stdin-instance-1' },
    })

    stdin.end()
    await runtime.closed
    if (process.platform !== 'win32') {
      await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects an invalid record with a stable secret-free bootstrap error', async () => {
    const stdin = new PassThrough()
    const diagnostic = vi.fn()
    const started = startRuntimeFromStdin({
      stdin,
      actualParentPid: 5150,
      instanceId: 'stdin-instance-2',
      diagnostic,
    })
    stdin.setEncoding('utf8')
    stdin.end(`{"kind":"bootstrap","token":"${token}"}\n`)

    await expect(started).rejects.toEqual(
      new RuntimeBootstrapError('invalid_bootstrap', RUNTIME_EXIT_CODES.bootstrap),
    )
    expect(diagnostic).toHaveBeenCalledWith('invalid_bootstrap')
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(token)
  })

  it('rejects EOF before the bootstrap record', async () => {
    const stdin = new PassThrough()
    const started = startRuntimeFromStdin({
      stdin,
      actualParentPid: 5150,
      instanceId: 'stdin-instance-3',
    })
    stdin.end()
    await expect(started).rejects.toMatchObject({
      code: 'bootstrap_eof',
      exitCode: RUNTIME_EXIT_CODES.bootstrap,
    })
  })

  it.each([
    {
      name: 'invalid UTF-8',
      write: (stdin: PassThrough) => stdin.end(Buffer.from([0xff, 0x0a])),
      code: 'invalid_bootstrap',
    },
    {
      name: 'an oversized unterminated record',
      write: (stdin: PassThrough) => stdin.write('x'.repeat(1024 * 1024 + 1)),
      code: 'invalid_bootstrap',
    },
    {
      name: 'an oversized terminated record',
      write: (stdin: PassThrough) => stdin.end(`${'x'.repeat(1024 * 1024 + 1)}\n`),
      code: 'invalid_bootstrap',
    },
    {
      name: 'an input error',
      write: (stdin: PassThrough) => stdin.emit('error', new Error('private input detail')),
      code: 'bootstrap_io_error',
    },
  ])('rejects $name before creating an endpoint', async ({ write, code }) => {
    const stdin = new PassThrough()
    const diagnostic = vi.fn()
    const started = startRuntimeFromStdin({
      stdin,
      actualParentPid: 5150,
      instanceId: 'stdin-invalid-input',
      diagnostic,
    })
    write(stdin)
    await expect(started).rejects.toMatchObject({ code, exitCode: RUNTIME_EXIT_CODES.bootstrap })
    expect(diagnostic).toHaveBeenCalledWith(code)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private input detail')
  })

  it('maps parent mismatch and bind failure to stable secret-free errors', async () => {
    const parentMismatchPath = await endpoint()
    const parentMismatchInput = new PassThrough()
    const parentMismatchDiagnostic = vi.fn()
    const parentMismatch = startRuntimeFromStdin({
      stdin: parentMismatchInput,
      actualParentPid: 7,
      instanceId: 'stdin-parent-mismatch',
      diagnostic: parentMismatchDiagnostic,
    })
    parentMismatchInput.write(`${JSON.stringify(bootstrap(parentMismatchPath))}\n`)
    await expect(parentMismatch).rejects.toEqual(
      new RuntimeBootstrapError('invalid_parent_pid', RUNTIME_EXIT_CODES.bootstrap),
    )
    expect(parentMismatchDiagnostic).toHaveBeenCalledWith('invalid_parent_pid')

    const occupiedPath = await endpoint()
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(occupiedPath, resolve))
    const bindInput = new PassThrough()
    const bindDiagnostic = vi.fn()
    const bindFailure = startRuntimeFromStdin({
      stdin: bindInput,
      actualParentPid: 5150,
      instanceId: 'stdin-bind-failure',
      diagnostic: bindDiagnostic,
    })
    bindInput.write(`${JSON.stringify(bootstrap(occupiedPath))}\n`)
    await expect(bindFailure).rejects.toEqual(new RuntimeStartError())
    expect(bindDiagnostic).toHaveBeenCalledWith('runtime_start_failed')
    await new Promise<void>((resolve) => occupied.close(() => resolve()))
  })

  it('shuts down when stdin contains a second record or emits an error', async () => {
    for (const termination of ['extra', 'error'] as const) {
      const socketPath = await endpoint()
      const stdin = new PassThrough()
      const diagnostic = vi.fn()
      const started = startRuntimeFromStdin({
        stdin,
        actualParentPid: 5150,
        instanceId: `stdin-instance-${termination}`,
        diagnostic,
      })
      stdin.write(
        `${JSON.stringify(bootstrap(socketPath))}\n${termination === 'extra' ? '{}\n' : ''}`,
      )
      const runtime = await started

      if (termination === 'error') stdin.emit('error', new Error('private input detail'))

      await runtime.closed
      expect(diagnostic).toHaveBeenCalledWith(
        termination === 'extra' ? 'bootstrap_extra_data' : 'bootstrap_io_error',
      )
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private input detail')
    }
  })
})
import { randomUUID } from 'node:crypto'
