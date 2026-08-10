import { describe, expect, it } from 'vitest'
import {
  packageShellLaunchTimeout,
  validatePackageShellSmoke,
} from '../src/package-shell-smoke.mjs'

function valid(overrides = {}) {
  return {
    installed: true,
    userDataIsolated: true,
    resourceHomeIsolated: true,
    health: { state: 'ready' },
    quickActions: [
      { label: 'AI Docs', disabled: false },
      { label: 'AI Sheets', disabled: false },
      { label: 'AI Slides', disabled: false },
      { label: 'Open Local File', disabled: false },
    ],
    bodyText: 'GenOffice',
    mineru: { enabled: false },
    models: { providers: [{ state: 'needs_credentials' }] },
    mcp: { servers: [{ state: 'disabled' }] },
    packages: { packages: [{ enabled: false }] },
    resources: { projectState: 'none' },
    homeEntries: ['.open-genoffice'],
    networkEvents: [
      { kind: 'instrumented', pid: 1 },
      { kind: 'instrumented', pid: 2 },
    ],
    screenshotSha256: 'a'.repeat(64),
    shutdownCompleted: true,
    ...overrides,
  }
}

describe('validatePackageShellSmoke', () => {
  it('allows Windows Defender more launch time without relaxing other platforms', () => {
    expect(packageShellLaunchTimeout('win32')).toBe(60_000)
    expect(packageShellLaunchTimeout('darwin')).toBe(30_000)
    expect(packageShellLaunchTimeout('linux')).toBe(30_000)
  })

  it('summarizes a clean installed first launch without leaking paths', () => {
    expect(validatePackageShellSmoke(valid())).toEqual({
      status: 'passed',
      installed: true,
      firstLaunch: true,
      runtimeState: 'ready',
      cleanHome: true,
      userDataIsolated: true,
      defaults: {
        mineruEnabled: false,
        activeModelProviders: 0,
        activeMcpServers: 0,
        enabledPackages: 0,
        projectState: 'none',
      },
      ui: {
        quickActions: ['AI Docs', 'AI Sheets', 'AI Slides', 'Open Local File'],
        retiredVendorMatches: 0,
        screenshotSha256: 'a'.repeat(64),
      },
      network: { instrumentedProcesses: 2, attempts: 0 },
      shutdown: { completed: true },
    })
  })

  it.each([
    [{ installed: false }, 'package_shell_not_installed'],
    [{ userDataIsolated: false }, 'package_shell_user_data_invalid'],
    [{ resourceHomeIsolated: false }, 'package_shell_resource_home_invalid'],
    [{ health: { state: 'unavailable' } }, 'package_shell_runtime_not_ready'],
    [{ quickActions: [{ label: '', disabled: false }] }, 'package_shell_routes_invalid'],
    [{ bodyText: 'Genspark credits' }, 'package_shell_retired_vendor_ui_present'],
    [{ mineru: { enabled: true } }, 'package_shell_mineru_default_invalid'],
    [{ models: { providers: [{ state: 'ready' }] } }, 'package_shell_model_default_invalid'],
    [{ mcp: { servers: [{ state: 'connecting' }] } }, 'package_shell_mcp_default_invalid'],
    [{ packages: { packages: [{ enabled: true }] } }, 'package_shell_package_default_invalid'],
    [{ resources: { projectState: 'trusted' } }, 'package_shell_project_default_invalid'],
    [{ homeEntries: ['.pi'] }, 'package_shell_home_invalid'],
    [
      {
        networkEvents: [
          { kind: 'instrumented', pid: 1 },
          { kind: 'network_attempt', pid: 1 },
        ],
      },
      'package_shell_network_invalid',
    ],
    [{ shutdownCompleted: false }, 'package_shell_shutdown_invalid'],
  ])('fails closed for an invalid packaged state', (override, error) => {
    expect(() => validatePackageShellSmoke(valid(override))).toThrow(error)
  })
})
