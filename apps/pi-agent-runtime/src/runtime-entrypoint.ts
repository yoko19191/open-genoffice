import type { Writable } from 'node:stream'
import { RUNTIME_EXIT_CODES } from './bootstrap-stdin'

export type RuntimeEntrypointDependencies = {
  stderr: Writable
  runDebug: () => Promise<number>
  runProduction: () => Promise<number>
}

export async function runRuntimeEntrypoint(
  args: readonly string[],
  dependencies: RuntimeEntrypointDependencies,
): Promise<number> {
  if (args.length === 0) return dependencies.runProduction()
  if (args.length !== 1 || args[0] !== '--debug-stdio') {
    dependencies.stderr.write(`${JSON.stringify({ code: 'runtime_arguments_invalid' })}\n`)
    return RUNTIME_EXIT_CODES.bootstrap
  }

  try {
    return await dependencies.runDebug()
  } catch {
    dependencies.stderr.write(`${JSON.stringify({ code: 'debug_runtime_failed' })}\n`)
    return RUNTIME_EXIT_CODES.crash
  }
}
