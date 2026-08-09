import { auditPiPlatformBoundary } from '../packages/acceptance-evidence/src/pi-platform-audit.mjs'

try {
  const report = await auditPiPlatformBoundary(process.cwd())
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
} catch {
  console.error('pi_platform_audit_failed')
  process.exitCode = 1
}
