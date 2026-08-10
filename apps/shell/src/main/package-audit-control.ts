import { PACKAGE_AUDIT_CHANNELS } from '../shared/package-audit-api'

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
