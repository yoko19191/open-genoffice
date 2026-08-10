import type { Editor } from '@tiptap/core'
import type { ChartDisplay, NewChart } from '@genoffice/docx-engine'
import type { DocsOfficeImagePayload } from '../../shared/docs-office-tools'
import { t } from '../i18n/locale'
import { executeCommands, type Command, type CommandEnvelope } from './commands'
import {
  blockRangePositions,
  buildDocumentContext,
  insertBlocksAfter,
  isBlankDocument,
  isTrackedDeleted,
  parseHtmlFragment,
  replaceBlockRange,
  serializeRangeToHtml,
  type AiTrack,
  type NumIds,
} from './protocol'

/**
 * Local agent tools: a document-context reader plus a script-style execution
 * channel. The "execution backend" is the in-process ProseMirror doc, split
 * into three safe primitives plus the deterministic command engine.
 */

const READ_MAX_CHARS = 24_000

interface DocsToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolExecution {
  /** result text fed back to the model */
  output: string
  isError?: boolean
  /** true when the tool changed the document */
  mutated: boolean
  /** short human-readable label for the chat activity chip */
  summary: string
}

const fail = (summary: string, output: string): ToolExecution => ({
  output,
  isError: true,
  mutated: false,
  summary,
})

function rangeError(editor: Editor): string {
  return `block index invalid or out of range (the document has ${editor.state.doc.childCount} blocks); call get_document_context for fresh indexes`
}

function validRange(
  editor: Editor,
  start: unknown,
  end: unknown,
): { start: number; end: number } | null {
  const count = editor.state.doc.childCount
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const s = Number(start)
  const e = Number(end)
  // an out-of-range end must surface as an error, not silently clamp onto the wrong blocks
  if (s < 0 || e < s || e >= count) return null
  return { start: s, end: e }
}

function imageBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
  }
  return btoa(binary)
}

function insertArtifactImage(
  editor: Editor,
  call: DocsToolCall,
  image: DocsOfficeImagePayload | undefined,
  signal?: AbortSignal,
): ToolExecution {
  if (!image) return fail(t('aiSumInsertImage'), 'artifact bytes are unavailable')
  if (signal?.aborted)
    return fail(t('aiSumInsertImage'), 'stopped by the user; the image was not inserted')
  const maxWidth = Number(call.input.maxWidthPx) || 480
  const scale = Math.min(1, maxWidth / image.width)
  const width = Math.round(image.width * scale)
  const height = Math.round(image.height * scale)
  const base64 = imageBase64(image.bytes)
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'docProtected',
      attrs: {
        docxIndex: null,
        blockType: 'image',
        label: 'Image (generated)',
        imageDataUrl: `data:${image.mediaType};base64,${base64}`,
        imageWidthPx: width,
        imageHeightPx: height,
        genImage: { base64, mime: image.mediaType, widthPx: width, heightPx: height },
      },
    })
    .run()
  return {
    output: `Inserted the image (${width}×${height}px, sha256 ${image.sha256}).`,
    mutated: true,
    summary: t('aiSumInsertWebImage'),
  }
}

export function executeTool(
  editor: Editor,
  call: DocsToolCall,
  numIds: NumIds,
  track?: AiTrack,
  signal?: AbortSignal,
  image?: DocsOfficeImagePayload,
): ToolExecution {
  if (call.name === 'insert_image') return insertArtifactImage(editor, call, image, signal)
  return executeSyncTool(editor, call, numIds, track)
}

