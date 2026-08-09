import { describe, expect, it, vi } from 'vitest'
import { installProviderCredentialIpc } from '../src/main/provider-credential-ipc'
import { PI_RUNTIME_CHANNELS } from '../src/shared/pi-runtime-api'

function harness() {
  const handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>()
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
  }
  const trustedSender = {}
  const service = {
    putCredential: vi.fn(async (input) => ({
      providerId: input.providerId,
      persistence: input.persistence,
      status: 'available' as const,
      kind: 'api_key' as const,
    })),
    credentialStatus: vi.fn(async (input) => ({
      providerId: input.providerId,
      persistence: 'persistent' as const,
      status: 'missing' as const,
    })),
    deleteCredential: vi.fn(async (input) => ({
      providerId: input.providerId,
      persistence: 'persistent' as const,
      status: 'missing' as const,
    })),
  }
  installProviderCredentialIpc(ipcMain, service, () => trustedSender)
  return { handlers, ipcMain, service, trustedSender }
}

describe('provider credential IPC', () => {
  it('serializes a write-only API key for Runtime without returning it', async () => {
    const fixture = harness()
    const handler = fixture.handlers.get(PI_RUNTIME_CHANNELS.saveProviderApiKey)!
    const result = await handler(
      { sender: fixture.trustedSender },
      { providerId: 'openai', persistence: 'memory_only', apiKey: 'ipc-secret-canary' },
    )
    expect(fixture.service.putCredential).toHaveBeenCalledWith({
      providerId: 'openai',
      persistence: 'memory_only',
      secretPayload: '{"type":"api_key","key":"ipc-secret-canary"}',
    })
    expect(JSON.stringify(result)).not.toContain('ipc-secret-canary')
  })

  it('forwards only provider IDs for status and logout', async () => {
    const fixture = harness()
    await expect(
      fixture.handlers.get(PI_RUNTIME_CHANNELS.providerCredentialStatus)!(
        {
          sender: fixture.trustedSender,
        },
        'openai',
      ),
    ).resolves.toMatchObject({ status: 'missing' })
    await expect(
      fixture.handlers.get(PI_RUNTIME_CHANNELS.logoutProvider)!(
        {
          sender: fixture.trustedSender,
        },
        'openai',
      ),
    ).resolves.toMatchObject({ status: 'missing' })
    expect(fixture.service.credentialStatus).toHaveBeenCalledWith({ providerId: 'openai' })
    expect(fixture.service.deleteCredential).toHaveBeenCalledWith({ providerId: 'openai' })
  })

  it('rejects every untrusted sender before parsing or dispatch', async () => {
    const fixture = harness()
    for (const channel of [
      PI_RUNTIME_CHANNELS.saveProviderApiKey,
      PI_RUNTIME_CHANNELS.providerCredentialStatus,
      PI_RUNTIME_CHANNELS.logoutProvider,
    ]) {
      await expect(
        fixture.handlers.get(channel)!({ sender: {} }, { secret: 'untrusted-canary' }),
      ).rejects.toThrowError('permission_denied')
    }
    expect(fixture.service.putCredential).not.toHaveBeenCalled()
    expect(fixture.service.credentialStatus).not.toHaveBeenCalled()
    expect(fixture.service.deleteCredential).not.toHaveBeenCalled()
  })

  it('fails closed when no trusted renderer exists or input is invalid', async () => {
    const fixture = harness()
    const trustedSaveHandler = fixture.handlers.get(PI_RUNTIME_CHANNELS.saveProviderApiKey)!
    installProviderCredentialIpc(fixture.ipcMain, fixture.service, () => null)
    const missingSenderHandler = fixture.ipcMain.handle.mock.calls.at(-3)![1]
    await expect(
      missingSenderHandler(
        { sender: fixture.trustedSender },
        { providerId: 'openai', persistence: 'persistent', apiKey: 'key' },
      ),
    ).rejects.toThrowError('permission_denied')
    await expect(
      trustedSaveHandler(
        {
          sender: fixture.trustedSender,
        },
        { providerId: 'openai', persistence: 'persistent', apiKey: '' },
      ),
    ).rejects.toThrowError('provider_credential_input_invalid')
  })
})
