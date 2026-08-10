import { PACKAGE_AUDIT_CHANNELS } from '../shared/package-audit-api'

export function packageAuditCdpPort(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new Error('package_audit_cdp_port_invalid')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('package_audit_cdp_port_invalid')
  }
  return String(port)
}

interface PackageAuditIpc {
  handle(channel: string, handler: () => unknown): void
}

interface PackageAuditControlInput {
  isPackaged: boolean
  userData: string
  expectedUserData: string
  schedule(callback: () => void): void
  quit(): void
}

export function installPackageAuditControl(
  ipc: PackageAuditIpc,
  input: PackageAuditControlInput,
): void {
  ipc.handle(PACKAGE_AUDIT_CHANNELS.state, () => ({
    installed: input.isPackaged,
    userDataIsolated: input.userData === input.expectedUserData,
  }))
  ipc.handle(PACKAGE_AUDIT_CHANNELS.shutdown, () => {
    input.schedule(input.quit)
    return true
  })
}
