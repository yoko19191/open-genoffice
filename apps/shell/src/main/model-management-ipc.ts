import type { PiRuntimeService } from '@genoffice/electron-utils'
import type { OAuthOperationProjection } from '@genoffice/agent-runtime-protocol/renderer'
import {
  PI_RUNTIME_CHANNELS,
  asModelOAuthOperationInput,
  asModelOAuthResponseInput,
  asModelOAuthStartInput,
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
  | 'startModelOAuth'
  | 'modelOAuthStatus'
  | 'respondModelOAuth'
  | 'cancelModelOAuth'
  | 'logoutModel'
>

export function installModelManagementIpc(
  ipcMain: IpcMainLike,
  service: ModelManagementService,
  trustedSender: () => object | null,
  openAuthUrl: (url: string) => Promise<void>,
): void {
  const openedInteractions = new Set<string>()
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
}
