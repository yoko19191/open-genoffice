import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRecertificationCli } from '../packages/acceptance-evidence/src/recertify.mjs'

export * from '../packages/acceptance-evidence/src/recertify.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRecertificationCli(process.argv.slice(2))
    .then((evidence) => console.log(JSON.stringify(evidence)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'recertify_failed')
      process.exitCode = 1
    })
}
