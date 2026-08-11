import { describe, expect, it } from 'vitest'
import { resolveAgentResourceHome, resolveShellUserDataPath } from '../src/main/user-data-path'

describe('resolveShellUserDataPath', () => {
  it('uses an explicit absolute test path for packaged and unpacked launches', () => {
    expect(
      resolveShellUserDataPath({
        isPackaged: true,
        appData: '/ignored',
        override: '/tmp/genoffice-user-data',
      }),
    ).toBe('/tmp/genoffice-user-data')
    expect(
      resolveShellUserDataPath({
        isPackaged: false,
        appData: '/ignored',
        override: '/tmp/genoffice-user-data',
      }),
    ).toBe('/tmp/genoffice-user-data')
  })

  it('keeps installed defaults and isolates ordinary development runs', () => {
    expect(resolveShellUserDataPath({ isPackaged: true, appData: '/profiles' })).toBeUndefined()
    expect(resolveShellUserDataPath({ isPackaged: false, appData: '/profiles' })).toBe(
      '/profiles/GenOffice Dev',
    )
  })

  it('rejects empty and relative overrides', () => {
    expect(() =>
      resolveShellUserDataPath({ isPackaged: true, appData: '/profiles', override: '' }),
    ).toThrow('user_data_path_invalid')
    expect(() =>
      resolveShellUserDataPath({
        isPackaged: true,
        appData: '/profiles',
        override: 'relative/path',
      }),
    ).toThrow('user_data_path_invalid')
  })

  it('keeps the product resource home fixed except for an explicit package audit', () => {
    expect(
      resolveAgentResourceHome({
        home: '/users/current',
        packageAudit: false,
        auditOverride: '/ignored',
      }),
    ).toBe('/users/current/.open-genoffice')
    expect(
      resolveAgentResourceHome({
        home: '/users/current',
        packageAudit: true,
        auditOverride: '/tmp/audit/.open-genoffice',
      }),
    ).toBe('/tmp/audit/.open-genoffice')
    expect(() =>
      resolveAgentResourceHome({
        home: '/users/current',
        packageAudit: true,
        auditOverride: 'relative',
      }),
    ).toThrow('package_audit_resource_home_invalid')
  })
})
