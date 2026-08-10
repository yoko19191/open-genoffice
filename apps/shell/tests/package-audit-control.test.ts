import { describe, expect, it, vi } from 'vitest'
import { PACKAGE_AUDIT_CHANNELS } from '../src/shared/package-audit-api'
import { installPackageAuditControl, packageAuditCdpPort } from '../src/main/package-audit-control'

describe('package audit control', () => {
  it('accepts only an explicit loopback debugging port', () => {
    expect(packageAuditCdpPort(undefined)).toBeUndefined()
    expect(packageAuditCdpPort('43117')).toBe('43117')
    expect(() => packageAuditCdpPort('0')).toThrow('package_audit_cdp_port_invalid')
    expect(() => packageAuditCdpPort('65536')).toThrow('package_audit_cdp_port_invalid')
    expect(() => packageAuditCdpPort('43117.5')).toThrow('package_audit_cdp_port_invalid')
  })

  it('reports only package and profile isolation booleans', async () => {
    const handlers = new Map<string, () => unknown>()
    installPackageAuditControl(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      {
        isPackaged: true,
        userData: 'C:\\audit\\profile',
        expectedUserData: 'C:\\audit\\profile',
        schedule: vi.fn(),
        quit: vi.fn(),
      },
    )

    expect(await handlers.get(PACKAGE_AUDIT_CHANNELS.state)?.()).toEqual({
      installed: true,
      userDataIsolated: true,
    })
  })

  it('schedules the existing application shutdown path without quitting inside IPC', async () => {
    const handlers = new Map<string, () => unknown>()
    const scheduled: Array<() => void> = []
    const quit = vi.fn()
    installPackageAuditControl(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      {
        isPackaged: true,
        userData: 'actual',
        expectedUserData: 'expected',
        schedule: (callback) => scheduled.push(callback),
        quit,
      },
    )

    expect(await handlers.get(PACKAGE_AUDIT_CHANNELS.shutdown)?.()).toBe(true)
    expect(quit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(quit).toHaveBeenCalledOnce()
  })
})
