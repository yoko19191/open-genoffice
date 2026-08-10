import { randomUUID } from 'node:crypto'
import type { PiRuntimeService } from '@genoffice/electron-utils'
import type { OAuthOperationProjection } from '@genoffice/agent-runtime-protocol/renderer'
import {
  PI_RUNTIME_CHANNELS,
  asModelOAuthOperationInput,
  asModelOAuthResponseInput,
  asModelOAuthStartInput,
  asModelProviderConfigurationInput,
  asModelSelectInput,
  asMcpMutationInput,
  asMcpToolMutationInput,
  asProviderId,
  asPackageGitInstallInput,
  asPackageLocalInstallInput,
  asPackageMutationInput,
  asPackageNamespace,
  asPackageNpmInstallInput,
  type PackageNamespace,
} from '../shared/pi-runtime-api'
import type { McpOAuthLoopback } from './mcp-oauth-loopback'

type IpcMainLike = {
  handle(channel: string, handler: (event: { sender: object }, value: unknown) => unknown): unknown
}

type ModelManagementService = Pick<
  PiRuntimeService,
  | 'modelCatalog'
  | 'selectModel'
  | 'configureModelProvider'
  | 'startModelOAuth'
  | 'modelOAuthStatus'
  | 'respondModelOAuth'
  | 'cancelModelOAuth'
  | 'logoutModel'
  | 'resourceCatalog'
  | 'grantProjectTrust'
  | 'revokeProjectTrust'
  | 'packageCatalog'
  | 'installLocalPackage'
  | 'installNpmPackage'
  | 'installGitPackage'
  | 'activatePackage'
  | 'enablePackage'
  | 'disablePackage'
  | 'uninstallPackage'
  | 'mcpCatalog'
  | 'activateMcp'
  | 'enableMcp'
  | 'disableMcp'
  | 'retryMcp'
  | 'enableMcpTool'
  | 'disableMcpTool'
>

