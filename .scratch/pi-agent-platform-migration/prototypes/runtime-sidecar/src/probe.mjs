import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  createJsonLineDecoder,
  encodeMessage,
} from './protocol.mjs'

const prototypeRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeName =
  process.platform === 'win32'
    ? 'open-genoffice-pi-agent-runtime.exe'
    : 'open-genoffice-pi-agent-runtime'

function stageRuntime() {
  const stageRoot = mkdtempSync(join(tmpdir(), 'Open GenOffice Spike 04 '))
  const runtimeRoot = join(stageRoot, 'resources', 'open-genoffice-pi-agent-runtime')
  const binDir = join(runtimeRoot, 'bin')
  const appDir = join(runtimeRoot, 'app')
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  mkdirSync(appDir, { recursive: true, mode: 0o700 })

  const executable = join(binDir, runtimeName)
  copyFileSync(realpathSync(process.execPath), executable)
  chmodSync(executable, 0o755)
  for (const entry of ['src', 'fixture', 'package.json', 'package-lock.json']) {
    cpSync(join(prototypeRoot, entry), join(appDir, entry), { recursive: true })
  }

  if (process.argv.includes('--copy-node-modules')) {
    cpSync(join(prototypeRoot, 'node_modules'), join(appDir, 'node_modules'), {
      recursive: true,
      dereference: true,
    })
  } else {
    symlinkSync(join(prototypeRoot, 'node_modules'), join(appDir, 'node_modules'), 'dir')
  }

  return {
    stageRoot,
    runtimeRoot,
    executable,
    hostPath: join(appDir, 'src', 'host.mjs'),
    extensionPath: join(appDir, 'fixture', 'extension.mjs'),
    workDir: join(stageRoot, 'work area'),
    dependencyTree: readlinkOrSelf(join(appDir, 'node_modules')),
  }
}

function readlinkOrSelf(path) {
  return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : path
}

function endpointFor(instanceDir) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\open-genoffice-pi-agent-runtime-${randomBytes(12).toString('hex')}`
  }
  return join(instanceDir, 'runtime.sock')
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timeout = setTimeout(
      () => reject(new Error(`process ${child.pid} did not exit`)),
      timeoutMs,
    )
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
}

function forceStop(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function openConnection(endpoint, timeoutMs = 5_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(endpoint)
      socket.once('connect', () => resolve(new RpcConnection(socket)))
      socket.once('error', (error) => {
        socket.destroy()
        if (Date.now() - started >= timeoutMs) reject(error)
        else setTimeout(attempt, 25)
      })
    }
    attempt()
  })
}

class RpcConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    const decoder = createJsonLineDecoder(
      (message) => {
        let pendingId = message.id
        let pending = this.pending.get(pendingId)
        if (!pending && pendingId === null && this.pending.size === 1) {
          ;[pendingId, pending] = this.pending.entries().next().value
        }
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pending.delete(pendingId)
        if (message.error) pending.resolve({ error: message.error })
        else pending.resolve({ result: message.result })
      },
      (error) => {
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
      },
    )
    socket.on('data', (chunk) => decoder.push(chunk))
    socket.on('end', () => decoder.end())
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('socket closed before response'))
      }
      this.pending.clear()
    })
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request timed out: ${method}`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.write(encodeMessage({ id, method, params }))
    })
  }

  close() {
    this.socket.destroy()
  }
}

