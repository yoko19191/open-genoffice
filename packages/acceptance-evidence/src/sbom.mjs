import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SBOM_ARGUMENTS = ['sbom', '--omit=dev', '--sbom-format=cyclonedx']

export function npmSbomInvocation({
  npmExecPath = process.env.npm_execpath,
  execPath = process.execPath,
} = {}) {
  return npmExecPath
    ? { executable: execPath, args: [npmExecPath, ...SBOM_ARGUMENTS] }
    : { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: SBOM_ARGUMENTS }
}

export function generateSbom({ repoRoot, output, execute = execFileSync, npmExecPath, execPath }) {
  const invocation = npmSbomInvocation({ npmExecPath, execPath })
  const sbom = JSON.parse(
    execute(invocation.executable, invocation.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  )

  if (
    sbom?.bomFormat !== 'CycloneDX' ||
    sbom.specVersion !== '1.5' ||
    !Array.isArray(sbom.components)
  ) {
    throw new Error('sbom_generation_invalid')
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
  return {
    status: 'passed',
    format: sbom.bomFormat,
    specVersion: sbom.specVersion,
    components: sbom.components.length,
  }
}
