import type { Lang } from '@genoffice/i18n'

export const PDF_CHANNELS = {
  consumePending: 'pdf:consume-pending',
  readFile: 'pdf:read-file',
  save: 'pdf:save',
  extractPages: 'pdf:extract-pages',
  insertPdf: 'pdf:insert-pdf',
  exportImages: 'pdf:export-images',
  dirtyChanged: 'pdf:dirty-changed',
  closeSaveRequest: 'pdf:close-save-request',
  closeSaveResult: 'pdf:close-save-result',
  saveAsRequest: 'pdf:save-as-request',
  saveAsResult: 'pdf:save-as-result',
  saveAsFlow: 'pdf:save-as-flow',
  getLanguage: 'app:get-language',
  languageChanged: 'app:language-changed',
  officeToolRequest: 'pdf:office-tool-request',
  officeToolResponse: 'pdf:office-tool-response',
} as const

export type MarkupType = 'highlight' | 'underline' | 'strikeout'

/** A text markup to write; quads are 4-point groups in PDF coords (y up) [x1,yTop,x2,yTop,x1,yBottom,x2,yBottom] */
export interface MarkupInput {
  pageIndex: number
  type: MarkupType
  /** rgb normalized to 0-1 */
  color: [number, number, number]
  quads: number[][]
}

/** Drawing annotations (all coords in PDF user space, y up).
    One union member per kind; a union-literal kind would break TS narrowing. */
interface DrawBase {
  pageIndex: number
  color: [number, number, number]
  width: number
}

export type DrawingInput =
  | (DrawBase & {
      kind: 'ink'
      /** Each stroke as [x1,y1,x2,y2,...] */
      paths: number[][]
    })
  | (DrawBase & { kind: 'rect'; rect: [number, number, number, number] })
  | (DrawBase & { kind: 'ellipse'; rect: [number, number, number, number] })
  | (DrawBase & { kind: 'line'; from: [number, number]; to: [number, number] })
  | (DrawBase & { kind: 'arrow'; from: [number, number]; to: [number, number] })
  | {
      /** Image signature/stamp placed by the user; written as a Stamp annotation */
      kind: 'image'
      pageIndex: number
      /** base64 PNG, without the data: prefix */
      image: string
      /** PDF user space [x1,y1,x2,y2] */
      rect: [number, number, number, number]
    }
  | {
      kind: 'note'
      pageIndex: number
      color: [number, number, number]
      at: [number, number]
      contents: string
    }

/**
 * Stamp layer (watermark/header/footer/page numbers all go through it).
 * The renderer rasterizes the bitmap via canvas (with rotation and fonts, bypassing
 * pdf-lib's lack of CJK support); the main process only embeds and positions it.
 */
export interface StampInput {
  pageIndex: number
  /** base64 PNG, without the data: prefix */
  image: string
  /** PDF user space [x1,y1,x2,y2] */
  rect: [number, number, number, number]
  opacity?: number
}

/** Document info; an empty string clears the field */
export interface MetadataInput {
  title?: string
  author?: string
  subject?: string
  keywords?: string
}

export interface FormValueInput {
  name: string
  kind: 'text' | 'checkbox' | 'radio' | 'choice'
  /** For radio: selected exportValue; for choice: selected option; empty string clears selection */
  value?: string
  checked?: boolean
}

export interface SavePdfRequest {
  path: string
  /**
   * Save As destination. When set, `path` is only read (source bytes) and the edited PDF
   * is written to this path instead — the original file must never be mutated.
   * Must match the target granted to the view by the main process (save dialog pick).
   */
  targetPath?: string
  markups: MarkupInput[]
  drawings: DrawingInput[]
  formValues: FormValueInput[]
  stamps: StampInput[]
  /** Page rotation deltas (original page index → multiple of 90 clockwise) */
  rotations?: { pageIndex: number; delta: number }[]
  /** Pages to delete (original page indices) */
  deletedPages?: number[]
  /** New page order (array of original page indices, excluding deleted); omitted if unreordered */
  pageOrder?: number[]
  metadata?: MetadataInput
}

