import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { auditGensparkProduction } from '../packages/acceptance-evidence/src/genspark-audit.mjs'

const mode = process.argv[2] === '--mode' ? process.argv[3] : undefined
if (mode !== 'baseline' && mode !== 'zero') {
  console.error('Usage: node tools/audit-genspark-free.mjs --mode <baseline|zero>')
  process.exit(2)
}

const repoRoot = process.cwd()
const baseline =
  mode === 'baseline'
    ? JSON.parse(
        await readFile(
          join(repoRoot, 'packages/acceptance-evidence/fixtures/genspark-legacy-baseline.json'),
          'utf8',
        ),
      )
    : undefined
const report = await auditGensparkProduction(repoRoot, { mode, baseline })
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'passed') process.exitCode = 1
