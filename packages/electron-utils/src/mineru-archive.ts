import { strFromU8, unzipSync } from 'fflate'
import { MineruError, assertMineruHttpsUrl } from './mineru-client'

export type MineruArchiveLimits = {
  maxArchiveBytes: number
  maxEntryBytes: number
  maxExpandedBytes: number
  maxEntries: number
}

const DEFAULT_LIMITS: MineruArchiveLimits = {
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntries: 4096,
}

function limits(custom: Partial<MineruArchiveLimits> = {}): MineruArchiveLimits {
  return { ...DEFAULT_LIMITS, ...custom }
}

function safeName(name: string): void {
  if (
    !name ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/u.test(name) ||
    name.split(/[\\/]/u).includes('..')
  ) {
    throw new MineruError('mineru_archive_path_invalid', 'archive')
  }
}

function inspectCentralDirectory(bytes: Uint8Array, current: MineruArchiveLimits): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  const firstCandidate = Math.max(0, bytes.byteLength - 65_557)
  for (let offset = bytes.byteLength - 22; offset >= firstCandidate; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new MineruError('mineru_archive_invalid', 'archive')
  const entryCount = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  const centralOffset = view.getUint32(end + 16, true)
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== end
  ) {
    throw new MineruError('mineru_archive_invalid', 'archive')
  }
  if (entryCount > current.maxEntries) {
    throw new MineruError('mineru_archive_limit_exceeded', 'archive')
  }
  let cursor = centralOffset
  let expandedBytes = 0
  const decoder = new TextDecoder()
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new MineruError('mineru_archive_invalid', 'archive')
    }
    const originalSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const madeByOperatingSystem = view.getUint8(cursor + 5)
    const generalPurposeFlags = view.getUint16(cursor + 8, true)
    const externalAttributes = view.getUint32(cursor + 38, true)
    const localHeaderOffset = view.getUint32(cursor + 42, true)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > end) throw new MineruError('mineru_archive_invalid', 'archive')
    safeName(decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)))
    if (
      (generalPurposeFlags & 1) !== 0 ||
      localHeaderOffset + 4 > centralOffset ||
      view.getUint32(localHeaderOffset, true) !== 0x04034b50 ||
      (madeByOperatingSystem === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000)
    ) {
      throw new MineruError('mineru_archive_path_invalid', 'archive')
    }
    expandedBytes += originalSize
    if (originalSize > current.maxEntryBytes || expandedBytes > current.maxExpandedBytes) {
      throw new MineruError('mineru_archive_limit_exceeded', 'archive')
    }
    cursor = next
  }
  if (cursor !== end) throw new MineruError('mineru_archive_invalid', 'archive')
}

function inspect(
  bytes: Uint8Array,
  current: MineruArchiveLimits,
  include: (name: string) => boolean,
): Record<string, Uint8Array> {
  inspectCentralDirectory(bytes, current)
  try {
    return unzipSync(bytes, {
      filter: (entry) => include(entry.name),
    })
  } catch {
    throw new MineruError('mineru_archive_invalid', 'archive')
  }
}

export function validateDocx(
  docxBytes: Uint8Array,
  customLimits: Partial<MineruArchiveLimits> = {},
): Uint8Array {
  const files = inspect(docxBytes, limits(customLimits), (name) =>
    ['[Content_Types].xml', 'word/document.xml'].includes(name),
  )
  const contentTypes = files['[Content_Types].xml']
  const document = files['word/document.xml']
  if (!contentTypes || !document) {
    throw new MineruError('mineru_docx_parts_missing', 'archive')
  }
  if (!strFromU8(contentTypes).includes('wordprocessingml.document.main+xml')) {
    throw new MineruError('mineru_docx_content_type_invalid', 'archive')
  }
  if (!strFromU8(document).includes('<w:document')) {
    throw new MineruError('mineru_docx_main_invalid', 'archive')
  }
  return docxBytes
}

export function selectDocxFromMineruArchive(
  archiveBytes: Uint8Array,
  customLimits: Partial<MineruArchiveLimits> = {},
): Uint8Array {
  const current = limits(customLimits)
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.byteLength > current.maxArchiveBytes) {
    throw new MineruError('mineru_archive_limit_exceeded', 'archive')
  }
  const files = inspect(archiveBytes, current, (name) => name.toLowerCase().endsWith('.docx'))
  const names = Object.keys(files)
  if (names.length !== 1) throw new MineruError('mineru_docx_count_invalid', 'archive')
  return validateDocx(files[names[0]!]!, current)
}

export async function downloadMineruDocx(
  resultUrl: string,
  options: {
    fetch?: typeof globalThis.fetch
    signal?: AbortSignal
    limits?: Partial<MineruArchiveLimits>
  } = {},
): Promise<Uint8Array> {
  const fetch = options.fetch ?? globalThis.fetch
  const response = await fetch(assertMineruHttpsUrl(resultUrl), {
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) {
    const retriable = response.status >= 500 || response.status === 403
    throw new MineruError(
      'mineru_download_failed',
      response.status >= 500 ? 'service' : 'download',
      retriable,
    )
  }
  const current = limits(options.limits)
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > current.maxArchiveBytes) {
    throw new MineruError('mineru_archive_limit_exceeded', 'archive')
  }
  return selectDocxFromMineruArchive(new Uint8Array(await response.arrayBuffer()), current)
}