export type SavePdfResult = { ok: true } | { ok: false; error: string }

export type PdfOfficeToolErrorCode =
  | 'invalid_tool_arguments'
  | 'stale_context'
  | 'read_only_document'
  | 'executor_unavailable'
  | 'unsupported_office_feature'
  | 'tool_failed'

export interface PdfOfficeEditSnapshot {
  markups: Array<{ id: string } & MarkupInput>
  drawings: Array<{ id: string; input: DrawingInput }>
  stampCfg: unknown | null
  formEdits: FormValueInput[]
  rotations: Array<[number, number]>
  deleted: number[]
  order: number[] | null
  metadata: MetadataInput | null
}

export interface PdfOfficeContextSnapshot {
  documentId: string
  contextVersion: string
  modelContent: string
  details: {
    fileName: string
    originalPageCount: number
    currentOriginalPage: number
    readOnly: boolean
    hasOutline: boolean
    deletionGeneration: number
  }
}

export type PdfOfficeToolRequest =
  | { requestId: string; kind: 'context'; documentId: string }
  | { requestId: string; kind: 'capture_snapshot'; documentId: string }
  | { requestId: string; kind: 'abort'; operationId: string; documentId: string }
  | {
      requestId: string
      kind: 'restore_snapshot'
      documentId: string
      snapshot: PdfOfficeEditSnapshot
    }
  | {
      requestId: string
      kind: 'execute'
      operationId: string
      documentId: string
      toolId: string
      input: unknown
      contextVersion?: string
    }

export type PdfOfficeToolResponse =
  | {
      requestId: string
      ok: true
      result:
        | { kind: 'context'; snapshot: PdfOfficeContextSnapshot }
        | { kind: 'snapshot'; snapshot: PdfOfficeEditSnapshot }
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
      errorCode: PdfOfficeToolErrorCode
      mutationOutcome?: 'not_started' | 'unknown'
    }

export interface PdfOfficeToolsApi {
  onRequest(handler: (request: PdfOfficeToolRequest) => Promise<PdfOfficeToolResponse>): () => void
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

function isEditSnapshot(value: unknown): value is PdfOfficeEditSnapshot {
  const snapshot = record(value)
  if (
    !snapshot ||
    !exactKeys(snapshot, [
      'markups',
      'drawings',
      'stampCfg',
      'formEdits',
      'rotations',
      'deleted',
      'order',
      'metadata',
    ])
  ) {
    return false
  }
  return (
    Array.isArray(snapshot.markups) &&
    Array.isArray(snapshot.drawings) &&
    Array.isArray(snapshot.formEdits) &&
    Array.isArray(snapshot.rotations) &&
    snapshot.rotations.every(
      (entry) =>
        Array.isArray(entry) && entry.length === 2 && entry.every((part) => Number.isInteger(part)),
    ) &&
    Array.isArray(snapshot.deleted) &&
    snapshot.deleted.every(Number.isInteger) &&
    (snapshot.order === null ||
      (Array.isArray(snapshot.order) && snapshot.order.every(Number.isInteger))) &&
    (snapshot.metadata === null || record(snapshot.metadata) !== undefined)
  )
}

function isContextSnapshot(value: unknown): value is PdfOfficeContextSnapshot {
  const snapshot = record(value)
  const details = record(snapshot?.details)
  return Boolean(
    snapshot &&
    exactKeys(snapshot, ['documentId', 'contextVersion', 'modelContent', 'details']) &&
    typeof snapshot.documentId === 'string' &&
    typeof snapshot.contextVersion === 'string' &&
    typeof snapshot.modelContent === 'string' &&
    details &&
    exactKeys(details, [
      'fileName',
      'originalPageCount',
      'currentOriginalPage',
      'readOnly',
      'hasOutline',
      'deletionGeneration',
    ]) &&
    typeof details.fileName === 'string' &&
    Number.isInteger(details.originalPageCount) &&
    Number.isInteger(details.currentOriginalPage) &&
    typeof details.readOnly === 'boolean' &&
    typeof details.hasOutline === 'boolean' &&
    Number.isInteger(details.deletionGeneration),
  )
}

export function isPdfOfficeToolRequest(value: unknown): value is PdfOfficeToolRequest {
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
      ['contextVersion'],
    ) &&
    typeof request.operationId === 'string' &&
    typeof request.toolId === 'string' &&
    (request.contextVersion === undefined || typeof request.contextVersion === 'string')
  )
}

