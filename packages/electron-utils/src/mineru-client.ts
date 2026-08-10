export type MineruErrorKind =
  | 'authentication'
  | 'quota'
  | 'conversion'
  | 'service'
  | 'request'
  | 'protocol'
  | 'upload'
  | 'download'
  | 'archive'
  | 'timeout'
  | 'unknown'

export class MineruError extends Error {
  constructor(
    public readonly code: string,
    public readonly kind: MineruErrorKind = 'unknown',
    public readonly retriable = false,
  ) {
    super(code)
    this.name = 'MineruError'
  }
}

const ERROR_KINDS = new Map<string, readonly [MineruErrorKind, boolean]>([
  ['A0202', ['authentication', false]],
  ['A0211', ['authentication', false]],
  ['-60012', ['request', false]],
  ['-60013', ['request', false]],
  ['-60015', ['conversion', true]],
  ['-60016', ['conversion', true]],
  ['-60018', ['quota', true]],
])

export function classifyMineruError(code: string | number): {
  code: string
  kind: MineruErrorKind
  retriable: boolean
} {
  const normalized = String(code)
  const known = ERROR_KINDS.get(normalized)
  if (known) return { code: normalized, kind: known[0], retriable: known[1] }
  if (normalized === '-500' || normalized === '-10002') {
    return { code: normalized, kind: 'request', retriable: false }
  }
  if (/^-(?:10001|6000[1-9]|6001[017]|6002[012])$/u.test(normalized)) {
    return { code: normalized, kind: 'service', retriable: true }
  }
  return { code: normalized, kind: 'unknown', retriable: false }
}

function httpsUrl(value: unknown): string {
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new MineruError('mineru_url_invalid', 'protocol')
  }
  if (url.protocol !== 'https:') throw new MineruError('mineru_url_invalid', 'protocol')
  return url.toString()
}

function apiBase(value: string): string {
  const exact = new URL(httpsUrl(value))
  if (exact.hostname !== 'mineru.net' || exact.pathname.replace(/\/$/u, '') !== '/api/v4') {
    throw new MineruError('mineru_api_origin_invalid', 'protocol')
  }
  return exact.toString().replace(/\/$/u, '')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function responseData(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const retriable = response.status >= 500
    throw new MineruError('mineru_request_failed', retriable ? 'service' : 'request', retriable)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new MineruError('mineru_response_invalid', 'protocol')
  }
  const envelope = record(payload)
  if (!envelope) throw new MineruError('mineru_response_invalid', 'protocol')
  if (envelope.code !== 0) {
    const classified = classifyMineruError(String(envelope.code ?? envelope.msgCode))
    throw new MineruError('mineru_request_failed', classified.kind, classified.retriable)
  }
  const data = record(envelope.data)
  if (!data) throw new MineruError('mineru_response_invalid', 'protocol')
  return data
}

const ACTIVE_STATES = new Set([
  'waiting-file',
  'pending',
  'running',
  'converting',
  'uploading',
] as const)
export type MineruActiveState = 'waiting-file' | 'pending' | 'running' | 'converting' | 'uploading'
export type MineruBatchProjection =
  { state: MineruActiveState } | { state: 'done'; resultUrl: string }

export type MineruClient = {
  requestLocalUpload(
    fileName: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ batchId: string; uploadUrl: string }>
  upload(uploadUrl: string, pdfBytes: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>
  getBatchResult(
    batchId: string,
    fileName: string,
    options?: { signal?: AbortSignal },
  ): Promise<MineruBatchProjection>
}

export function createMineruClient(options: {
  token: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}): MineruClient {
  if (!options.token) throw new MineruError('mineru_credential_missing', 'authentication')
  const fetch = options.fetch ?? globalThis.fetch
  const base = apiBase(options.baseUrl ?? 'https://mineru.net/api/v4')
  const headers = {
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
  }
  return {
    async requestLocalUpload(fileName, requestOptions = {}) {
      requestOptions.signal?.throwIfAborted()
      const data = await responseData(
        await fetch(`${base}/file-urls/batch`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            files: [{ name: fileName }],
            model_version: 'vlm',
            extra_formats: ['docx'],
          }),
          signal: requestOptions.signal,
        }),
      )
      if (
        typeof data.batch_id !== 'string' ||
        !Array.isArray(data.file_urls) ||
        data.file_urls.length !== 1
      ) {
        throw new MineruError('mineru_response_invalid', 'protocol')
      }
      return { batchId: data.batch_id, uploadUrl: httpsUrl(data.file_urls[0]) }
    },
    async upload(uploadUrl, pdfBytes, requestOptions = {}) {
      requestOptions.signal?.throwIfAborted()
      const response = await fetch(httpsUrl(uploadUrl), {
        method: 'PUT',
        body: new Uint8Array(pdfBytes),
        signal: requestOptions.signal,
      })
      if (!response.ok) {
        const retriable = response.status >= 500 || response.status === 403
        throw new MineruError(
          'mineru_upload_failed',
          response.status >= 500 ? 'service' : 'upload',
          retriable,
        )
      }
    },
    async getBatchResult(batchId, fileName, requestOptions = {}) {
      requestOptions.signal?.throwIfAborted()
      const data = await responseData(
        await fetch(`${base}/extract-results/batch/${encodeURIComponent(batchId)}`, {
          headers,
          signal: requestOptions.signal,
        }),
      )
      if (!Array.isArray(data.extract_result)) {
        throw new MineruError('mineru_response_invalid', 'protocol')
      }
      const matches = data.extract_result
        .map(record)
        .filter((item): item is Record<string, unknown> => item?.file_name === fileName)
      if (matches.length !== 1) throw new MineruError('mineru_response_invalid', 'protocol')
      const result = matches[0]!
      if (result.state === 'failed') {
        throw new MineruError('mineru_conversion_failed', 'conversion', true)
      }
      if (result.state === 'done') {
        return { state: 'done', resultUrl: httpsUrl(result.full_zip_url) }
      }
      if (
        typeof result.state !== 'string' ||
        !ACTIVE_STATES.has(result.state as MineruActiveState)
      ) {
        throw new MineruError('mineru_response_invalid', 'protocol')
      }
      return { state: result.state as MineruActiveState }
    },
  }
}

export async function waitForMineruResult(
  client: Pick<MineruClient, 'getBatchResult'>,
  batchId: string,
  fileName: string,
  options: {
    signal?: AbortSignal
    maxPolls?: number
    wait?: (projection: { state: MineruActiveState }, poll: number) => Promise<void>
  } = {},
): Promise<string> {
  const maxPolls = options.maxPolls ?? 120
  const wait = options.wait ?? (() => Promise.resolve())
  for (let poll = 0; poll < maxPolls; poll += 1) {
    options.signal?.throwIfAborted()
    const projection = await client.getBatchResult(batchId, fileName, {
      signal: options.signal,
    })
    if (projection.state === 'done') return projection.resultUrl
    await wait(projection, poll)
  }
  throw new MineruError('mineru_timeout', 'timeout', true)
}

export function assertMineruHttpsUrl(value: unknown): string {
  return httpsUrl(value)
}
