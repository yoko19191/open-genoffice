import { randomUUID } from 'node:crypto'
import { runDebugStdio } from './debug-stdio'
import { runRuntimeProcess } from './process-entry'
import { runRuntimeEntrypoint } from './runtime-entrypoint'

const debug = runDebugStdio.bind(undefined, { stdout: process.stdout })
const production = runRuntimeProcess.bind(undefined, {
  stdin: process.stdin,
  stderr: process.stderr,
  actualParentPid: process.ppid,
  instanceId: randomUUID(),
})

process.exitCode = await runRuntimeEntrypoint(process.argv.slice(2), {
  stderr: process.stderr,
  runDebug: debug,
  runProduction: production,
})
