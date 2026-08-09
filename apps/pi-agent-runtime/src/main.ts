import { randomUUID } from 'node:crypto'
import { runRuntimeProcess } from './process-entry'

process.exitCode = await runRuntimeProcess({
  stdin: process.stdin,
  stderr: process.stderr,
  actualParentPid: process.ppid,
  instanceId: randomUUID(),
})
