export const DOCS_OFFICE_TOOL_CHANNELS = {
  request: 'docs:office-tool-request',
  response: 'docs:office-tool-response',
} as const

export type DocsOfficeToolErrorCode =
  | 'artifact_invalid'
  | 'invalid_tool_arguments'
  | 'stale_context'
  | 'read_only_document'
  | 'executor_unavailable'
  | 'unsupported_office_feature'
  | 'tool_failed'

export interface DocsOfficeEditSnapshot {
  doc: Record<string, unknown>
  selection: { from: number; to: number }
}

export interface DocsOfficeContextSnapshot {
  documentId: string
  contextVersion: string
  modelContent: string
  details: {
    blockCount: number
    selection: { from: number; to: number }
  }
}

export interface DocsOfficeImagePayload {
  bytes: Uint8Array
  mediaType: 'image/png'
  width: number
  height: number
  sha256: string
}

export type DocsOfficeToolRequest =
  | { requestId: string; kind: 'context'; documentId: string }
  | { requestId: string; kind: 'capture_snapshot'; documentId: string }
  | { requestId: string; kind: 'abort'; operationId: string; documentId: string }
  | {
      requestId: string
      kind: 'restore_snapshot'
      documentId: string
      snapshot: DocsOfficeEditSnapshot
    }
  | {
      requestId: string
      kind: 'execute'
      operationId: string
      documentId: string
      toolId: string
      input: unknown
      contextVersion?: string
      image?: DocsOfficeImagePayload
    }

export type DocsOfficeToolResponse =
  | {
      requestId: string
      ok: true
      result:
        | { kind: 'context'; snapshot: DocsOfficeContextSnapshot }
        | { kind: 'snapshot'; snapshot: DocsOfficeEditSnapshot }
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
      errorCode: DocsOfficeToolErrorCode
      mutationOutcome?: 'not_started' | 'unknown'
    }

export interface DocsOfficeToolsApi {
  onRequest(
    handler: (request: DocsOfficeToolRequest) => Promise<DocsOfficeToolResponse>,
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

function isSelection(value: unknown): value is { from: number; to: number } {
  const selection = record(value)
  return Boolean(
    selection &&
    exactKeys(selection, ['from', 'to']) &&
    Number.isInteger(selection.from) &&
    Number.isInteger(selection.to) &&
    Number(selection.from) >= 0 &&
    Number(selection.to) >= Number(selection.from),
  )
}

function isEditSnapshot(value: unknown): value is DocsOfficeEditSnapshot {
  const snapshot = record(value)
  return Boolean(
    snapshot &&
    exactKeys(snapshot, ['doc', 'selection']) &&
    record(snapshot.doc) &&
    isSelection(snapshot.selection) &&
    JSON.stringify(snapshot).length <= 16 * 1024 * 1024,
  )
}

function isContextSnapshot(value: unknown): value is DocsOfficeContextSnapshot {
  const snapshot = record(value)
  const details = record(snapshot?.details)
  return Boolean(
    snapshot &&
    exactKeys(snapshot, ['documentId', 'contextVersion', 'modelContent', 'details']) &&
    typeof snapshot.documentId === 'string' &&
    typeof snapshot.contextVersion === 'string' &&
    typeof snapshot.modelContent === 'string' &&
    details &&
    exactKeys(details, ['blockCount', 'selection']) &&
    Number.isInteger(details.blockCount) &&
    Number(details.blockCount) >= 0 &&
    isSelection(details.selection),
  )
}

function isImage(value: unknown): value is DocsOfficeImagePayload {
  const image = record(value)
  return Boolean(
    image &&
    exactKeys(image, ['bytes', 'mediaType', 'width', 'height', 'sha256']) &&
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

export function isDocsOfficeToolRequest(value: unknown): value is DocsOfficeToolRequest {
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
      isEditSnapshot(request.snapshot)
    )
  }
  return (
    request.kind === 'execute' &&
    exactKeys(
      request,
      ['requestId', 'kind', 'operationId', 'documentId', 'toolId', 'input'],
      ['contextVersion', 'image'],
    ) &&
    typeof request.operationId === 'string' &&
    typeof request.toolId === 'string' &&
    (request.contextVersion === undefined || typeof request.contextVersion === 'string') &&
    (request.image === undefined || isImage(request.image))
  )
}

export function isDocsOfficeToolResponse(value: unknown): value is DocsOfficeToolResponse {
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
    return exactKeys(result, ['kind', 'snapshot']) && isContextSnapshot(result.snapshot)
  }
  if (result.kind === 'snapshot') {
    return exactKeys(result, ['kind', 'snapshot']) && isEditSnapshot(result.snapshot)
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
