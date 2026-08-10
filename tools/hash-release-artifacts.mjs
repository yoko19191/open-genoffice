import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || value === undefined) {
    process.stderr.write('release_artifact_arguments_invalid\n')
    process.exit(1)
  }
  values.set(name, value)
}
const directory = values.get('--directory')
const output = values.get('--output')
const platform = values.get('--platform')
if (!directory || !output || !['darwin', 'win32', 'linux'].includes(platform)) {
  process.stderr.write('release_artifact_arguments_invalid\n')
  process.exit(1)
}

try {
  const root = resolve(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && /-unsigned\.(?:dmg|zip|exe|AppImage)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const expectedCounts = { darwin: 2, win32: 1, linux: 1 }
  if (candidates.length !== expectedCounts[platform]) {
    throw new Error('release_artifact_set_invalid')
  }
  const artifacts = []
  for (const entry of candidates) {
    const path = join(root, entry.name)
    const [bytes, metadata] = await Promise.all([readFile(path), lstat(path)])
    artifacts.push({
      name: entry.name,
      size: metadata.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  if (entries.some((entry) => /^latest.*\.ya?ml$/i.test(entry.name))) {
    throw new Error('release_artifact_update_metadata_present')
  }
  const evidence = {
    schemaVersion: 1,
    status: 'passed',
    commit: process.env.GITHUB_SHA ?? null,
    platform,
    unsigned: true,
    updateMetadataPresent: false,
    artifacts,
  }
  const outputPath = resolve(output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify({ status: 'passed', platform, artifacts: artifacts.length })}\n`,
  )
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'release_artifact_failed'}\n`)
  process.exit(1)
}
