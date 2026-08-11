import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OutlineNode } from '../OutlinePanel'
import type { SearchIndex } from '../search'
import { searchInIndex } from '../search'
import type { FormValueInput, MarkupType } from '../../shared/ipc'
import type { PdfOfficeToolErrorCode } from '../../shared/ipc'
import { t } from '../i18n/locale'

type AgentToolCall = { name: string; input: Record<string, unknown> }
export type ToolExecution = {
  output: string
  summary: string
  isError?: boolean
  mutated?: boolean
  errorCode?: PdfOfficeToolErrorCode
}

/** Text cap per read_pages fed back to the model (the payload is resent in full each turn, so volume must be limited) */
const READ_CHUNK_CHARS = 24_000

/** Capability surface App provides to AI tools; all getters, since the loop outlives render closures */
export interface PdfAiDeps {
  doc(): PDFDocumentProxy | null
  fileName(): string
  pageCount(): number
  /** Original page number of the currently visible page (1-based) */
  currentPage(): number
  readOnly(): boolean
  outline(): OutlineNode[] | null
  searchIndex(): Promise<SearchIndex> | null
  isDeleted(origIdx: number): boolean
  /** Original page number → scroll to that page; returns false if the page was deleted */
  gotoPage(origPage: number): boolean
  addMarkup(type: MarkupType, origIdx: number, rects: [number, number, number, number][]): void
  formEdits(): ReadonlyMap<string, FormValueInput>
  applyFormEdit(v: FormValueInput): void
  rotatePage(origIdx: number, dir: 90 | -90): void
  deletePage(origIdx: number): boolean
}

const READONLY_OUTPUT =
  'The document is encrypted and read-only; it cannot be modified. Inform the user.'

function err(
  output: string,
  summary: string,
  errorCode: PdfOfficeToolErrorCode = 'invalid_tool_arguments',
): ToolExecution {
  return { output, isError: true, summary, errorCode }
}

function aborted(summary: string): ToolExecution {
  return err('Operation aborted', summary, 'tool_failed')
}

/** Validate a 1-based page number; returns the original page index or an error */
function resolvePage(deps: PdfAiDeps, raw: unknown): { origIdx: number } | { bad: string } {
  const page = Number(raw)
  if (!Number.isInteger(page) || page < 1 || page > deps.pageCount()) {
    return {
      bad: `Page number ${String(raw)} is out of range (document has ${deps.pageCount()} pages)`,
    }
  }
  if (deps.isDeleted(page - 1)) return { bad: `Page ${page} has been deleted (unsaved)` }
  return { origIdx: page - 1 }
}

async function readPages(
  deps: PdfAiDeps,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const doc = deps.doc()
  if (!doc)
    return err(
      'Document not ready',
      t('aiToolReadPages', { start: '?', end: '?' }),
      'executor_unavailable',
    )
  const start = Number(input.start)
  const end = Math.min(Number(input.end ?? start), start + 9)
  const summary = t('aiToolReadPages', { start, end })
  if (!Number.isInteger(start) || start < 1 || end < start || start > doc.numPages) {
    return err(`Invalid page range (document has ${doc.numPages} pages)`, summary)
  }
  let out = ''
  for (let n = start; n <= Math.min(end, doc.numPages); n++) {
    if (signal?.aborted) return aborted(summary)
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    if (signal?.aborted) return aborted(summary)
    let text = ''
    for (const item of content.items) {
      if ('str' in item) {
        text += item.str
        if (item.hasEOL) text += '\n'
      }
    }
    page.cleanup()
    out += `[Page ${n}]\n${text.trim()}\n\n`
    if (out.length > READ_CHUNK_CHARS) {
      out = `${out.slice(0, READ_CHUNK_CHARS)}\n… (truncated; read the rest in further calls)`
      break
    }
  }
  return {
    output: out.trim() || '(No extractable text in this range; the pages may be scanned images)',
    summary,
  }
}

