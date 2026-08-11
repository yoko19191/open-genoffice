import { runOfficialNodeDistributionCli } from '@genoffice/pi-runtime-bundle/node-distribution'

process.exitCode = await runOfficialNodeDistributionCli(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
})
