import type { Readable, Writable } from 'node:stream'
import type { AuthenticatedRuntimeServer } from './authenticated-server'
import {
  RUNTIME_EXIT_CODES,
  RuntimeBootstrapError,
  RuntimeStartError,
  startRuntimeFromStdin,
  type StartRuntimeFromStdinOptions,
} from './bootstrap-stdin'

export type RunRuntimeProcessOptions = {
  stdin: Readable
  stderr: Writable
  actualParentPid: number
  instanceId: string
  platform?: NodeJS.Platform
  startRuntime?: (options: StartRuntimeFromStdinOptions) => Promise<AuthenticatedRuntimeServer>
}

export async function runRuntimeProcess(options: RunRuntimeProcessOptions): Promise<number> {
  try {
    const runtime = await (options.startRuntime ?? startRuntimeFromStdin)({
      stdin: options.stdin,
      actualParentPid: options.actualParentPid,
      instanceId: options.instanceId,
      platform: options.platform,
    })
    await runtime.closed
    return RUNTIME_EXIT_CODES.ok
  } catch (error) {
    if (error instanceof RuntimeBootstrapError || error instanceof RuntimeStartError) {
      options.stderr.write(`${JSON.stringify({ code: error.code })}\n`)
      return error.exitCode
    }
    options.stderr.write(`${JSON.stringify({ code: 'runtime_crash' })}\n`)
    return RUNTIME_EXIT_CODES.crash
  }
}