async function searchText(
  deps: PdfAiDeps,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const query = String(input.query ?? '').trim()
  if (!query) return err('query must not be empty', t('aiToolSearch', { query: '', count: 0 }))
  const indexPromise = deps.searchIndex()
  if (!indexPromise)
    return err('Document not ready', t('aiToolSearch', { query, count: 0 }), 'executor_unavailable')
  const index = await indexPromise
  if (signal?.aborted) return aborted(t('aiToolSearch', { query, count: 0 }))
  const matches = searchInIndex(index, query)
  const lines: string[] = []
  for (const m of matches.slice(0, 40)) {
    const entry = index[m.pageIndex]!
    const pos = entry.lower.indexOf(query.toLowerCase())
    const from = Math.max(0, pos - 40)
    const snippet = entry.text.slice(from, pos + query.length + 40).replace(/\s+/g, ' ')
    lines.push(`Page ${m.pageIndex + 1}: …${snippet}…`)
  }
  if (matches.length > 40) lines.push(`(${matches.length} matches total; only the first 40 listed)`)
  return {
    output: lines.join('\n') || 'No matches found',
    summary: t('aiToolSearch', { query, count: matches.length }),
  }
}

async function markupText(
  deps: PdfAiDeps,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const type = String(input.type) as MarkupType
  const summary = t('aiToolMarkup', { page: Number(input.page) })
  if (deps.readOnly()) return err(READONLY_OUTPUT, summary, 'read_only_document')
  if (!['highlight', 'underline', 'strikeout'].includes(type))
    return err(`Invalid type: ${type}`, summary)
  const r = resolvePage(deps, input.page)
  if ('bad' in r) return err(r.bad, summary)
  const text = String(input.text ?? '').trim()
  if (!text) return err('text must not be empty', summary)
  const indexPromise = deps.searchIndex()
  if (!indexPromise) return err('Document not ready', summary, 'executor_unavailable')
  const index = await indexPromise
  if (signal?.aborted) return aborted(summary)
  const onPage = searchInIndex(index, text).filter((m) => m.pageIndex === r.origIdx)
  if (onPage.length === 0) {
    return err(
      `"${text}" not found on page ${r.origIdx + 1}; use read_pages to verify the exact text`,
      summary,
    )
  }
  const targets = input.all === true ? onPage : onPage.slice(0, 1)
  for (const m of targets) deps.addMarkup(type, r.origIdx, m.rects)
  deps.gotoPage(r.origIdx + 1)
  return {
    output: `Marked ${targets.length} occurrence(s) on page ${r.origIdx + 1} (unsaved; the user saves with ⌘S)`,
    mutated: true,
    summary,
  }
}

interface RawWidget {
  subtype?: string
  fieldType?: string
  fieldName?: string
  fieldValue?: unknown
  buttonValue?: string
  readOnly?: boolean
  checkBox?: boolean
  radioButton?: boolean
  options?: { exportValue?: unknown; displayValue?: unknown }[]
}

/** Whole-document form field inventory (radios aggregate exportValue lists by field name) */
async function collectFields(
  doc: PDFDocumentProxy,
): Promise<Map<string, { kind: string; page: number; value: string; options: string[] }>> {
  const fields = new Map<string, { kind: string; page: number; value: string; options: string[] }>()
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const annots = (await page.getAnnotations()) as RawWidget[]
    for (const a of annots) {
      if (a.subtype !== 'Widget' || !a.fieldName || a.readOnly) continue
      const value = Array.isArray(a.fieldValue)
        ? String(a.fieldValue[0] ?? '')
        : String(a.fieldValue ?? '')
      if (a.fieldType === 'Tx') {
        fields.set(a.fieldName, { kind: 'text', page: n, value, options: [] })
      } else if (a.fieldType === 'Btn' && a.checkBox) {
        fields.set(a.fieldName, { kind: 'checkbox', page: n, value, options: [] })
      } else if (a.fieldType === 'Btn' && a.radioButton) {
        const cur = fields.get(a.fieldName) ?? { kind: 'radio', page: n, value, options: [] }
        if (typeof a.buttonValue === 'string' && !cur.options.includes(a.buttonValue))
          cur.options.push(a.buttonValue)
        fields.set(a.fieldName, cur)
      } else if (a.fieldType === 'Ch') {
        fields.set(a.fieldName, {
          kind: 'choice',
          page: n,
          value,
          options: (a.options ?? [])
            .map((o) => String(o.exportValue ?? o.displayValue ?? ''))
            .filter(Boolean),
        })
      }
    }
  }
  return fields
}

