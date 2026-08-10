export const MINERU_OCR_CHANNELS = Object.freeze({
  status: 'mineru-ocr:status',
  enable: 'mineru-ocr:enable',
  disable: 'mineru-ocr:disable',
})

export type MineruOcrStatusProjection = {
  enabled: boolean
  credential: 'available' | 'missing' | 'secure_storage_unavailable'
}

export type MineruOcrEnableInput = {
  disclosureAccepted: true
  token: string
}

export type MineruOcrApi = {
  status(): Promise<MineruOcrStatusProjection>
  enable(input: MineruOcrEnableInput): Promise<MineruOcrStatusProjection>
  disable(): Promise<MineruOcrStatusProjection>
}

export function asMineruOcrEnableInput(value: unknown): MineruOcrEnableInput {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { disclosureAccepted?: unknown }).disclosureAccepted !== true ||
    typeof (value as { token?: unknown }).token !== 'string' ||
    !(value as { token: string }).token.trim() ||
    Object.keys(value).some((key) => !['disclosureAccepted', 'token'].includes(key))
  ) {
    throw new Error('mineru_ocr_enable_input_invalid')
  }
  return { disclosureAccepted: true, token: (value as { token: string }).token }
}

export function asMineruOcrStatus(value: unknown): MineruOcrStatusProjection {
  if (!value || typeof value !== 'object') throw new Error('mineru_ocr_status_invalid')
  const status = value as Partial<MineruOcrStatusProjection>
  if (
    typeof status.enabled !== 'boolean' ||
    !['available', 'missing', 'secure_storage_unavailable'].includes(status.credential ?? '') ||
    Object.keys(value).some((key) => !['enabled', 'credential'].includes(key))
  ) {
    throw new Error('mineru_ocr_status_invalid')
  }
  return status as MineruOcrStatusProjection
}