async function launchRuntime(stage, generation) {
  const instanceDir = join(stage.stageRoot, `instance-${generation}`)
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 })
  mkdirSync(stage.workDir, { recursive: true, mode: 0o700 })
  const endpoint = endpointFor(instanceDir)
  const token = randomBytes(32).toString('hex')
  const child = spawn(stage.executable, [stage.hostPath], {
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  child.stdin.write(
    encodeMessage({
      protocolVersion: PROTOCOL_VERSION,
      parentPid: process.pid,
      endpoint,
      token,
    }),
  )
  return { child, endpoint, instanceDir, token, getStderr: () => stderr }
}

async function rejectedHello(runtime, override) {
  const connection = await openConnection(runtime.endpoint)
  const response = await connection.request('hello', {
    token: runtime.token,
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    ...override,
  })
  connection.close()
  return response.error?.code
}

async function acceptedHello(runtime) {
  const connection = await openConnection(runtime.endpoint)
  const response = await connection.request('hello', {
    token: runtime.token,
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
  })
  if (response.error) throw new Error(`hello failed: ${response.error.code}`)
  return { connection, hello: response.result }
}

function requireResult(response, label) {
  if (response.error)
    throw new Error(`${label} failed: ${response.error.code}: ${response.error.message}`)
  return response.result
}

async function run() {
  const stage = stageRuntime()
  let runtime
  try {
    runtime = await launchRuntime(stage, 1)
    const rejected = {
      token: await rejectedHello(runtime, { token: randomBytes(32).toString('hex') }),
      protocol: await rejectedHello(runtime, { protocolVersion: '0' }),
      runtime: await rejectedHello(runtime, { runtimeVersion: '0.0.0' }),
    }
    const { connection, hello } = await acceptedHello(runtime)
    const socketMode =
      process.platform === 'win32' ? null : (statSync(runtime.endpoint).mode & 0o777).toString(8)
    rejected.reusedToken = await rejectedHello(runtime, {})
    const status = requireResult(await connection.request('status'), 'status')
    const probe = requireResult(
      await connection.request('probe.runtime', {
        extensionPath: stage.extensionPath,
        workDir: stage.workDir,
      }),
      'runtime probe',
    )
    const crashResponse = requireResult(await connection.request('crash'), 'crash')
    const crashed = await waitForExit(runtime.child)
    connection.close()
    if (process.platform !== 'win32') rmSync(runtime.instanceDir, { recursive: true, force: true })

    runtime = await launchRuntime(stage, 2)
    const restarted = await acceptedHello(runtime)
    const restartStatus = requireResult(
      await restarted.connection.request('status'),
      'restart status',
    )
    const shutdown = requireResult(await restarted.connection.request('shutdown'), 'shutdown')
    const stopped = await waitForExit(runtime.child)
    restarted.connection.close()

    runtime = await launchRuntime(stage, 3)
    const parentExit = await acceptedHello(runtime)
    runtime.child.stdin.end()
    const parentExitStopped = await waitForExit(runtime.child)
    parentExit.connection.close()

    const debug = spawnSync(stage.executable, [stage.hostPath, '--debug-stdio'], {
      input: encodeMessage({ id: 1, method: 'status' }),
      encoding: 'utf8',
      timeout: 10_000,
    })
    const debugStatus = JSON.parse(debug.stdout.trim())

    const result = {
      host: { platform: process.platform, arch: process.arch },
      layout: {
        runtimeRoot: stage.runtimeRoot.replace(stage.stageRoot, '<stage>'),
        executable: stage.executable.replace(stage.stageRoot, '<stage>'),
        entry: stage.hostPath.replace(stage.stageRoot, '<stage>'),
        dependencyTree: stage.dependencyTree.startsWith(stage.stageRoot)
          ? stage.dependencyTree.replace(stage.stageRoot, '<stage>')
          : '<prototype>/node_modules',
        executableBytes: statSync(stage.executable).size,
      },
      ipc: {
        transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
        instanceDirectoryMode:
          process.platform === 'win32'
            ? null
            : (statSync(runtime.instanceDir).mode & 0o777).toString(8),
        socketMode,
        rejected,
      },
      firstGeneration: {
        hello,
        status,
        runtimeProbe: probe,
        crashAccepted: crashResponse.crashing,
        exit: crashed,
      },
      secondGeneration: {
        status: restartStatus,
        newPid: restartStatus.pid !== status.pid,
        shutdownAccepted: shutdown.shuttingDown,
        exit: stopped,
      },
      parentExitCleanup: {
        exit: parentExitStopped,
        endpointRemoved: process.platform === 'win32' || !existsSync(runtime.endpoint),
      },
      debugMode: { exitCode: debug.status, status: debugStatus.result },
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    if (runtime?.getStderr) process.stderr.write(runtime.getStderr())
    throw error
  } finally {
    forceStop(runtime?.child)
    rmSync(stage.stageRoot, { recursive: true, force: true })
  }
}

await run()
