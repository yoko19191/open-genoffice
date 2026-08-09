import { strFromU8, unzipSync } from 'fflate'

import { MineruError, assertHttpsUrl } from './mineru-client.mjs'

const DEFAULT_LIMITS = {
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntries: 4096,
}

function assertSafeEntryName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/u.test(name) ||
    name.split(/[\\/]/u).includes('..')
  )
    throw new MineruError('MinerU archive contains an unsafe path', { kind: 'archive' })
}

function inspectZip(bytes, limits, include) {
  let entries = 0
  let expandedBytes = 0
  try {
    return unzipSync(bytes, {
      filter(entry) {
        entries += 1
        assertSafeEntryName(entry.name)
        expandedBytes += entry.originalSize
        if (
          entries > limits.maxEntries ||
          entry.originalSize > limits.maxEntryBytes ||
          expandedBytes > limits.maxExpandedBytes
        )
          throw new MineruError('MinerU archive exceeds extraction limits', { kind: 'archive' })
        return include(entry.name)
      },
    })
  } catch (error) {
    if (error instanceof MineruError) throw error
    throw new MineruError('MinerU archive is not a valid ZIP file', { kind: 'archive' })
  }
}

export function validateDocx(docxBytes, limits = DEFAULT_LIMITS) {
  const files = inspectZip(
    docxBytes,
    limits,
    (name) => name === '[Content_Types].xml' || name === 'word/document.xml',
  )
  const contentTypes = files['[Content_Types].xml']
  const document = files['word/document.xml']
  if (!contentTypes || !document)
    throw new MineruError('MinerU DOCX is missing required OOXML parts', { kind: 'archive' })
  if (!strFromU8(contentTypes).includes('wordprocessingml.document.main+xml'))
    throw new MineruError('MinerU DOCX has an invalid content type manifest', { kind: 'archive' })
  if (!strFromU8(document).includes('<w:document'))
    throw new MineruError('MinerU DOCX has an invalid main document part', { kind: 'archive' })
  return docxBytes
}

export function selectDocxFromMineruArchive(archiveBytes, customLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits }
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.byteLength > limits.maxArchiveBytes)
    throw new MineruError('MinerU result archive exceeds download limits', { kind: 'archive' })
  const files = inspectZip(archiveBytes, limits, (name) => name.toLowerCase().endsWith('.docx'))
  const docxNames = Object.keys(files)
  if (docxNames.length !== 1)
    throw new MineruError('MinerU result must contain exactly one DOCX', { kind: 'archive' })
  return validateDocx(files[docxNames[0]], limits)
}

export async function downloadMineruDocx(resultUrl, { fetchImpl = fetch, signal, limits } = {}) {
  const exactUrl = assertHttpsUrl(resultUrl, 'MinerU result URL').toString()
  const response = await fetchImpl(exactUrl, { signal })
  if (!response.ok)
    throw new MineruError(`MinerU result download failed with HTTP ${response.status}`, {
      code: response.status,
      kind: response.status >= 500 ? 'service' : 'download',
      retriable: response.status >= 500 || response.status === 403,
    })
  const contentLength = Number(response.headers.get('content-length'))
  const maxArchiveBytes = limits?.maxArchiveBytes ?? DEFAULT_LIMITS.maxArchiveBytes
  if (Number.isFinite(contentLength) && contentLength > maxArchiveBytes)
    throw new MineruError('MinerU result archive exceeds download limits', { kind: 'archive' })
  return selectDocxFromMineruArchive(new Uint8Array(await response.arrayBuffer()), limits)
}
