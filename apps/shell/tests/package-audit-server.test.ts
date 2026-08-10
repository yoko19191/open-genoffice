import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PACKAGE_AUDIT_ENDPOINT_FILE,
  collectPackageAuditSnapshot,
  startPackageAuditServer,
} from '../src/main/package-audit-server'

const token = 'a'.repeat(64)

describe('package audit server', () => {
  it('collects only the fixed renderer snapshot and screenshot', async () => {
    const executeJavaScript = vi.fn(async () => ({ health: { state: 'ready' } }))
    const snapshot = await collectPackageAuditSnapshot({
      isPackaged: true,
      userData: '/isolated',
      expectedUserData: '/isolated',
      executeJavaScript,
      capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
    })
    expect(snapshot).toEqual({
      installed: true,
      userDataIsolated: true,
      health: { state: 'ready' },
      screenshotBase64: Buffer.from('png').toString('base64'),
    })
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain("packageCatalog('global')")
    await expect(
      collectPackageAuditSnapshot({
        isPackaged: false,
        userData: '/actual',
        expectedUserData: '/expected',
        executeJavaScript: async () => null,
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
      }),
    ).rejects.toThrowError('package_audit_snapshot_invalid')
  })

  it('binds only loopback and requires the per-run bearer token', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'genoffice-package-audit-server-'))
    const shutdown = vi.fn()
    const audit = await startPackageAuditServer({
      token,
      userData,
      collect: async () => ({ installed: true }),
      shutdown,
    })
    const endpoint = JSON.parse(
      await readFile(join(userData, PACKAGE_AUDIT_ENDPOINT_FILE), 'utf8'),
    ) as { port: number }
    const base = `http://127.0.0.1:${endpoint.port}`
    expect((await fetch(`${base}/snapshot`)).status).toBe(404)
    const headers = { authorization: `Bearer ${token}` }
    await expect(
      fetch(`${base}/snapshot`, { headers }).then((response) => response.json()),
    ).resolves.toEqual({
      installed: true,
    })
    expect((await fetch(`${base}/unknown`, { headers })).status).toBe(404)
    await expect(
      fetch(`${base}/shutdown`, { method: 'POST', headers }).then((response) => response.json()),
    ).resolves.toEqual({ accepted: true })
    expect(shutdown).toHaveBeenCalledOnce()
    await expect(readFile(join(userData, PACKAGE_AUDIT_ENDPOINT_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await audit.close()
  })

  it('rejects missing or malformed tokens and redacts collector failures', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'genoffice-package-audit-invalid-'))
    await expect(
      startPackageAuditServer({ token: undefined, userData, collect: vi.fn(), shutdown: vi.fn() }),
    ).rejects.toThrowError('package_audit_token_invalid')
    await expect(
      startPackageAuditServer({ token: 'secret', userData, collect: vi.fn(), shutdown: vi.fn() }),
    ).rejects.toThrowError('package_audit_token_invalid')
    const audit = await startPackageAuditServer({
      token,
      userData,
      collect: async () => {
        throw new Error('private collector detail')
      },
      shutdown: vi.fn(),
    })
    const endpoint = JSON.parse(
      await readFile(join(userData, PACKAGE_AUDIT_ENDPOINT_FILE), 'utf8'),
    ) as { port: number }
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'package_audit_unavailable' })
    await audit.close()
  })
})
