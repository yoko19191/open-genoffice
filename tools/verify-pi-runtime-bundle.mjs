import { runPiRuntimeBundleVerifierCli } from '@genoffice/pi-runtime-bundle'

process.exitCode = await runPiRuntimeBundleVerifierCli(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
})
