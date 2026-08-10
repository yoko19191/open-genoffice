import { mkdtemp } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  asPackageAuditEndpoint,
  collectPackageAuditSnapshot,
  packageAuditSocketNeedsCleanup,
  startPackageAuditServer,
} from '../src/main/package-audit-server'

const token = 'a'.repeat(64)

function rawRequest(endpoint: string, parts: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let body = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      const writePart = (index: number) => {
        socket.write(parts[index] ?? '')
        if (index + 1 < parts.length) setTimeout(() => writePart(index + 1), 10)
      }
      writePart(0)
    })
    socket.on('data', (chunk: string) => {
      body += chunk
      const newline = body.indexOf('\n')
      if (newline < 0) return
      socket.destroy()
      try {
        resolve(JSON.parse(body.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
}

function request(endpoint: string, value: unknown): Promise<unknown> {
  return rawRequest(endpoint, [`${JSON.stringify(value)}\n`])
}

const validRequest = (operation: string, requestToken = token) => ({
  schemaVersion: 1,
  token: requestToken,
  operation,
})

describe('package audit server', () => {
  it('collects only the fixed renderer snapshot and trusted main-process state', async () => {
    const executeJavaScript = vi.fn(async () => ({
      health: { state: 'ready' },
      installed: false,
      screenshotBase64: 'renderer-value',
    }))
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

  it('accepts only a fixed Windows pipe or absolute non-Windows socket path', () => {
    expect(
      asPackageAuditEndpoint('\\\\.\\pipe\\genoffice-package-audit-' + 'b'.repeat(32), 'win32'),
    ).toContain('genoffice-package-audit-')
    expect(asPackageAuditEndpoint('/tmp/package-audit.sock', 'darwin')).toBe(
      '/tmp/package-audit.sock',
    )
    expect(() => asPackageAuditEndpoint('relative.sock', 'linux')).toThrowError(
      'package_audit_endpoint_invalid',
    )
    expect(() => asPackageAuditEndpoint('\\\\.\\pipe\\other', 'win32')).toThrowError(
      'package_audit_endpoint_invalid',
    )
    expect(packageAuditSocketNeedsCleanup('win32')).toBe(false)
    expect(packageAuditSocketNeedsCleanup('darwin')).toBe(true)
  })

  it('uses a token-authenticated fixed operation protocol and shuts down cleanly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-package-audit-server-'))
    const endpoint = join(directory, 'audit.sock')
    const shutdown = vi.fn()
    const audit = await startPackageAuditServer({
      token,
      endpoint,
      collect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { installed: true }
      },
      shutdown,
    })
    await expect(request(endpoint, validRequest('snapshot', 'b'.repeat(64)))).resolves.toEqual({
      status: 'not_found',
    })
    await expect(request(endpoint, validRequest('snapshot'))).resolves.toEqual({
      status: 'ok',
      snapshot: { installed: true },
    })
    await expect(
      rawRequest(endpoint, [`${JSON.stringify(validRequest('snapshot'))}\n`, 'ignored']),
    ).resolves.toEqual({ status: 'ok', snapshot: { installed: true } })
    await expect(request(endpoint, validRequest('unknown'))).resolves.toEqual({
      status: 'not_found',
    })
    await expect(rawRequest(endpoint, ['{"schemaVersion":', 'broken}\n'])).resolves.toEqual({
      status: 'not_found',
    })
    await expect(rawRequest(endpoint, ['x'.repeat(1_025)])).resolves.toEqual({
      status: 'not_found',
    })
    await expect(request(endpoint, validRequest('shutdown'))).resolves.toEqual({
      status: 'ok',
      accepted: true,
    })
    expect(shutdown).toHaveBeenCalledOnce()
    await audit.close()
  })

  it('rejects invalid startup data and redacts collector failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-package-audit-invalid-'))
    const endpoint = join(directory, 'audit.sock')
    await expect(
      startPackageAuditServer({
        token: undefined,
        endpoint,
        collect: vi.fn(),
        shutdown: vi.fn(),
      }),
    ).rejects.toThrowError('package_audit_token_invalid')
    await expect(
      startPackageAuditServer({
        token,
        endpoint: undefined,
        collect: vi.fn(),
        shutdown: vi.fn(),
      }),
    ).rejects.toThrowError('package_audit_endpoint_invalid')
    await expect(
      startPackageAuditServer({
        token: 'secret',
        endpoint,
        collect: vi.fn(),
        shutdown: vi.fn(),
      }),
    ).rejects.toThrowError('package_audit_token_invalid')
    const audit = await startPackageAuditServer({
      token,
      endpoint,
      collect: async () => {
        throw new Error('private collector detail')
      },
      shutdown: vi.fn(),
    })
    await expect(request(endpoint, validRequest('snapshot'))).resolves.toEqual({
      status: 'unavailable',
    })
    await expect(request(endpoint, { ...validRequest('snapshot'), extra: true })).resolves.toEqual({
      status: 'not_found',
    })
    for (const invalid of [
      null,
      'request',
      [],
      { schemaVersion: 2, token, operation: 'snapshot' },
    ]) {
      await expect(request(endpoint, invalid)).resolves.toEqual({ status: 'not_found' })
    }
    await expect(
      startPackageAuditServer({
        token,
        endpoint,
        collect: vi.fn(),
        shutdown: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(Error)
    await audit.close()
  })
})
