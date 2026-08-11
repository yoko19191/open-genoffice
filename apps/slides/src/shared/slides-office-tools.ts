export const SLIDES_OFFICE_TOOL_CHANNELS = {
  request: 'slides:office-tool-request',
  response: 'slides:office-tool-response',
} as const

export type SlidesOfficeToolErrorCode =
  | 'artifact_invalid'
  | 'invalid_tool_arguments'
  | 'stale_context'
  | 'read_only_document'
  | 'executor_unavailable'
  | 'unsupported_office_feature'
  | 'tool_failed'

export interface SlidesOfficeEditSnapshot {
  token: string
}

export interface SlidesOfficeContextSnapshot {
  documentId: string
  contextVersion: string
  modelContent: string
  details: {
    slideCount: number
    currentSlide: number
    selectedIds: string[]
  }
}

export interface SlidesOfficeImagePayload {
  artifactId: string
  bytes: Uint8Array
  mediaType: 'image/png'
  width: number
  height: number
  sha256: string
}

export type SlidesOfficeToolRequest =
  | { requestId: string; kind: 'context'; documentId: string }
  | { requestId: string; kind: 'capture_snapshot'; documentId: string }
  | { requestId: string; kind: 'abort'; operationId: string; documentId: string }
  | {
      requestId: string
      kind: 'restore_snapshot'
      documentId: string
      snapshot: SlidesOfficeEditSnapshot
    }
  | {
      requestId: string
      kind: 'execute'
      operationId: string
      documentId: string
      toolId: string
      input: unknown
      contextVersion?: string
      snapshot?: SlidesOfficeEditSnapshot
      images?: SlidesOfficeImagePayload[]
    }

export type SlidesOfficeToolResponse =
  | {
      requestId: string
      ok: true
      result:
        | { kind: 'context'; snapshot: SlidesOfficeContextSnapshot }
        | { kind: 'snapshot'; snapshot: SlidesOfficeEditSnapshot }
        | { kind: 'restored'; contextVersion: string }
        | { kind: 'aborted'; aborted: boolean }
        | {
            kind: 'executed'
            output: string
            details?: unknown
            contextVersionAfter: string
            mutationOutcome?: 'not_started' | 'committed' | 'rolled_back'
          }
    }
  | {
      requestId: string
      ok: false
      errorCode: SlidesOfficeToolErrorCode
      mutationOutcome?: 'not_started' | 'unknown'
    }

export interface SlidesOfficeToolsApi {
  onRequest(
    handler: (request: SlidesOfficeToolRequest) => Promise<SlidesOfficeToolResponse>,
  ): () => void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  )
}

function isSnapshot(value: unknown): value is SlidesOfficeEditSnapshot {
  const snapshot = record(value)
  return Boolean(
    snapshot &&
    exactKeys(snapshot, ['token']) &&
    typeof snapshot.token === 'string' &&
    /^[0-9a-f-]{36}$/.test(snapshot.token),
  )
}

function isImage(value: unknown): value is SlidesOfficeImagePayload {
  const image = record(value)
  return Boolean(
    image &&
    exactKeys(image, ['artifactId', 'bytes', 'mediaType', 'width', 'height', 'sha256']) &&
    typeof image.artifactId === 'string' &&
    /^[0-9a-f-]{36}$/.test(image.artifactId) &&
    image.bytes instanceof Uint8Array &&
    image.bytes.byteLength > 0 &&
    image.bytes.byteLength <= 20 * 1024 * 1024 &&
    image.mediaType === 'image/png' &&
    Number.isInteger(image.width) &&
    Number(image.width) > 0 &&
    Number(image.width) <= 16_384 &&
    Number.isInteger(image.height) &&
    Number(image.height) > 0 &&
    Number(image.height) <= 16_384 &&
    typeof image.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(image.sha256),
  )
}

