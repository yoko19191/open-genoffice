import { describe, expect, it, vi } from 'vitest'
import { installModelManagementIpc } from '../src/main/model-management-ipc'
import { PI_RUNTIME_CHANNELS } from '../src/shared/pi-runtime-api'

const operationId = '55555555-5555-4555-8555-555555555555'

function harness(options: { selectedProjectRoot?: string; trustedSenderAvailable?: boolean } = {}) {
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
    resourceCatalog: vi.fn(async (input?: { projectRoot?: string }) => ({
      catalogId: 'a'.repeat(64),
      projectState: input?.projectRoot ? ('untrusted' as const) : ('none' as const),
      resources: [],
    })),
    grantProjectTrust: vi.fn(async () => ({
      catalogId: 'a'.repeat(64),
      projectState: 'trusted' as const,
      resources: [],
    })),
    revokeProjectTrust: vi.fn(async () => ({
      catalogId: 'a'.repeat(64),
      projectState: 'untrusted' as const,
      resources: [],
    })),
    packageCatalog: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
    installLocalPackage: vi.fn(async () => ({ globalGeneration: 2, packages: [] })),
    installNpmPackage: vi.fn(async () => ({ globalGeneration: 2, packages: [] })),
    installGitPackage: vi.fn(async () => ({ globalGeneration: 2, packages: [] })),
    activatePackage: vi.fn(async () => ({ globalGeneration: 2, packages: [] })),
    enablePackage: vi.fn(async () => ({ globalGeneration: 2, packages: [] })),
    disablePackage: vi.fn(async () => ({ globalGeneration: 2, packages: [] })),
    uninstallPackage: vi.fn(async () => ({ globalGeneration: 3, packages: [] })),
    mcpCatalog: vi.fn(async (input?: { projectRoot?: string }) => ({
      projectState: input?.projectRoot ? ('trusted' as const) : ('none' as const),
      servers: [],
    })),
    activateMcp: vi.fn(async () => ({ projectState: 'trusted' as const, servers: [] })),
    enableMcp: vi.fn(async () => ({ projectState: 'trusted' as const, servers: [] })),
    disableMcp: vi.fn(async () => ({ projectState: 'trusted' as const, servers: [] })),
    retryMcp: vi.fn(async () => ({ projectState: 'trusted' as const, servers: [] })),
    enableMcpTool: vi.fn(async () => ({ projectState: 'trusted' as const, servers: [] })),
    disableMcpTool: vi.fn(async () => ({ projectState: 'trusted' as const, servers: [] })),
  }
  const openAuthUrl = vi.fn(async () => undefined)
  const selectProjectRoot = vi.fn(async () =>
    Object.hasOwn(options, 'selectedProjectRoot')
      ? options.selectedProjectRoot
      : '/selected/project',
  )
  const selectPackageRoot = vi.fn(async () => '/main-selected/package')
  installModelManagementIpc(
    ipcMain,
    service,
    () => (options.trustedSenderAvailable === false ? null : trustedSender),
    openAuthUrl,
    selectProjectRoot,
    selectPackageRoot,
  )
  return {
    handlers,
    ipcMain,
    service,
    trustedSender,
    openAuthUrl,
    selectProjectRoot,
    selectPackageRoot,
  }
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
      PI_RUNTIME_CHANNELS.resourceCatalog,
      PI_RUNTIME_CHANNELS.selectResourceProject,
      PI_RUNTIME_CHANNELS.grantProjectTrust,
      PI_RUNTIME_CHANNELS.revokeProjectTrust,
      PI_RUNTIME_CHANNELS.packageCatalog,
      PI_RUNTIME_CHANNELS.installLocalPackage,
      PI_RUNTIME_CHANNELS.installNpmPackage,
      PI_RUNTIME_CHANNELS.installGitPackage,
      PI_RUNTIME_CHANNELS.activatePackage,
      PI_RUNTIME_CHANNELS.enablePackage,
      PI_RUNTIME_CHANNELS.disablePackage,
      PI_RUNTIME_CHANNELS.uninstallPackage,
      PI_RUNTIME_CHANNELS.mcpCatalog,
      PI_RUNTIME_CHANNELS.activateMcp,
      PI_RUNTIME_CHANNELS.enableMcp,
      PI_RUNTIME_CHANNELS.disableMcp,
      PI_RUNTIME_CHANNELS.retryMcp,
      PI_RUNTIME_CHANNELS.enableMcpTool,
      PI_RUNTIME_CHANNELS.disableMcpTool,
    ]) {
      await expect(
        fixture.handlers.get(channel)!({ sender: {} }, { secret: 'untrusted' }),
      ).rejects.toThrowError('permission_denied')
    }
    expect(JSON.stringify(fixture.service.selectModel.mock.calls)).not.toContain('untrusted')
  })

  it('keeps the selected project path in main and exposes only safe resource projections', async () => {
    const fixture = harness()
    await expect(
      fixture.handlers.get(PI_RUNTIME_CHANNELS.resourceCatalog)!(
        {
          sender: fixture.trustedSender,
        },
        undefined,
      ),
    ).resolves.toMatchObject({ projectState: 'none' })
    const projection = await fixture.handlers.get(PI_RUNTIME_CHANNELS.selectResourceProject)!(
      { sender: fixture.trustedSender },
      undefined,
    )
    expect(fixture.selectProjectRoot).toHaveBeenCalledOnce()
    expect(fixture.service.resourceCatalog).toHaveBeenLastCalledWith({
      projectRoot: '/selected/project',
    })
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.resourceCatalog)!(
      { sender: fixture.trustedSender },
      undefined,
    )
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.grantProjectTrust)!(
      {
        sender: fixture.trustedSender,
      },
      undefined,
    )
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.revokeProjectTrust)!(
      {
        sender: fixture.trustedSender,
      },
      undefined,
    )
    expect(fixture.service.grantProjectTrust).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      projectRoot: '/selected/project',
    })
    expect(fixture.service.revokeProjectTrust).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      projectRoot: '/selected/project',
    })
    expect(JSON.stringify(projection)).not.toContain('/selected/project')
  })

  it('keeps Package paths and operation IDs in main while forwarding fixed sources', async () => {
    const fixture = harness()
    const sender = { sender: fixture.trustedSender }
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.installLocalPackage)!(sender, {
      namespace: 'global',
      packageId: 'safe-extension',
    })
    expect(fixture.selectPackageRoot).toHaveBeenCalledOnce()
    expect(fixture.service.installLocalPackage).toHaveBeenCalledWith({
      namespace: 'global',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      packageId: 'safe-extension',
      localPath: '/main-selected/package',
    })

    await fixture.handlers.get(PI_RUNTIME_CHANNELS.installNpmPackage)!(sender, {
      namespace: 'global',
      packageId: 'safe-extension',
      name: '@scope/safe-extension',
      version: '1.2.3',
    })
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.installGitPackage)!(sender, {
      namespace: 'global',
      packageId: 'safe-extension',
      url: 'https://example.com/safe-extension.git',
      commit: 'a'.repeat(40),
    })
    expect(fixture.service.installNpmPackage).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.2.3' }),
    )
    expect(fixture.service.installGitPackage).toHaveBeenCalledWith(
      expect.objectContaining({ commit: 'a'.repeat(40) }),
    )

    for (const channel of [
      PI_RUNTIME_CHANNELS.activatePackage,
      PI_RUNTIME_CHANNELS.enablePackage,
      PI_RUNTIME_CHANNELS.disablePackage,
      PI_RUNTIME_CHANNELS.uninstallPackage,
    ]) {
      await fixture.handlers.get(channel)!(sender, {
        namespace: 'global',
        packageId: 'safe-extension',
      })
    }
    expect(fixture.service.uninstallPackage).toHaveBeenCalledWith({
      namespace: 'global',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      packageId: 'safe-extension',
    })
    expect(JSON.stringify(fixture.service.installNpmPackage.mock.calls)).not.toContain(
      '/selected/project',
    )
  })

  it('keeps the previous selection on cancel and requires one before Trust changes', async () => {
    const fixture = harness({ selectedProjectRoot: undefined })
    await expect(
      fixture.handlers.get(PI_RUNTIME_CHANNELS.selectResourceProject)!(
        { sender: fixture.trustedSender },
        undefined,
      ),
    ).resolves.toMatchObject({ projectState: 'none' })
    await expect(
      fixture.handlers.get(PI_RUNTIME_CHANNELS.grantProjectTrust)!(
        { sender: fixture.trustedSender },
        undefined,
      ),
    ).rejects.toThrowError('project_not_selected')
    await expect(
      fixture.handlers.get(PI_RUNTIME_CHANNELS.revokeProjectTrust)!(
        { sender: fixture.trustedSender },
        undefined,
      ),
    ).rejects.toThrowError('project_not_selected')

    const unavailable = harness({ trustedSenderAvailable: false })
    await expect(
      unavailable.handlers.get(PI_RUNTIME_CHANNELS.modelCatalog)!(
        { sender: unavailable.trustedSender },
        undefined,
      ),
    ).rejects.toThrowError('permission_denied')
  })

  it('keeps MCP project roots and operation IDs in main while forwarding only fixed actions', async () => {
    const fixture = harness()
    const sender = { sender: fixture.trustedSender }
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.selectResourceProject)!(sender, undefined)
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.mcpCatalog)!(sender, undefined)
    expect(fixture.service.mcpCatalog).toHaveBeenCalledWith({ projectRoot: '/selected/project' })

    await fixture.handlers.get(PI_RUNTIME_CHANNELS.activateMcp)!(sender, {
      namespace: 'project',
      serverId: 'fixture',
    })
    expect(fixture.service.activateMcp).toHaveBeenCalledWith({
      namespace: 'project',
      projectRoot: '/selected/project',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      serverId: 'fixture',
    })
    await fixture.handlers.get(PI_RUNTIME_CHANNELS.disableMcpTool)!(sender, {
      namespace: 'global',
      serverId: 'fixture',
      toolName: 'read_fixture',
    })
    expect(fixture.service.disableMcpTool).toHaveBeenCalledWith({
      namespace: 'global',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      serverId: 'fixture',
      toolName: 'read_fixture',
    })
    expect(JSON.stringify(fixture.service.disableMcpTool.mock.calls)).not.toContain(
      '/selected/project',
    )
  })
})
