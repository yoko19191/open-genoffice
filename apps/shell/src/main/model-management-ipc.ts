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
  asProviderId,
} from '../shared/pi-runtime-api'

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
>

export function installModelManagementIpc(
  ipcMain: IpcMainLike,
  service: ModelManagementService,
  trustedSender: () => object | null,
  openAuthUrl: (url: string) => Promise<void>,
  selectProjectRoot: () => Promise<string | undefined>,
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
}
