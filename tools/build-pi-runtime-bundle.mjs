import { runPiRuntimeBundleBuilderCli } from '@genoffice/pi-runtime-bundle/builder'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
if (!args.includes('--built-in-skills')) {
  args.push(
    '--built-in-skills',
    join(dirname(fileURLToPath(import.meta.url)), '../apps/pi-agent-runtime/built-in/skills'),
  )
}

process.exitCode = await runPiRuntimeBundleBuilderCli(args, {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
})
