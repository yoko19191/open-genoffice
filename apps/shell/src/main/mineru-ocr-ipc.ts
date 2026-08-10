import type { MineruOcrService } from '@genoffice/electron-utils'
import { MINERU_OCR_CHANNELS, asMineruOcrEnableInput } from '../shared/mineru-ocr-api'

type IpcMainLike = {
  handle(channel: string, handler: (event: { sender: object }, value?: unknown) => unknown): unknown
}

type MineruOcrSettingsService = Pick<MineruOcrService, 'status' | 'enable' | 'disable'>

export function installMineruOcrIpc(
  ipcMain: IpcMainLike,
  service: MineruOcrSettingsService,
  trustedSender: () => object | null,
): void {
  const assertTrusted = (event: { sender: object }) => {
    const trusted = trustedSender()
    if (trusted === null || event.sender !== trusted) throw new Error('permission_denied')
  }
  ipcMain.handle(MINERU_OCR_CHANNELS.status, async (event) => {
    assertTrusted(event)
    return service.status()
  })
  ipcMain.handle(MINERU_OCR_CHANNELS.enable, async (event, value) => {
    assertTrusted(event)
    return service.enable(asMineruOcrEnableInput(value))
  })
  ipcMain.handle(MINERU_OCR_CHANNELS.disable, async (event) => {
    assertTrusted(event)
    return service.disable()
  })
}
