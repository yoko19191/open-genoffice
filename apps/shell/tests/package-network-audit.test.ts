import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  installChromiumPackageNetworkAudit,
  packageNetworkAuditEnabled,
} from '../src/main/package-network-audit'

describe('packaged shell network audit', () => {
  it('requires an installed app, explicit enablement, report, and surface', () => {
    expect(
      packageNetworkAuditEnabled({
        isPackaged: true,
        enabled: '1',
        reportPath: '/tmp/network.jsonl',
        surface: 'shell',
      }),
    ).toBe(true)
    expect(
      packageNetworkAuditEnabled({
        isPackaged: false,
        enabled: '1',
        reportPath: '/tmp/network.jsonl',
        surface: 'shell',
      }),
    ).toBe(false)
    expect(packageNetworkAuditEnabled({ isPackaged: true, enabled: '1' })).toBe(false)
  })

  it('allows loopback and blocks remote Chromium requests without recording full URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-network-audit-'))
    const reportPath = join(root, 'network.jsonl')
    let listener!: (
      details: { url: string },
      callback: (value: { cancel?: boolean }) => void,
    ) => void
    const webRequest = {
      onBeforeRequest: vi.fn((_filter, next) => {
        listener = next
      }),
    }
    installChromiumPackageNetworkAudit(webRequest, reportPath, 'shell-first-launch')
    const local = vi.fn()
    const remote = vi.fn()
    listener({ url: 'http://127.0.0.1:3210/health?secret=canary' }, local)
    listener({ url: 'https://remote.example/private?token=canary' }, remote)

    expect(local).toHaveBeenCalledWith({})
    expect(remote).toHaveBeenCalledWith({ cancel: true })
    const report = await readFile(reportPath, 'utf8')
    expect(report).toContain('remote.example')
    expect(report).not.toContain('private')
    expect(report).not.toContain('canary')
  })
})
