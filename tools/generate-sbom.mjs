import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSbom } from '../packages/acceptance-evidence/src/sbom.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputArgument = process.argv.indexOf('--output')
const output = resolve(
  repoRoot,
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? process.argv[outputArgument + 1]
    : 'apps/shell/build/sbom.cdx.json',
)
try {
  const summary = generateSbom({ repoRoot, output })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} catch {
  process.stderr.write('sbom_generation_failed\n')
  process.exit(1)
}
