import type { PiRuntimeService } from '@genoffice/electron-utils'
import {
  PI_RUNTIME_CHANNELS,
  asProviderCredentialInput,
  asProviderId,
} from '../shared/pi-runtime-api'

type IpcMainLike = {
  handle(channel: string, handler: (event: { sender: object }, value: unknown) => unknown): unknown
}

type ProviderCredentialService = Pick<
  PiRuntimeService,
  'putCredential' | 'credentialStatus' | 'deleteCredential'
>

export function installProviderCredentialIpc(
  ipcMain: IpcMainLike,
  service: ProviderCredentialService,
  trustedSender: () => object | null,
): void {
  const assertTrusted = (event: { sender: object }) => {
    const trusted = trustedSender()
    if (trusted === null || event.sender !== trusted) throw new Error('permission_denied')
  }

  ipcMain.handle(PI_RUNTIME_CHANNELS.saveProviderApiKey, async (event, value) => {
    assertTrusted(event)
    const input = asProviderCredentialInput(value)
    return service.putCredential({
      providerId: input.providerId,
      persistence: input.persistence,
      secretPayload: JSON.stringify({ type: 'api_key', key: input.apiKey }),
    })
  })

  ipcMain.handle(PI_RUNTIME_CHANNELS.providerCredentialStatus, async (event, value) => {
    assertTrusted(event)
    return service.credentialStatus({ providerId: asProviderId(value) })
  })

  ipcMain.handle(PI_RUNTIME_CHANNELS.logoutProvider, async (event, value) => {
    assertTrusted(event)
    return service.deleteCredential({ providerId: asProviderId(value) })
  })
}
