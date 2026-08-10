import { runPiRuntimeBundleBuilderCli } from '@genoffice/pi-runtime-bundle/builder'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const defaults = new Map([
  ['--built-in-skills', 'apps/pi-agent-runtime/built-in/skills'],
  ['--subagent-smoke-entry', 'apps/pi-agent-runtime/fixtures/native-subagent-smoke.ts'],
  ['--pi-headless-fixture', 'apps/pi-agent-runtime/fixtures/pi-headless-fixture'],
  ['--network-smoke-entry', 'apps/pi-agent-runtime/fixtures/native-network-smoke.ts'],
  ['--pi-cli-entry', 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'],
  ['--pi-subagent-api-entry', 'node_modules/@agwab/pi-subagent/src/api.ts'],
  ['--pi-subagent-worker-entry', 'node_modules/@agwab/pi-subagent/src/workers/durable-worker.mjs'],
])
for (const [name, relativePath] of defaults) {
  if (!args.includes(name)) args.push(name, join(repoRoot, relativePath))
}

process.exitCode = await runPiRuntimeBundleBuilderCli(args, {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
})
