import { isAbsolute, join } from 'node:path'

export function resolveShellUserDataPath(input: {
  isPackaged: boolean
  appData: string
  override?: string
}): string | undefined {
  if (input.override !== undefined) {
    if (!input.override || !isAbsolute(input.override)) throw new Error('user_data_path_invalid')
    return input.override
  }
  return input.isPackaged ? undefined : join(input.appData, 'GenOffice Dev')
}

export function resolveAgentResourceHome(input: {
  home: string
  packageAudit: boolean
  auditOverride?: string
}): string {
  if (!input.packageAudit) return join(input.home, '.open-genoffice')
  if (!input.auditOverride || !isAbsolute(input.auditOverride)) {
    throw new Error('package_audit_resource_home_invalid')
  }
  return input.auditOverride
}