export function isPdfOfficeToolResponse(value: unknown): value is PdfOfficeToolResponse {
  const response = record(value)
  if (!response || typeof response.requestId !== 'string' || response.requestId.length === 0) {
    return false
  }
  if (response.ok === false) {
    return (
      exactKeys(response, ['requestId', 'ok', 'errorCode'], ['mutationOutcome']) &&
      [
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

/** Extract pages into a new PDF: main process shows a save dialog; cancel returns canceled */
export interface ExtractPagesRequest {
  path: string
  /** Original page indices */
  pages: number[]
  suggestedName: string
}

export type ExtractPagesResult =
  { ok: true; savedPath: string } | { ok: true; canceled: true } | { ok: false; error: string }

/** Insert (merge) another PDF after a page of the current file: main process shows a picker and writes back immediately */
export interface InsertPdfRequest {
  path: string
  /** Insert after this original page index; -1 means front of the document */
  afterPageIndex: number
}

export type InsertPdfResult =
  { ok: true; insertedCount: number } | { ok: true; canceled: true } | { ok: false; error: string }

/** Export pages as PNG: renderer rasterizes the bitmaps, main process shows a dialog and writes to disk */
export interface ExportImagesRequest {
  /** base64 PNGs (without the data: prefix), in page order */
  images: string[]
  /** 1-based page numbers, same length as images, used for file names */
  pageNumbers: number[]
  baseName: string
}

export type ExportImagesResult =
  | { ok: true; savedDir: string; count: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

/** API exposed by preload to the renderer (window.pdfApi) */
export interface PdfApi {
  /** Take the pdf path pending for this view (queued at tab creation); null if none */
  consumePending(): Promise<string | null>
  /** Read pdf bytes. Only paths granted to this view are allowed */
  readFile(path: string): Promise<ArrayBuffer>
  /** Write markups/form values/page ops back to the original file (pdf-lib, content streams untouched); path grants same as readFile. With targetPath set (Save As), the original is only read and the result goes to targetPath */
  save(request: SavePdfRequest): Promise<SavePdfResult>
  extractPages(request: ExtractPagesRequest): Promise<ExtractPagesResult>
  insertPdf(request: InsertPdfRequest): Promise<InsertPdfResult>
  exportImages(request: ExportImagesRequest): Promise<ExportImagesResult>
  /** Mirror unsaved-changes state to the main process; drives the save prompt before closing a tab/window */
  setDirty(dirty: boolean): void
  /** Main process picked "Save" in the close prompt → renderer saves and replies via sendCloseSaveResult */
  onCloseSaveRequest(handler: () => void): () => void
  sendCloseSaveResult(ok: boolean): void
  /** Shell menu Save As → renderer writes pending edits to targetPath only (original untouched) and replies via sendSaveAsResult */
  onSaveAsRequest(handler: (targetPath: string) => void): () => void
  sendSaveAsResult(ok: boolean): void
  /** True while the shell's Save As flow (dialog included) is open — the renderer pauses autosave, since the dialog's window blur would otherwise trigger a save into the original */
  onSaveAsFlow(handler: (inFlight: boolean) => void): () => void
  getLanguage(): Promise<Lang>
  onLanguageChanged(handler: (lang: Lang) => void): () => void
}