function executeSyncTool(
  editor: Editor,
  call: DocsToolCall,
  numIds: NumIds,
  track?: AiTrack,
): ToolExecution {
  switch (call.name) {
    case 'get_document_context':
      return {
        output: buildDocumentContext(editor),
        mutated: false,
        summary: t('aiSumReadDocContext'),
      }

    case 'read_blocks': {
      const range = validRange(editor, call.input.startBlockIndex, call.input.endBlockIndex)
      if (!range) return fail(t('aiSumReadBlocks'), rangeError(editor))
      const html = serializeRangeToHtml(editor, range.start, range.end)
      const offset = Math.max(0, Math.trunc(Number(call.input.offset)) || 0)
      if (offset > 0 && offset >= html.length) {
        return fail(
          t('aiSumReadBlocks'),
          `offset ${offset} is beyond the content (${html.length} characters in total)`,
        )
      }
      const slice = html.slice(offset, offset + READ_MAX_CHARS)
      const end = offset + slice.length
      const note =
        end < html.length
          ? `\n…(truncated: ${html.length} characters in total, call read_blocks again with offset=${end} to continue)`
          : offset > 0
            ? `\n(end of range: ${html.length} characters in total)`
            : ''
      let empty = '(range is empty)'
      if (!slice) {
        let deletedBlocks = 0
        for (let i = range.start; i <= range.end; i++) {
          if (isTrackedDeleted(editor.state.doc.child(i))) deletedBlocks++
        }
        if (deletedBlocks > 0) {
          empty = `(the ${deletedBlocks} block(s) in this range are pending tracked deletions — that text is already deleted and hidden from reads; do not delete or rewrite it again)`
        }
      }
      return {
        output: slice ? slice + note : empty,
        mutated: false,
        summary: t('aiSumReadBlocksRange', { start: range.start, end: range.end }),
      }
    }

    case 'insert_content': {
      const html = String(call.input.html ?? '')
      let nodes: ReturnType<typeof parseHtmlFragment>
      try {
        nodes = parseHtmlFragment(html, numIds)
      } catch (e) {
        return fail(t('aiSumInsertContent'), e instanceof Error ? e.message : String(e))
      }
      if (nodes.length === 0)
        return fail(t('aiSumInsertContent'), 'html did not parse into any content blocks')
      const count = editor.state.doc.childCount
      if (isBlankDocument(editor)) {
        // the blank template's single empty paragraph gets replaced
        replaceBlockRange(editor, 0, count - 1, nodes, track)
        return {
          output: `Inserted ${nodes.length} block(s) (the document was empty). Block indexes have changed; use get_document_context if needed.`,
          mutated: true,
          summary: t('aiSumInsertedBlocks', { count: nodes.length }),
        }
      }
      const cursorScope = call.input.afterBlockIndex === undefined
      const after = cursorScope
        ? getCursorBlockIndex(editor)
        : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1)
      if (!Number.isInteger(after)) return fail(t('aiSumInsertContent'), 'invalid afterBlockIndex')
      // -1 hits blockRangePositions' 0/0 default, i.e. insert at doc start
      insertBlocksAfter(editor, after, nodes, track)
      return {
        output: `Inserted ${nodes.length} block(s) after block ${after}. Subsequent block indexes have shifted; use get_document_context if needed.`,
        mutated: true,
        summary: t('aiSumInsertedBlocks', { count: nodes.length }),
      }
    }

    case 'replace_blocks': {
      const range = validRange(editor, call.input.startBlockIndex, call.input.endBlockIndex)
      if (!range) return fail(t('aiSumReplaceContent'), rangeError(editor))
      let nodes: ReturnType<typeof parseHtmlFragment>
      try {
        nodes = parseHtmlFragment(String(call.input.html ?? ''), numIds)
      } catch (e) {
        return fail(t('aiSumReplaceContent'), e instanceof Error ? e.message : String(e))
      }
      if (nodes.length === 0)
        return fail(t('aiSumReplaceContent'), 'html did not parse into any content blocks')
      replaceBlockRange(editor, range.start, range.end, nodes, track)
      return {
        output: `Replaced blocks ${range.start}-${range.end} with ${nodes.length} block(s). Block indexes have changed; use get_document_context if needed.`,
        mutated: true,
        summary: t('aiSumReplacedBlocks', { start: range.start, end: range.end }),
      }
    }

    case 'insert_chart': {
      const kind = String(call.input.kind ?? '') as NewChart['kind']
      if (!['bar', 'line', 'pie'].includes(kind))
        return fail(t('aiSumInsertChart'), 'kind must be one of bar/line/pie')
      const categories = Array.isArray(call.input.categories)
        ? (call.input.categories as unknown[]).map((c) => String(c ?? ''))
        : []
      const seriesIn = Array.isArray(call.input.series)
        ? (call.input.series as ReadonlyArray<{ name?: unknown; values?: unknown } | null>)
        : []
      if (!categories.length || !seriesIn.length)
        return fail(t('aiSumInsertChart'), 'categories and series must not be empty')
      const series = seriesIn.map((s, i) => {
        const values: unknown[] = Array.isArray(s?.values) ? s.values : []
        return {
          name: String(s?.name ?? `Series ${i + 1}`),
          values: categories.map((_, j) => {
            const v = values[j] ?? null
            const n = Number(v)
            return v != null && Number.isFinite(n) ? n : null
          }),
        }
      })
      const title = String(call.input.title ?? '').trim() || 'Chart title'
      const spec: NewChart = { kind, title, categories, series }
      const display: ChartDisplay = { partPath: '', kind, title, categories, series }
      const count = editor.state.doc.childCount
      const after =
        call.input.afterBlockIndex === undefined
          ? getCursorBlockIndex(editor)
          : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1)
      if (!Number.isInteger(after)) return fail(t('aiSumInsertChart'), 'invalid afterBlockIndex')
      const { to } = blockRangePositions(editor, after, after)
      editor
        .chain()
        .insertContentAt(to, {
          type: 'docProtected',
          attrs: {
            docxIndex: null,
            blockType: 'chart',
            label: 'Chart',
            genChart: spec,
            chartDisplay: display,
          },
        })
        .run()
      return {
        output: `Inserted a ${kind} chart "${title}" (${categories.length} categories × ${series.length} series).`,
        mutated: true,
        summary: t('aiSumInsertedChart', { title }),
      }
    }

    case 'edit_chart': {
      const idx = Number(call.input.blockIndex)
      if (!Number.isInteger(idx) || idx < 0 || idx >= editor.state.doc.childCount) {
        return fail(t('aiSumEditChart'), 'blockIndex invalid or out of range')
      }
      const node = editor.state.doc.child(idx)
      // native docx charts are passthrough blocks + chartDisplay; AI/UI-created ones are blockType 'chart'
      const display =
        node.type.name === 'docProtected' ? (node.attrs.chartDisplay as ChartDisplay | null) : null
      if (!display)
        return fail(
          t('aiSumEditChart'),
          `block ${idx} is not a chart (or the chart has no editable data cache)`,
        )
      const isNative = display.partPath !== '' // native chart part from docx: data-point structure is immutable
      const next: ChartDisplay = {
        ...display,
        categories: [...display.categories],
        series: display.series.map((s) => ({ ...s, values: [...s.values] })),
      }
      if (call.input.title !== undefined) next.title = String(call.input.title)
      if (call.input.categories !== undefined) {
        const cats = call.input.categories
        if (!Array.isArray(cats) || cats.length !== display.categories.length) {
          return fail(
            t('aiSumEditChart'),
            `categories must match the original category count (${display.categories.length})`,
          )
        }
        cats.forEach((c, i) => {
          if (c != null) next.categories[i] = String(c)
        })
      }
      const serIn = Array.isArray(call.input.series)
        ? (call.input.series as ReadonlyArray<{
            index?: unknown
            name?: unknown
            values?: unknown
          } | null>)
        : []
      for (const s of serIn) {
        const si = Number(s?.index)
        const orig = display.series[si]
        if (!Number.isInteger(si) || !orig)
          return fail(
            t('aiSumEditChart'),
            `series index ${s?.index} is invalid (${display.series.length} series in total)`,
          )
        if (s?.name !== undefined) next.series[si]!.name = String(s.name)
        if (s?.values !== undefined) {
          const values: unknown[] | null = Array.isArray(s.values) ? s.values : null
          if (!values || values.length !== orig.values.length) {
            return fail(
              t('aiSumEditChart'),
              `values of series ${si} must match the original series length (${orig.values.length})`,
            )
          }
          for (let j = 0; j < values.length; j++) {
            const v = values[j]
            if (v == null) continue
            const n = Number(v)
            if (!Number.isFinite(n))
              return fail(t('aiSumEditChart'), `value ${j} of series ${si} is not a number`)
            if (isNative && orig.values[j] == null) {
              return fail(
                t('aiSumEditChart'),
                `data point ${j} of series ${si} is empty in the original chart; empty points of a native chart cannot be written`,
              )
            }
            next.series[si]!.values[j] = n
          }
        }
      }
      // generated charts (genChart) update the spec in sync; the chart part is rebuilt from the new data on save
      const gen = node.attrs.genChart as NewChart | null
      const nextGen: NewChart | null = gen
        ? {
            ...gen,
            title: next.title ?? gen.title,
            categories: [...next.categories],
            series: next.series.map((s) => ({ name: s.name ?? '', values: [...s.values] })),
          }
        : null
      const { from } = blockRangePositions(editor, idx, idx)
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(from, undefined, {
          ...node.attrs,
          chartDisplay: next,
          genChart: nextGen,
        }),
      )
      return {
        output: `Updated the data of chart "${next.title ?? ''}" (changes are written back to the chart on save).`,
        mutated: true,
        summary: t('aiSumEditedChart', { index: idx }),
      }
    }

    case 'apply_commands': {
      const commands = call.input.commands
      if (!Array.isArray(commands) || commands.length === 0) {
        return fail(t('aiSumApplyCommands'), 'commands must be a non-empty array')
      }
      const envelope: CommandEnvelope = { commands: commands as Command[] }
      const outcome = executeCommands(editor, envelope, { numIds, track })
      if (!outcome.ok)
        return fail(t('aiSumApplyCommands'), outcome.error ?? 'command execution failed')
      const changed = outcome.results.reduce((sum, r) => sum + r.changed, 0)
      const skippedDeleted = outcome.results.reduce((sum, r) => sum + (r.skippedDeleted ?? 0), 0)
      // explicit model-facing note so it stops retrying deletions of already-deleted text
      const deletedNote =
        skippedDeleted > 0
          ? `\nNote: ${skippedDeleted} matched target(s) were skipped because that text is a pending tracked deletion (already struck through). It is not current content — do not try to delete or replace it again; the user accepts/rejects revisions in the Review tab.`
          : ''
      return {
        output: outcome.summary + deletedNote,
        mutated: changed > 0,
        summary: outcome.summary,
      }
    }

    default:
      return fail(call.name, `unknown tool: ${call.name}`)
  }
}

/** top-level index of the block containing the caret (doc end as fallback) */
function getCursorBlockIndex(editor: Editor): number {
  const { from } = editor.state.selection
  let result = editor.state.doc.childCount - 1
  let index = 0
  editor.state.doc.forEach((node, offset) => {
    if (from >= offset && from <= offset + node.nodeSize) result = index
    index++
  })
  return result
}
