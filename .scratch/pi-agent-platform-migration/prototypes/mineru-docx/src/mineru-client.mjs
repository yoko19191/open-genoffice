const DEFAULT_BASE_URL = 'https://mineru.net/api/v4'
const TERMINAL_STATES = new Set(['done', 'failed'])
const ACTIVE_STATES = new Set(['waiting-file', 'pending', 'running', 'converting', 'uploading'])

const ERROR_KINDS = new Map([
  ['A0202', ['authentication', false]],
  ['A0211', ['authentication', false]],
  ['-60012', ['not_found', false]],
  ['-60013', ['permission', false]],
  ['-60015', ['conversion', true]],
  ['-60016', ['conversion', true]],
  ['-60018', ['quota', true]],
])

export class MineruError extends Error {
  constructor(message, { code = 'unknown', kind = 'unknown', retriable = false } = {}) {
    super(message)
    this.name = 'MineruError'
    this.code = String(code)
    this.kind = kind
    this.retriable = retriable
  }
}

export function classifyMineruError(code) {
  const normalized = String(code)
  const known = ERROR_KINDS.get(normalized)
  if (known) return { code: normalized, kind: known[0], retriable: known[1] }
  if (normalized === '-500' || normalized === '-10002')
    return { code: normalized, kind: 'request', retriable: false }
  if (/^-(?:10001|6000[1-9]|6001[017]|6002[012])$/u.test(normalized))
    return { code: normalized, kind: 'service', retriable: true }
  return { code: normalized, kind: 'unknown', retriable: false }
}

export function assertHttpsUrl(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new MineruError(`${label} is not a valid URL`, { kind: 'protocol' })
  }
  if (url.protocol !== 'https:')
    throw new MineruError(`${label} must use HTTPS`, { kind: 'protocol' })
  return url
}

function assertApiBase(value) {
  const url = assertHttpsUrl(value, 'MinerU API base URL')
  if (url.hostname !== 'mineru.net' || url.pathname.replace(/\/$/u, '') !== '/api/v4')
    throw new MineruError('MinerU API base URL is not allowed', { kind: 'protocol' })
  return url.toString().replace(/\/$/u, '')
}

function throwForEnvelope(payload) {
  if (!payload || typeof payload !== 'object')
    throw new MineruError('MinerU returned an invalid JSON envelope', { kind: 'protocol' })
  if (payload.code === 0) return payload.data
  const details = classifyMineruError(payload.code ?? payload.msgCode)
  throw new MineruError(payload.msg || 'MinerU request failed', details)
}

async function parseJsonResponse(response, operation) {
  if (!response.ok)
    throw new MineruError(`${operation} failed with HTTP ${response.status}`, {
      code: response.status,
      kind: response.status >= 500 ? 'service' : 'request',
      retriable: response.status >= 500,
    })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new MineruError(`${operation} returned invalid JSON`, { kind: 'protocol' })
  }
  return throwForEnvelope(payload)
}

function normalizeBatchResult(data, expectedFileName) {
  if (!data || !Array.isArray(data.extract_result))
    throw new MineruError('MinerU batch result is malformed', { kind: 'protocol' })
  const matches = data.extract_result.filter((item) => item?.file_name === expectedFileName)
  if (matches.length !== 1)
    throw new MineruError('MinerU batch result did not contain exactly one requested file', {
      kind: 'protocol',
    })
  const result = matches[0]
  if (!TERMINAL_STATES.has(result.state) && !ACTIVE_STATES.has(result.state))
    throw new MineruError(`MinerU returned an unknown task state: ${result.state}`, {
      kind: 'protocol',
    })
  if (result.state === 'failed')
    throw new MineruError(result.err_msg || 'MinerU conversion failed', {
      code: result.err_code ?? 'conversion_failed',
      kind: 'conversion',
      retriable: true,
    })
  if (result.state === 'done') {
    const resultUrl = assertHttpsUrl(result.full_zip_url, 'MinerU result URL')
    return { state: 'done', resultUrl: resultUrl.toString() }
  }
  return {
    state: result.state,
    progress: result.extract_progress ?? null,
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

export function createMineruClient({ token, fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL }) {
  if (typeof token !== 'string' || token.length === 0)
    throw new MineruError('MinerU token is required', { kind: 'authentication' })
  const apiBase = assertApiBase(baseUrl)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  return {
    async requestLocalUpload(fileName, { dataId, signal } = {}) {
      assertNotAborted(signal)
      const response = await fetchImpl(`${apiBase}/file-urls/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          files: [{ name: fileName, ...(dataId ? { data_id: dataId } : {}) }],
          model_version: 'vlm',
          extra_formats: ['docx'],
        }),
        signal,
      })
      const data = await parseJsonResponse(response, 'MinerU upload allocation')
      if (
        typeof data?.batch_id !== 'string' ||
        !Array.isArray(data.file_urls) ||
        data.file_urls.length !== 1
      )
        throw new MineruError('MinerU upload allocation is malformed', { kind: 'protocol' })
      const uploadUrl = assertHttpsUrl(data.file_urls[0], 'MinerU signed upload URL')
      return { batchId: data.batch_id, uploadUrl: uploadUrl.toString() }
    },

    async upload(uploadUrl, pdfBytes, { signal } = {}) {
      assertNotAborted(signal)
      const exactUrl = assertHttpsUrl(uploadUrl, 'MinerU signed upload URL').toString()
      const response = await fetchImpl(exactUrl, {
        method: 'PUT',
        body: pdfBytes,
        signal,
      })
      if (!response.ok)
        throw new MineruError(`MinerU signed upload failed with HTTP ${response.status}`, {
          code: response.status,
          kind: response.status >= 500 ? 'service' : 'upload',
          retriable: response.status >= 500 || response.status === 403,
        })
    },

    async getBatchResult(batchId, fileName, { signal } = {}) {
      assertNotAborted(signal)
      const response = await fetchImpl(
        `${apiBase}/extract-results/batch/${encodeURIComponent(batchId)}`,
        { headers, signal },
      )
      const data = await parseJsonResponse(response, 'MinerU batch status')
      return normalizeBatchResult(data, fileName)
    },
  }
}

export async function waitForMineruResult(
  client,
  batchId,
  fileName,
  { signal, maxPolls = 120, wait = () => Promise.resolve() } = {},
) {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    assertNotAborted(signal)
    const result = await client.getBatchResult(batchId, fileName, { signal })
    if (result.state === 'done') return result.resultUrl
    await wait(result, poll)
  }
  throw new MineruError('MinerU conversion timed out locally; the remote task may still run', {
    kind: 'timeout',
    retriable: true,
  })
}