async function listFormFields(deps: PdfAiDeps, signal?: AbortSignal): Promise<ToolExecution> {
  const doc = deps.doc()
  if (!doc)
    return err('Document not ready', t('aiToolFields', { count: 0 }), 'executor_unavailable')
  const fields = await collectFields(doc)
  if (signal?.aborted) return aborted(t('aiToolFields', { count: 0 }))
  const edits = deps.formEdits()
  const lines = [...fields].map(([name, f]) => {
    const edit = edits.get(name)
    const value = edit
      ? edit.kind === 'checkbox'
        ? String(!!edit.checked)
        : (edit.value ?? '')
      : f.value
    const opts = f.options.length > 0 ? ` options[${f.options.join(', ')}]` : ''
    return `${name} (${f.kind}, page ${f.page})${opts} current value: ${value || '(empty)'}`
  })
  return {
    output: lines.join('\n') || 'The document has no form fields',
    summary: t('aiToolFields', { count: fields.size }),
  }
}

async function fillFormField(
  deps: PdfAiDeps,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const name = String(input.name ?? '')
  const summary = t('aiToolFill', { name })
  if (deps.readOnly()) return err(READONLY_OUTPUT, summary, 'read_only_document')
  const doc = deps.doc()
  if (!doc || !name) return err('Document not ready or name is empty', summary)
  const fields = await collectFields(doc)
  if (signal?.aborted) return aborted(summary)
  const field = fields.get(name)
  if (!field)
    return err(`No field named "${name}"; use list_form_fields to see the fields`, summary)
  let edit: FormValueInput
  if (field.kind === 'checkbox') {
    if (typeof input.checked !== 'boolean')
      return err('Checkbox requires the checked parameter', summary)
    edit = { name, kind: 'checkbox', checked: input.checked }
  } else {
    const value = String(input.value ?? '')
    if (field.kind !== 'text' && value && !field.options.includes(value)) {
      return err(
        `Value "${value}" is not among the options: [${field.options.join(', ')}]`,
        summary,
      )
    }
    edit = { name, kind: field.kind as 'text' | 'radio' | 'choice', value }
  }
  deps.applyFormEdit(edit)
  deps.gotoPage(field.page)
  return { output: `Filled ${name} (unsaved; the user saves with ⌘S)`, mutated: true, summary }
}

export async function executePdfTool(
  deps: PdfAiDeps,
  call: AgentToolCall,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const input = call.input
  if (signal?.aborted) return aborted(call.name)
  switch (call.name) {
    case 'read_pages':
      return readPages(deps, input, signal)
    case 'search_text':
      return searchText(deps, input, signal)
    case 'goto_page': {
      const summary = t('aiToolGoto', { page: Number(input.page) })
      const r = resolvePage(deps, input.page)
      if ('bad' in r) return err(r.bad, summary)
      deps.gotoPage(r.origIdx + 1)
      return { output: `Jumped to page ${r.origIdx + 1}`, summary }
    }
    case 'markup_text':
      return markupText(deps, input, signal)
    case 'list_form_fields':
      return listFormFields(deps, signal)
    case 'fill_form_field':
      return fillFormField(deps, input, signal)
    case 'rotate_page': {
      const summary = t('aiToolRotate', { page: Number(input.page) })
      if (deps.readOnly()) return err(READONLY_OUTPUT, summary, 'read_only_document')
      const r = resolvePage(deps, input.page)
      if ('bad' in r) return err(r.bad, summary)
      deps.rotatePage(r.origIdx, input.direction === 'left' ? -90 : 90)
      deps.gotoPage(r.origIdx + 1)
      return { output: `Rotated page ${r.origIdx + 1} (unsaved)`, mutated: true, summary }
    }
    case 'delete_page': {
      const summary = t('aiToolDelete', { page: Number(input.page) })
      if (deps.readOnly()) return err(READONLY_OUTPUT, summary, 'read_only_document')
      const r = resolvePage(deps, input.page)
      if ('bad' in r) return err(r.bad, summary)
      if (!deps.deletePage(r.origIdx)) return err('At least one page must remain', summary)
      return {
        output: `Deleted page ${r.origIdx + 1} (unsaved; can be undone)`,
        mutated: true,
        summary,
      }
    }
    case 'get_outline': {
      const outline = deps.outline()
      const lines: string[] = []
      const walk = (nodes: OutlineNode[], depth: number) => {
        for (const n of nodes) {
          lines.push(`${'  '.repeat(depth)}${n.title}`)
          if (n.items) walk(n.items, depth + 1)
        }
      }
      if (outline) walk(outline, 0)
      return {
        output: lines.join('\n') || 'The document has no outline',
        summary: t('aiToolOutline'),
      }
    }
    default:
      return err(`Unknown tool: ${call.name}`, call.name, 'unsupported_office_feature')
  }
}
