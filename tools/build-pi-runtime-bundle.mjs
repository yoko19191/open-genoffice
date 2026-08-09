import { runPiRuntimeBundleBuilderCli } from '@genoffice/pi-runtime-bundle/builder'

process.exitCode = await runPiRuntimeBundleBuilderCli(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
})
