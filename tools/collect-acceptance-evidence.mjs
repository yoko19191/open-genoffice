import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcceptanceEvidenceCli } from '../apps/pi-agent-runtime/src/acceptance-evidence.mjs'

export * from '../apps/pi-agent-runtime/src/acceptance-evidence.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAcceptanceEvidenceCli(process.argv.slice(2))
    .then((evidence) => console.log(JSON.stringify(evidence)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'evidence_failed')
      process.exitCode = 1
    })
}