export function installModelManagementIpc(
  ipcMain: IpcMainLike,
  service: ModelManagementService,
  trustedSender: () => object | null,
  openAuthUrl: (url: string) => Promise<void>,
  selectProjectRoot: () => Promise<string | undefined>,
  selectPackageRoot: () => Promise<string | undefined>,
  mcpOAuth: Pick<McpOAuthLoopback, 'start' | 'cancel'>,
): void {
  const openedInteractions = new Set<string>()
  let selectedProjectRoot: string | undefined
  const assertTrusted = (event: { sender: object }) => {
    const trusted = trustedSender()
    if (trusted === null || event.sender !== trusted) throw new Error('permission_denied')
  }
  const projectInteraction = async (projection: OAuthOperationProjection) => {
    if (projection.interaction?.type !== 'auth_url') return projection
    const key = `${projection.operationId}:${projection.interaction.url}`
    if (!openedInteractions.has(key)) {
      openedInteractions.add(key)
      await openAuthUrl(projection.interaction.url)
    }
    return projection
  }
  const packageScope = (namespace: PackageNamespace) => {
    if (namespace === 'global') return { namespace }
    if (!selectedProjectRoot) throw new Error('project_not_selected')
    return { namespace, projectRoot: selectedProjectRoot }
  }
  const packageMutation = (input: { namespace: PackageNamespace; packageId: string }) => ({
    ...packageScope(input.namespace),
    operationId: randomUUID(),
    packageId: input.packageId,
  })
  const mcpMutation = (input: { namespace: PackageNamespace; serverId: string }) => ({
    ...packageScope(input.namespace),
    operationId: randomUUID(),
    serverId: input.serverId,
  })

  ipcMain.handle(PI_RUNTIME_CHANNELS.modelCatalog, async (event) => {
    assertTrusted(event)
    return service.modelCatalog()
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.selectModel, async (event, value) => {
    assertTrusted(event)
    return service.selectModel(asModelSelectInput(value))
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.configureModelProvider, async (event, value) => {
    assertTrusted(event)
    return service.configureModelProvider(asModelProviderConfigurationInput(value))
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.startModelOAuth, async (event, value) => {
    assertTrusted(event)
    return projectInteraction(await service.startModelOAuth(asModelOAuthStartInput(value)))
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.modelOAuthStatus, async (event, value) => {
    assertTrusted(event)
    return projectInteraction(await service.modelOAuthStatus(asModelOAuthOperationInput(value)))
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.respondModelOAuth, async (event, value) => {
    assertTrusted(event)
    return projectInteraction(await service.respondModelOAuth(asModelOAuthResponseInput(value)))
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.cancelModelOAuth, async (event, value) => {
    assertTrusted(event)
    return projectInteraction(await service.cancelModelOAuth(asModelOAuthOperationInput(value)))
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.logoutModel, async (event, value) => {
    assertTrusted(event)
    return service.logoutModel({ providerId: asProviderId(value) })
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.resourceCatalog, async (event) => {
    assertTrusted(event)
    return service.resourceCatalog(
      selectedProjectRoot ? { projectRoot: selectedProjectRoot } : undefined,
    )
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.selectResourceProject, async (event) => {
    assertTrusted(event)
    selectedProjectRoot = (await selectProjectRoot()) ?? selectedProjectRoot
    return service.resourceCatalog(
      selectedProjectRoot ? { projectRoot: selectedProjectRoot } : undefined,
    )
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.grantProjectTrust, async (event) => {
    assertTrusted(event)
    if (!selectedProjectRoot) throw new Error('project_not_selected')
    return service.grantProjectTrust({
      operationId: randomUUID(),
      projectRoot: selectedProjectRoot,
    })
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.revokeProjectTrust, async (event) => {
    assertTrusted(event)
    if (!selectedProjectRoot) throw new Error('project_not_selected')
    return service.revokeProjectTrust({
      operationId: randomUUID(),
      projectRoot: selectedProjectRoot,
    })
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.packageCatalog, async (event, value) => {
    assertTrusted(event)
    return service.packageCatalog(packageScope(asPackageNamespace(value)))
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.installLocalPackage, async (event, value) => {
    assertTrusted(event)
    const input = asPackageLocalInstallInput(value)
    const localPath = await selectPackageRoot()
    if (!localPath) throw new Error('package_selection_cancelled')
    return service.installLocalPackage({
      ...packageMutation(input),
      localPath,
      ...(input.expectedPreviousContentSha256
        ? { expectedPreviousContentSha256: input.expectedPreviousContentSha256 }
        : {}),
    })
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.installNpmPackage, async (event, value) => {
    assertTrusted(event)
    const input = asPackageNpmInstallInput(value)
    return service.installNpmPackage({
      ...packageMutation(input),
      name: input.name,
      version: input.version,
      ...(input.integrity ? { integrity: input.integrity } : {}),
      ...(input.expectedPreviousContentSha256
        ? { expectedPreviousContentSha256: input.expectedPreviousContentSha256 }
        : {}),
    })
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.installGitPackage, async (event, value) => {
    assertTrusted(event)
    const input = asPackageGitInstallInput(value)
    return service.installGitPackage({
      ...packageMutation(input),
      url: input.url,
      commit: input.commit,
      ...(input.expectedPreviousContentSha256
        ? { expectedPreviousContentSha256: input.expectedPreviousContentSha256 }
        : {}),
    })
  })
  for (const [channel, method] of [
    [PI_RUNTIME_CHANNELS.activatePackage, 'activatePackage'],
    [PI_RUNTIME_CHANNELS.enablePackage, 'enablePackage'],
    [PI_RUNTIME_CHANNELS.disablePackage, 'disablePackage'],
    [PI_RUNTIME_CHANNELS.uninstallPackage, 'uninstallPackage'],
  ] as const) {
    ipcMain.handle(channel, async (event, value) => {
      assertTrusted(event)
      return service[method](packageMutation(asPackageMutationInput(value)))
    })
  }
  ipcMain.handle(PI_RUNTIME_CHANNELS.mcpCatalog, async (event) => {
    assertTrusted(event)
    return service.mcpCatalog(
      selectedProjectRoot ? { projectRoot: selectedProjectRoot } : undefined,
    )
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.loginMcp, async (event, value) => {
    assertTrusted(event)
    const input = asMcpMutationInput(value)
    return mcpOAuth.start({
      ...packageScope(input.namespace),
      serverId: input.serverId,
    })
  })
  ipcMain.handle(PI_RUNTIME_CHANNELS.cancelMcpLogin, async (event, value) => {
    assertTrusted(event)
    const input = asMcpMutationInput(value)
    return mcpOAuth.cancel({
      ...packageScope(input.namespace),
      serverId: input.serverId,
    })
  })
  for (const [channel, method] of [
    [PI_RUNTIME_CHANNELS.activateMcp, 'activateMcp'],
    [PI_RUNTIME_CHANNELS.enableMcp, 'enableMcp'],
    [PI_RUNTIME_CHANNELS.disableMcp, 'disableMcp'],
    [PI_RUNTIME_CHANNELS.retryMcp, 'retryMcp'],
  ] as const) {
    ipcMain.handle(channel, async (event, value) => {
      assertTrusted(event)
      return service[method](mcpMutation(asMcpMutationInput(value)))
    })
  }
  for (const [channel, method] of [
    [PI_RUNTIME_CHANNELS.enableMcpTool, 'enableMcpTool'],
    [PI_RUNTIME_CHANNELS.disableMcpTool, 'disableMcpTool'],
  ] as const) {
    ipcMain.handle(channel, async (event, value) => {
      assertTrusted(event)
      const input = asMcpToolMutationInput(value)
      return service[method]({ ...mcpMutation(input), toolName: input.toolName })
    })
  }
}
