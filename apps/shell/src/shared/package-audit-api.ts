export const PACKAGE_AUDIT_CHANNELS = {
  state: 'package-audit:state',
  shutdown: 'package-audit:shutdown',
} as const

export interface PackageAuditState {
  installed: boolean
  userDataIsolated: boolean
}

export interface PackageAuditApi {
  state(): Promise<PackageAuditState>
  shutdown(): Promise<boolean>
}
