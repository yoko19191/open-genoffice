import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { installMineruOcrIpc } from '../src/main/mineru-ocr-ipc'
import {
  MINERU_OCR_CHANNELS,
  asMineruOcrEnableInput,
  asMineruOcrStatus,
} from '../src/shared/mineru-ocr-api'

function harness() {
  const handlers = new Map<string, (event: { sender: object }, value?: unknown) => unknown>()
  const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) }
  const trustedSender = {}
  const service = {
    status: vi.fn(async () => ({ enabled: false, credential: 'missing' as const })),
    enable: vi.fn(async () => ({ enabled: true, credential: 'available' as const })),
    disable: vi.fn(async () => ({ enabled: false, credential: 'available' as const })),
  }
  installMineruOcrIpc(ipcMain, service, () => trustedSender)
  return { handlers, service, trustedSender }
}

describe('MinerU OCR settings IPC', () => {
  it('keeps the production PDF export and disclosure on the MinerU-only path', async () => {
    const mainSource = await readFile(
      fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
      'utf8',
    )
    const homeSource = await readFile(
      fileURLToPath(new URL('../src/renderer/src/Home.tsx', import.meta.url)),
      'utf8',
    )

    expect(mainSource).toContain('mineruOcrService.convert')
    expect(mainSource).toContain('mineruOcrService.exportArtifact')
    expect(mainSource).toContain('openDocsBesidePdf')
    expect(mainSource).not.toMatch(/gskConvertPdfToDocx|hasGskAuth|resolveGskEntry/u)
    expect(mainSource).not.toMatch(/pdfDocx(?:Login|Confirm|NoCli)/u)
    expect(homeSource).toContain('我理解并同意上述云端上传说明')
    expect(homeSource).toContain('MinerU 访问令牌（只写）')
    expect(homeSource).toContain('取消本地任务不能保证远端任务停止')
  })

  it('accepts only explicit disclosure and a write-only token', async () => {
    const fixture = harness()
    const result = await fixture.handlers.get(MINERU_OCR_CHANNELS.enable)!(
      { sender: fixture.trustedSender },
      { disclosureAccepted: true, token: 'private-token' },
    )
    expect(fixture.service.enable).toHaveBeenCalledWith({
      disclosureAccepted: true,
      token: 'private-token',
    })
    expect(JSON.stringify(result)).not.toContain('private-token')
    expect(asMineruOcrEnableInput({ disclosureAccepted: true, token: 'key' })).toEqual({
      disclosureAccepted: true,
      token: 'key',
    })
    for (const invalid of [
      null,
      { disclosureAccepted: false, token: 'key' },
      { disclosureAccepted: true, token: '' },
      { disclosureAccepted: true, token: 'key', extra: true },
    ]) {
      expect(() => asMineruOcrEnableInput(invalid)).toThrow('mineru_ocr_enable_input_invalid')
    }
  })

  it('exposes only status/enable/disable to the trusted shell renderer', async () => {
    const fixture = harness()
    await expect(
      fixture.handlers.get(MINERU_OCR_CHANNELS.status)!({ sender: fixture.trustedSender }),
    ).resolves.toEqual({ enabled: false, credential: 'missing' })
    await expect(
      fixture.handlers.get(MINERU_OCR_CHANNELS.disable)!({ sender: fixture.trustedSender }),
    ).resolves.toEqual({ enabled: false, credential: 'available' })
    expect(asMineruOcrStatus({ enabled: true, credential: 'available' })).toEqual({
      enabled: true,
      credential: 'available',
    })
    expect(() => asMineruOcrStatus({ enabled: true, credential: 'available', token: 'x' })).toThrow(
      'mineru_ocr_status_invalid',
    )
  })

  it('rejects untrusted or absent renderers before parsing secrets', async () => {
    const fixture = harness()
    for (const channel of Object.values(MINERU_OCR_CHANNELS)) {
      await expect(
        fixture.handlers.get(channel)!({ sender: {} }, { token: 'untrusted-canary' }),
      ).rejects.toThrow('permission_denied')
    }
    expect(fixture.service.status).not.toHaveBeenCalled()
    expect(fixture.service.enable).not.toHaveBeenCalled()
    expect(fixture.service.disable).not.toHaveBeenCalled()
  })
})
