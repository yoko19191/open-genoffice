import { describe, expect, it, vi } from 'vitest'
import { PACKAGE_AUDIT_CHANNELS } from '../src/shared/package-audit-api'
import { installPackageAuditControl } from '../src/main/package-audit-control'

describe('package audit control', () => {
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
