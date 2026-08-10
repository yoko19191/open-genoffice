import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputArgument = process.argv.indexOf('--output')
const output = resolve(
  repoRoot,
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? process.argv[outputArgument + 1]
    : 'apps/shell/build/sbom.cdx.json',
)
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let sbom
try {
  sbom = JSON.parse(
    execFileSync(npmCommand, ['sbom', '--omit=dev', '--sbom-format=cyclonedx'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  )
} catch {
  process.stderr.write('sbom_generation_failed\n')
  process.exit(1)
}

if (
  sbom?.bomFormat !== 'CycloneDX' ||
  sbom.specVersion !== '1.5' ||
  !Array.isArray(sbom.components)
) {
  process.stderr.write('sbom_generation_invalid\n')
  process.exit(1)
}

if (!sbom.components.some((component) => component?.name === 'node')) {
  sbom.components.push({
    'bom-ref': 'pkg:generic/node@22.19.0',
    type: 'framework',
    name: 'node',
    version: '22.19.0',
    scope: 'required',
    purl: 'pkg:generic/node@22.19.0',
    licenses: [{ license: { id: 'MIT' } }],
    externalReferences: [{ type: 'distribution', url: 'https://nodejs.org/dist/v22.19.0/' }],
  })
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`)
process.stdout.write(
  `${JSON.stringify({
    status: 'passed',
    format: sbom.bomFormat,
    specVersion: sbom.specVersion,
    components: sbom.components.length,
  })}\n`,
)