export function isSlidesOfficeToolRequest(value: unknown): value is SlidesOfficeToolRequest {
  const request = record(value)
  if (
    !request ||
    typeof request.requestId !== 'string' ||
    request.requestId.length === 0 ||
    typeof request.documentId !== 'string'
  ) {
    return false
  }
  if (request.kind === 'context' || request.kind === 'capture_snapshot') {
    return exactKeys(request, ['requestId', 'kind', 'documentId'])
  }
  if (request.kind === 'abort') {
    return (
      exactKeys(request, ['requestId', 'kind', 'operationId', 'documentId']) &&
      typeof request.operationId === 'string'
    )
  }
  if (request.kind === 'restore_snapshot') {
    return (
      exactKeys(request, ['requestId', 'kind', 'documentId', 'snapshot']) &&
      isSnapshot(request.snapshot)
    )
  }
  return (
    request.kind === 'execute' &&
    exactKeys(
      request,
      ['requestId', 'kind', 'operationId', 'documentId', 'toolId', 'input'],
      ['contextVersion', 'snapshot', 'images'],
    ) &&
    typeof request.operationId === 'string' &&
    typeof request.toolId === 'string' &&
    (request.contextVersion === undefined || typeof request.contextVersion === 'string') &&
    (request.snapshot === undefined || isSnapshot(request.snapshot)) &&
    (request.images === undefined ||
      (Array.isArray(request.images) &&
        request.images.length <= 20 &&
        request.images.every(isImage)))
  )
}

function isContext(value: unknown): value is SlidesOfficeContextSnapshot {
  const snapshot = record(value)
  const details = record(snapshot?.details)
  return Boolean(
    snapshot &&
    exactKeys(snapshot, ['documentId', 'contextVersion', 'modelContent', 'details']) &&
    typeof snapshot.documentId === 'string' &&
    typeof snapshot.contextVersion === 'string' &&
    typeof snapshot.modelContent === 'string' &&
    details &&
    exactKeys(details, ['slideCount', 'currentSlide', 'selectedIds']) &&
    Number.isInteger(details.slideCount) &&
    Number.isInteger(details.currentSlide) &&
    Array.isArray(details.selectedIds) &&
    details.selectedIds.every((id) => typeof id === 'string'),
  )
}

export function isSlidesOfficeToolResponse(value: unknown): value is SlidesOfficeToolResponse {
  const response = record(value)
  if (!response || typeof response.requestId !== 'string' || response.requestId.length === 0) {
    return false
  }
  if (response.ok === false) {
    return (
      exactKeys(response, ['requestId', 'ok', 'errorCode'], ['mutationOutcome']) &&
      [
        'artifact_invalid',
        'invalid_tool_arguments',
        'stale_context',
        'read_only_document',
        'executor_unavailable',
        'unsupported_office_feature',
        'tool_failed',
      ].includes(String(response.errorCode)) &&
      (response.mutationOutcome === undefined ||
        response.mutationOutcome === 'not_started' ||
        response.mutationOutcome === 'unknown')
    )
  }
  if (response.ok !== true || !exactKeys(response, ['requestId', 'ok', 'result'])) return false
  const result = record(response.result)
  if (!result) return false
  if (result.kind === 'context') {
    return exactKeys(result, ['kind', 'snapshot']) && isContext(result.snapshot)
  }
  if (result.kind === 'snapshot') {
    return exactKeys(result, ['kind', 'snapshot']) && isSnapshot(result.snapshot)
  }
  if (result.kind === 'restored') {
    return (
      exactKeys(result, ['kind', 'contextVersion']) && typeof result.contextVersion === 'string'
    )
  }
  if (result.kind === 'aborted') {
    return exactKeys(result, ['kind', 'aborted']) && typeof result.aborted === 'boolean'
  }
  return (
    result.kind === 'executed' &&
    exactKeys(result, ['kind', 'output', 'contextVersionAfter'], ['details', 'mutationOutcome']) &&
    typeof result.output === 'string' &&
    typeof result.contextVersionAfter === 'string' &&
    (result.mutationOutcome === undefined ||
      result.mutationOutcome === 'not_started' ||
      result.mutationOutcome === 'committed' ||
      result.mutationOutcome === 'rolled_back')
  )
}
