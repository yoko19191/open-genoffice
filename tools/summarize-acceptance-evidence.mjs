import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcceptanceSummaryCli } from '../packages/acceptance-evidence/src/summary.mjs'

export { collectAcceptanceEvidence } from '../packages/acceptance-evidence/src/index.mjs'
export * from '../packages/acceptance-evidence/src/summary.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAcceptanceSummaryCli(process.argv.slice(2))
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'summary_failed')
      process.exitCode = 1
    })
}
