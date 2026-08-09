import type { Readable, Writable } from 'node:stream'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  initializeAgentResourceHome,
  type InitializeAgentResourceHomeOptions,
} from '@genoffice/agent-resource'
import { RUNTIME_VERSION } from '@genoffice/agent-runtime-protocol'
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
  resourceHome?: string
  initializeResourceHome?: (options: InitializeAgentResourceHomeOptions) => Promise<unknown>
  startRuntime?: (options: StartRuntimeFromStdinOptions) => Promise<AuthenticatedRuntimeServer>
}

export async function runRuntimeProcess(options: RunRuntimeProcessOptions): Promise<number> {
  try {
    const resourceHome =
      options.resourceHome ??
      process.env.GENOFFICE_RESOURCE_HOME ??
      join(homedir(), '.open-genoffice')
    await (options.initializeResourceHome ?? initializeAgentResourceHome)({
      rootDirectory: resourceHome,
      runtimeVersion: RUNTIME_VERSION,
      platform: options.platform,
    })
    const runtime = await (options.startRuntime ?? startRuntimeFromStdin)({
      stdin: options.stdin,
      actualParentPid: options.actualParentPid,
      instanceId: options.instanceId,
      platform: options.platform,
      resourceHome,
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
