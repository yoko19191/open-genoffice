import { describe, expect, it, vi } from 'vitest'
import { installModelManagementIpc } from '../src/main/model-management-ipc'
import { PI_RUNTIME_CHANNELS } from '../src/shared/pi-runtime-api'

const operationId = '55555555-5555-4555-8555-555555555555'

function harness() {
  const handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>()
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
  }
  const trustedSender = {}
  const operation = {
    operationId,
    providerId: 'openai-codex',
    state: 'waiting_for_user' as const,
    interaction: {
      type: 'auth_url' as const,
      url: 'https://auth.openai.com/oauth/authorize?state=opaque',
      messageKey: 'model_auth_open_browser' as const,
    },
  }
  const service = {
    modelCatalog: vi.fn(async () => ({ providers: [], selections: {} })),
    selectModel: vi.fn(async () => ({ providers: [], selections: {} })),
    configureModelProvider: vi.fn(async () => ({ providers: [], selections: {} })),
    startModelOAuth: vi.fn(async () => operation),
    modelOAuthStatus: vi.fn(async () => operation),
    respondModelOAuth: vi.fn(async () => ({
      operationId,
      providerId: 'openai-codex',
      state: 'running' as const,
    })),
    cancelModelOAuth: vi.fn(async () => ({
      operationId,
      providerId: 'openai-codex',
      state: 'cancelled' as const,
    })),
    logoutModel: vi.fn(async () => ({ providers: [], selections: {} })),
  }
  const openAuthUrl = vi.fn(async () => undefined)
  installModelManagementIpc(ipcMain, service, () => trustedSender, openAuthUrl)
  return { handlers, ipcMain, service, trustedSender, openAuthUrl }
}

describe('model management IPC', () => {
  it('forwards catalog and selection through the trusted Shell renderer only', async () => {
    const fixture = harness()
    await expect(
      fixture.handlers.get(PI_RUNTIME_CHANNELS.modelCatalog)!(
        { sender: fixture.trustedSender },
        {},
      ),
    ).resolves.toEqual({ providers: [], selections: {} })
    const selection = { role: 'conversation', providerId: 'openai', modelId: 'gpt-5.4' }
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.selectModel)!(
      { sender: fixture.trustedSender },
      selection,
    )
    expect(fixture.service.selectModel).toHaveBeenCalledWith(selection)
    const configuration = {
      providerId: 'local-openai',
      name: 'Local OpenAI',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [
        {
          modelId: 'qwen-test',
          name: 'Qwen Test',
          capabilities: ['text-input', 'tool-use'],
        },
      ],
    }
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.configureModelProvider)!(
      { sender: fixture.trustedSender },
      configuration,
    )
    expect(fixture.service.configureModelProvider).toHaveBeenCalledWith(configuration)
  })

  it('opens each validated OAuth URL once and keeps the response write-only', async () => {
    const fixture = harness()
    const start = { operationId, providerId: 'openai-codex' }
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.startModelOAuth)!(
      { sender: fixture.trustedSender },
      start,
    )
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.modelOAuthStatus)!(
      { sender: fixture.trustedSender },
      { operationId },
    )
    expect(fixture.openAuthUrl).toHaveBeenCalledOnce()
    const result = await fixture.handlers.get(PI_RUNTIME_CHANNELS.respondModelOAuth)!(
      { sender: fixture.trustedSender },
      { operationId, value: 'write-only-response' },
    )
    expect(fixture.service.respondModelOAuth).toHaveBeenCalledWith({
      operationId,
      value: 'write-only-response',
    })
    expect(JSON.stringify(result)).not.toContain('write-only-response')
  })

  it('forwards cancel/logout and rejects untrusted senders before parsing', async () => {
    const fixture = harness()
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.cancelModelOAuth)!(
      { sender: fixture.trustedSender },
      { operationId },
    )
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.logoutModel)!(
      { sender: fixture.trustedSender },
      'openai-codex',
    )
    expect(fixture.service.cancelModelOAuth).toHaveBeenCalledWith({ operationId })
    expect(fixture.service.logoutModel).toHaveBeenCalledWith({ providerId: 'openai-codex' })
    for (const channel of [
      PI_RUNTIME_CHANNELS.modelCatalog,
      PI_RUNTIME_CHANNELS.selectModel,
      PI_RUNTIME_CHANNELS.configureModelProvider,
      PI_RUNTIME_CHANNELS.startModelOAuth,
      PI_RUNTIME_CHANNELS.modelOAuthStatus,
      PI_RUNTIME_CHANNELS.respondModelOAuth,
      PI_RUNTIME_CHANNELS.cancelModelOAuth,
      PI_RUNTIME_CHANNELS.logoutModel,
    ]) {
      await expect(
        fixture.handlers.get(channel)!({ sender: {} }, { secret: 'untrusted' }),
      ).rejects.toThrowError('permission_denied')
    }
    expect(JSON.stringify(fixture.service.selectModel.mock.calls)).not.toContain('untrusted')
  })
})
