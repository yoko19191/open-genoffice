import {
  parseSheetsWorkbookCommandBatch,
  parseSheetsWorkbookOperation,
  type SheetsConditionalFormatRule,
  type SheetsDataValidationRule,
  type SheetsWorkbookCommandBatch,
  type SheetsWorkbookOperation,
} from '@genoffice/agent-runtime-protocol/sheets-workbook-schema'
import { columnIndex, columnLabel, formatAddress, parseRange, rangeCellCount } from './cell-address'
import { computeSortChanges } from './sort-range'

export type WorkbookOperation = SheetsWorkbookOperation
export type WorkbookCommandBatch = SheetsWorkbookCommandBatch
type OperationOf<Name extends WorkbookOperation['op']> = Extract<WorkbookOperation, { op: Name }>

export type SetCellOperation = OperationOf<'set_cell'>
export type SetRangeOperation = OperationOf<'set_range'>
export type SetFormulaOperation = OperationOf<'set_formula'>
export type ClearCellOperation = OperationOf<'clear_cell'>
export type FormatRangeOperation = OperationOf<'format_range'>
export type CellFormatPatch = FormatRangeOperation['format']
export type BorderPatch = NonNullable<CellFormatPatch['border']>
export type EditChartOperation = OperationOf<'edit_chart'>
export type AddChartOperation = OperationOf<'add_chart'>
export type AddShapeOperation = OperationOf<'add_shape'>
export type EditShapeOperation = OperationOf<'edit_shape'>
export type AddImageOperation = OperationOf<'add_image'>
export type AddTableOperation = OperationOf<'add_table'>
export type AddTableRowOperation = OperationOf<'add_table_row'>
export type AddTableColumnOperation = OperationOf<'add_table_column'>
export type DeleteTableRowOperation = OperationOf<'delete_table_row'>
export type DeleteTableColumnOperation = OperationOf<'delete_table_column'>
export type AddPivotOperation = OperationOf<'add_pivot'>
export type SetHyperlinkOperation = OperationOf<'set_hyperlink'>
export type AddConditionalFormatOperation = OperationOf<'add_conditional_format'>
export type SetDataValidationOperation = OperationOf<'set_data_validation'>
export type SetPageSetupOperation = OperationOf<'set_page_setup'>
export type CfRule = SheetsConditionalFormatRule
export type DvRule = SheetsDataValidationRule
export type DeleteVisualOperation = OperationOf<'delete_visual'>
export type DeleteTableOperation = OperationOf<'delete_table'>
export type AddSparklineOperation = OperationOf<'add_sparkline'>
export type FindReplaceOperation = OperationOf<'find_replace'>

export type StructuralOperation = OperationOf<
  | 'insert_rows'
  | 'delete_rows'
  | 'insert_cols'
  | 'delete_cols'
  | 'add_sheet'
  | 'delete_sheet'
  | 'duplicate_sheet'
  | 'set_sheet_hidden'
  | 'move_sheet'
>

/** sheet-layout edits: no address shifts, so they may mix with content ops */
export type LayoutOperation = OperationOf<
  | 'merge_cells'
  | 'unmerge_cells'
  | 'set_row_height'
  | 'set_col_width'
  | 'edit_chart'
  | 'add_chart'
  | 'add_shape'
  | 'edit_shape'
  | 'add_image'
  | 'add_table'
  | 'add_table_row'
  | 'add_table_column'
  | 'delete_table_row'
  | 'delete_table_column'
  | 'add_pivot'
  | 'set_rows_hidden'
  | 'set_cols_hidden'
  | 'set_hyperlink'
  | 'protect_sheet'
  | 'set_filter'
  | 'clear_filter'
  | 'set_filter_criteria'
  | 'add_conditional_format'
  | 'clear_conditional_formats'
  | 'set_data_validation'
  | 'add_defined_name'
  | 'delete_defined_name'
  | 'set_page_setup'
  | 'set_freeze'
  | 'set_note'
  | 'refresh_pivot'
  | 'delete_visual'
  | 'delete_table'
  | 'add_sparkline'
>

export type CellContentOperation = SetCellOperation | SetFormulaOperation | ClearCellOperation
/** what range ops expand into; the only shapes executors have to handle */
export type PrimitiveOperation =
  | CellContentOperation
  | FormatRangeOperation
  | LayoutOperation
  | StructuralOperation
  | OperationOf<'rename_sheet'>

const STRUCTURAL_OPS = new Set([
  'insert_rows',
  'delete_rows',
  'insert_cols',
  'delete_cols',
  'add_sheet',
  'delete_sheet',
  'duplicate_sheet',
  'set_sheet_hidden',
  'move_sheet',
])
const LAYOUT_OPS = new Set([
  'merge_cells',
  'unmerge_cells',
  'set_row_height',
  'set_col_width',
  'edit_chart',
  'add_chart',
  'add_shape',
  'edit_shape',
  'add_image',
  'add_table',
  'add_pivot',
  'add_table_row',
  'add_table_column',
  'delete_table_row',
  'delete_table_column',
  'set_rows_hidden',
  'set_cols_hidden',
  'set_hyperlink',
  'protect_sheet',
  'set_filter',
  'clear_filter',
  'set_filter_criteria',
  'add_conditional_format',
  'clear_conditional_formats',
  'set_data_validation',
  'add_defined_name',
  'delete_defined_name',
  'set_page_setup',
  'set_freeze',
  'set_note',
  'refresh_pivot',
  'delete_visual',
  'delete_table',
  'add_sparkline',
])
const CELL_CONTENT_OPS = new Set([
  'set_cell',
  'set_formula',
  'clear_cell',
  'set_range',
  'clear_range',
  'format_range',
  'sort_range',
  'find_replace',
  ...LAYOUT_OPS,
])

export function isStructuralOp(
  op: WorkbookOperation | PrimitiveOperation,
): op is StructuralOperation {
  return STRUCTURAL_OPS.has(op.op)
}

export function isLayoutOp(op: WorkbookOperation | PrimitiveOperation): op is LayoutOperation {
  return LAYOUT_OPS.has(op.op)
}

export const workbookOperationSchema = { parse: parseSheetsWorkbookOperation }
export const workbookCommandBatchSchema = { parse: parseSheetsWorkbookCommandBatch }

export function parseWorkbookCommandBatch(input: unknown): WorkbookCommandBatch {
  return parseSheetsWorkbookCommandBatch(input)
}

export const MAX_EXPANDED_CELL_OPS = 2000

function replaceOccurrences(
  text: string,
  find: string,
  replace: string,
  matchCase: boolean,
): string {
  if (matchCase) return text.split(find).join(replace)
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Callback form: a literal `$` in the replacement must stay literal.
  return text.replace(new RegExp(escaped, 'gi'), () => replace)
}

export type ExpandCellReader = (
  address: string,
  sheetId: string,
) => {
  value: string | number | boolean | null
  formula?: string | undefined
}

/// set_range guards, applied before any expansion. Jagged rows are rejected
/// because a shorter row silently leaves the old trailing cells in place —
/// the classic way a table rewrite shears its columns apart; requiring a
/// rectangle forces the writer to state the intended width (null clears a
/// cell). When the op targets a full `range`, its size must match the values
/// grid so misaligned writes fail before anything applies.
function setRangeOrigin(operation: SetRangeOperation): { startRow: number; startColumn: number } {
  const width = operation.values[0]?.length ?? 0
  const jaggedIndex = operation.values.findIndex((row) => row.length !== width)
  if (jaggedIndex !== -1) {
    throw new Error(
      `set_range values must be rectangular: row 1 has ${width} cell(s) but row ${jaggedIndex + 1} has ${operation.values[jaggedIndex]?.length}. ` +
        'Use null for cells that should be cleared, or split into separate set_range operations.',
    )
  }
  const { start, range } = operation
  if (!start && !range)
    throw new Error('set_range needs "start" — the top-left target cell, like "B2".')
  const bounds = parseRange(range ?? (start as string))
  if (start && range) {
    // Both fields together must agree; silently preferring one would let a
    // write land somewhere other than where the model believes it targeted.
    const startBounds = parseRange(start)
    if (
      startBounds.startRow !== bounds.startRow ||
      startBounds.startColumn !== bounds.startColumn
    ) {
      throw new Error(
        `set_range received both start ${start} and range ${range}, which disagree on the top-left cell — pass only one of them.`,
      )
    }
  }
  if (range) {
    const rows = bounds.endRow - bounds.startRow + 1
    const columns = bounds.endColumn - bounds.startColumn + 1
    if (rows !== operation.values.length || columns !== width) {
      throw new Error(
        `set_range range ${range} spans ${rows}×${columns} cells but values is ${operation.values.length} row(s) × ${width} cell(s) — ` +
          'make them match, or give "start" (the top-left cell) instead.',
      )
    }
  }
  return bounds
}

/// Expands set_range/clear_range into per-cell primitives so the preview,
/// CAS checks, and both apply paths keep working on single cells. sort_range
/// additionally needs `readCell` to compute the reordered values.
export function expandToPrimitiveOps(
  operations: readonly WorkbookOperation[],
  readCell?: ExpandCellReader,
): PrimitiveOperation[] {
  const expanded: PrimitiveOperation[] = []
  let cellOps = 0
  const countCell = (): void => {
    cellOps += 1
    if (cellOps > MAX_EXPANDED_CELL_OPS) {
      throw new Error(`The batch expands to more than ${MAX_EXPANDED_CELL_OPS} cell edits.`)
    }
  }
  for (const operation of operations) {
    if (operation.op === 'set_range') {
      const origin = setRangeOrigin(operation)
      operation.values.forEach((rowValues, rowOffset) => {
        rowValues.forEach((value, columnOffset) => {
          countCell()
          const address = formatAddress(
            origin.startRow + rowOffset,
            origin.startColumn + columnOffset,
          )
          if (typeof value === 'string' && value.startsWith('=')) {
            expanded.push({
              op: 'set_formula',
              sheetId: operation.sheetId,
              address,
              formula: value,
            })
          } else {
            expanded.push({ op: 'set_cell', sheetId: operation.sheetId, address, value })
          }
        })
      })
    } else if (operation.op === 'clear_range') {
      const bounds = parseRange(operation.range)
      if (rangeCellCount(bounds) > MAX_EXPANDED_CELL_OPS) {
        throw new Error(`The batch expands to more than ${MAX_EXPANDED_CELL_OPS} cell edits.`)
      }
      for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
        for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
          countCell()
          expanded.push({
            op: 'clear_cell',
            sheetId: operation.sheetId,
            address: formatAddress(row, column),
          })
        }
      }
    } else if (operation.op === 'format_range') {
      if (rangeCellCount(parseRange(operation.range)) > MAX_EXPANDED_CELL_OPS) {
        throw new Error(`format_range covers more than ${MAX_EXPANDED_CELL_OPS} cells.`)
      }
      expanded.push(operation)
    } else if (operation.op === 'find_replace') {
      if (!readCell)
        throw new Error('find_replace needs the current cell contents to plan against.')
      const bounds = parseRange(operation.range)
      if (rangeCellCount(bounds) > MAX_EXPANDED_CELL_OPS) {
        throw new Error(`find_replace covers more than ${MAX_EXPANDED_CELL_OPS} cells.`)
      }
      const matchCase = operation.matchCase ?? false
      const needle = matchCase ? operation.find : operation.find.toLowerCase()
      for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
        for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
          const address = formatAddress(row, column)
          const current = readCell(address, operation.sheetId)
          if (current.formula !== undefined || typeof current.value !== 'string') continue
          const haystack = matchCase ? current.value : current.value.toLowerCase()
          let next: string | null = null
          if (operation.wholeCell) {
            if (haystack === needle) next = operation.replace
          } else if (haystack.includes(needle)) {
            next = replaceOccurrences(current.value, operation.find, operation.replace, matchCase)
          }
          if (next === null || next === current.value) continue
          countCell()
          expanded.push({ op: 'set_cell', sheetId: operation.sheetId, address, value: next })
        }
      }
    } else if (operation.op === 'sort_range') {
      if (!readCell) throw new Error('sort_range needs the current cell contents to plan against.')
      if (rangeCellCount(parseRange(operation.range)) > MAX_EXPANDED_CELL_OPS) {
        throw new Error(`sort_range covers more than ${MAX_EXPANDED_CELL_OPS} cells.`)
      }
      const changes = computeSortChanges(
        {
          range: operation.range,
          byColumn: operation.byColumn,
          ascending: operation.order === 'asc',
          hasHeader: operation.hasHeader ?? false,
        },
        (address) => readCell(address, operation.sheetId),
      )
      for (const change of changes) {
        countCell()
        expanded.push({
          op: 'set_cell',
          sheetId: operation.sheetId,
          address: change.address,
          value: change.after,
          expectedValue: change.before,
        })
      }
    } else if (operation.op === 'add_pivot') {
      const columnFieldsArray =
        operation.columnField === undefined
          ? []
          : Array.isArray(operation.columnField)
            ? operation.columnField
            : [operation.columnField]
      if (columnFieldsArray.length > 0 && operation.values.length !== 1) {
        throw new Error('With a columnField the pivot supports exactly one values entry.')
      }
      if (new Set(columnFieldsArray).size !== columnFieldsArray.length) {
        throw new Error('columnField must not repeat a field.')
      }
      const rowFieldsArray = Array.isArray(operation.rowFields)
        ? operation.rowFields
        : [operation.rowFields]
      if (new Set(rowFieldsArray).size !== rowFieldsArray.length) {
        throw new Error('rowFields must not repeat a field.')
      }
      if (columnFieldsArray.some((field) => rowFieldsArray.includes(field))) {
        throw new Error('A field cannot be both a row and a column dimension.')
      }
      const allDimensionFields = [
        ...rowFieldsArray,
        ...columnFieldsArray,
        ...(operation.pageFields ?? []),
      ]
      if (operation.values.some((value) => allDimensionFields.includes(value.field))) {
        throw new Error('A values field cannot also be a row, column, or page filter field.')
      }
      // Calculated fields always aggregate with SUM (the formula operates on each
      // referenced field's in-group sum).
      if (operation.values.some((value) => value.formula !== undefined && value.agg !== 'sum')) {
        throw new Error('A calculated field must use agg "sum".')
      }
      // Grouping may only target row/column dimension fields, with at most one
      // rule per field.
      const axisFields = [...rowFieldsArray, ...columnFieldsArray]
      const groupedFields = (operation.groupings ?? []).map((grouping) => grouping.field)
      if (groupedFields.some((field) => !axisFields.includes(field))) {
        throw new Error('A grouping field must be a row or column dimension field.')
      }
      if (new Set(groupedFields).size !== groupedFields.length) {
        throw new Error('A field can only have one grouping rule.')
      }
      // Filters may only target row/column dimension fields, at most one per
      // field; value-filter params must be complete for the op, and the
      // referenced values entry must exist.
      const filteredFields = (operation.filters ?? []).map((filter) => filter.field)
      if (filteredFields.some((field) => !axisFields.includes(field))) {
        throw new Error('A filter field must be a row or column dimension field.')
      }
      if (new Set(filteredFields).size !== filteredFields.length) {
        throw new Error('A field can only have one filter.')
      }
      for (const filter of operation.filters ?? []) {
        if (filter.kind !== 'value') continue
        const valueIndex = filter.valueIndex ?? 0
        if (valueIndex >= operation.values.length) {
          throw new Error(`Filter valueIndex ${valueIndex} is out of range.`)
        }
        if (filter.op === 'top' && filter.count === undefined) {
          throw new Error('A top-N value filter needs "count".')
        }
        if (filter.op === 'greaterThan' && filter.from === undefined) {
          throw new Error('A greaterThan value filter needs "from".')
        }
        if (filter.op === 'between' && (filter.from === undefined || filter.to === undefined)) {
          throw new Error('A between value filter needs "from" and "to".')
        }
      }
      // Normalize rowFields → always array for downstream consumers
      expanded.push({
        ...operation,
        rowFields: rowFieldsArray,
      })
    } else if (operation.op === 'edit_shape') {
      if (
        operation.text === undefined &&
        operation.fillColor === undefined &&
        operation.anchorCell === undefined
      ) {
        throw new Error('edit_shape needs at least one of text / fillColor / anchorCell.')
      }
      expanded.push(operation)
    } else if (operation.op === 'edit_chart') {
      if (
        operation.title === undefined &&
        operation.chartType === undefined &&
        (!operation.seriesColors || Object.keys(operation.seriesColors).length === 0) &&
        operation.legend === undefined &&
        operation.axisTitles === undefined &&
        operation.dataLabels === undefined &&
        operation.grouping === undefined &&
        (!operation.seriesData || operation.seriesData.length === 0)
      ) {
        throw new Error(
          'edit_chart needs at least one of title / chartType / seriesColors / legend / dataLabels / grouping / axisTitles / seriesData.',
        )
      }
      for (const entry of operation.seriesData ?? []) {
        if (
          entry.name === undefined &&
          entry.valuesRange === undefined &&
          entry.categoriesRange === undefined
        ) {
          throw new Error(`seriesData[index=${entry.index}] needs a name or a data range.`)
        }
      }
      expanded.push(operation)
    } else if (operation.op === 'add_conditional_format') {
      const rule = operation.rule
      if (
        rule.kind === 'number' &&
        (rule.operator === 'between' || rule.operator === 'notBetween') &&
        rule.value2 === undefined
      ) {
        throw new Error(`add_conditional_format with operator "${rule.operator}" needs value2.`)
      }
      expanded.push(operation)
    } else if (operation.op === 'set_data_validation') {
      const rule = operation.validation
      if (rule?.kind === 'numberBetween' && rule.min > rule.max) {
        throw new Error('set_data_validation numberBetween needs min ≤ max.')
      }
      if (rule?.kind === 'dateBetween' && rule.start > rule.end) {
        throw new Error('set_data_validation dateBetween needs start ≤ end.')
      }
      expanded.push(operation)
    } else if (operation.op === 'set_page_setup') {
      const { op: _op, sheetId: _sheetId, ...settings } = operation
      if (Object.values(settings).every((value) => value === undefined)) {
        throw new Error('set_page_setup needs at least one setting.')
      }
      if (
        operation.scale !== undefined &&
        (operation.fitToWidth !== undefined || operation.fitToHeight !== undefined)
      ) {
        throw new Error('set_page_setup: scale and fitToWidth/fitToHeight are mutually exclusive.')
      }
      expanded.push(operation)
    } else {
      if (CELL_CONTENT_OPS.has(operation.op)) countCell()
      expanded.push(operation)
    }
  }
  return expanded
}

const FORMAT_FIELD_LABELS: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strikethrough',
  fontFamily: 'font',
  fontSize: 'font size',
  fontColor: 'font color',
  fillColor: 'fill',
  numberFormat: 'number format',
  horizontalAlign: 'align',
  verticalAlign: 'vertical align',
  wrapText: 'wrap',
  textRotation: 'rotation',
  indent: 'indent',
}

export function formatOpLabel(op: FormatRangeOperation): string {
  const parts = Object.entries(op.format)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const name = FORMAT_FIELD_LABELS[key] ?? key
      if (key === 'border') {
        const border = value as BorderPatch
        if (border.type === 'none') return 'clear borders'
        return `border ${border.type}${border.color ? ` ${border.color}` : ''}`
      }
      if (value === null) return `clear ${name}`
      if (value === true) return name
      if (value === false) return `no ${name}`
      return `${name} ${String(value)}`
    })
  return `${op.range}: ${parts.join(', ')}`
}

export function layoutOpLabel(op: LayoutOperation): string {
  switch (op.op) {
    case 'delete_visual':
      return `Delete visual ${op.visualId}`
    case 'delete_table':
      return `Delete table "${op.tableName}"`
    case 'add_sparkline':
      return `Insert ${op.type} sparklines for ${op.dataRange}`
    case 'merge_cells':
      return `Merge ${op.range}`
    case 'unmerge_cells':
      return `Unmerge ${op.range}`
    case 'set_row_height':
      return (op.count ?? 1) === 1
        ? `Set row ${op.row} height to ${op.heightPoints}pt`
        : `Set rows ${op.row}–${op.row + (op.count ?? 1) - 1} height to ${op.heightPoints}pt`
    case 'set_col_width':
      return (op.count ?? 1) === 1
        ? `Set column ${op.column} width to ${op.widthPx}px`
        : `Set columns ${op.column}–${columnLabel(columnIndex(op.column) + (op.count ?? 1) - 1)} width to ${op.widthPx}px`
    case 'edit_chart': {
      const parts: string[] = []
      if (op.title !== undefined) parts.push(`title "${op.title}"`)
      if (op.chartType !== undefined) parts.push(`type ${op.chartType}`)
      if (op.seriesColors && Object.keys(op.seriesColors).length > 0) {
        parts.push(
          `series colors ${Object.entries(op.seriesColors)
            .map(([i, c]) => `#${i}→${c}`)
            .join(', ')}`,
        )
      }
      if (op.legend !== undefined) {
        parts.push(op.legend === 'none' ? 'hide legend' : `legend ${op.legend}`)
      }
      if (op.axisTitles?.category !== undefined) {
        parts.push(
          op.axisTitles.category === null
            ? 'clear category-axis title'
            : `category axis "${op.axisTitles.category}"`,
        )
      }
      if (op.axisTitles?.value !== undefined) {
        parts.push(
          op.axisTitles.value === null
            ? 'clear value-axis title'
            : `value axis "${op.axisTitles.value}"`,
        )
      }
      for (const entry of op.seriesData ?? []) {
        const detail = [
          entry.name === undefined ? '' : `name "${entry.name}"`,
          entry.valuesRange === undefined ? '' : `values ${entry.valuesRange}`,
          entry.categoriesRange === undefined ? '' : `categories ${entry.categoriesRange}`,
        ]
          .filter(Boolean)
          .join(' ')
        parts.push(`series #${entry.index} ${detail}`)
      }
      return `Edit chart ${op.chartPath}: ${parts.join(', ')}`
    }
    case 'add_chart':
      return `Insert ${op.chartType} chart from ${op.dataRange}${op.title ? ` "${op.title}"` : ''}`
    case 'add_shape':
      return `Insert ${op.shapeType === 'textbox' ? 'text box' : `${op.shapeType} shape`} at ${op.anchorCell}`
    case 'edit_shape': {
      const parts = [
        op.text === undefined
          ? ''
          : `text "${op.text.length > 40 ? `${op.text.slice(0, 40)}…` : op.text}"`,
        op.fillColor === undefined ? '' : `fill ${op.fillColor}`,
        op.anchorCell === undefined ? '' : `move to ${op.anchorCell}`,
      ].filter(Boolean)
      return `Edit shape ${op.visualId}: ${parts.join(', ')}`
    }
    case 'add_image':
      return `Insert image artifact ${op.artifactId} at ${op.anchorCell}`
    case 'add_table':
      return `Create table${op.name ? ` ${op.name}` : ''} over ${op.range}`
    case 'add_table_row':
      return `Insert ${op.count ?? 1} row(s) into table ${op.tableName}${op.row !== undefined ? ` at position ${op.row}` : ' (append)'}`
    case 'add_table_column':
      return `Insert column "${op.columnName}" into table ${op.tableName}`
    case 'delete_table_row':
      return `Delete ${op.count ?? 1} row(s) from table ${op.tableName} at position ${op.row}`
    case 'delete_table_column':
      return `Delete ${op.count ?? 1} column(s) from table ${op.tableName} at position ${op.column}`
    case 'add_pivot': {
      const rowFieldsArray = Array.isArray(op.rowFields) ? op.rowFields : [op.rowFields]
      const columnFieldsArray =
        op.columnField === undefined
          ? []
          : Array.isArray(op.columnField)
            ? op.columnField
            : [op.columnField]
      return (
        `Create pivot${op.name ? ` ${op.name}` : ''} from ${op.sourceRange} ` +
        `(rows: ${rowFieldsArray.join(' > ')}${columnFieldsArray.length > 0 ? `, columns: ${columnFieldsArray.join(' > ')}` : ''}` +
        `${op.pageFields && op.pageFields.length > 0 ? `, filters: ${op.pageFields.join(', ')}` : ''}, ` +
        `values: ${op.values.map((value) => `${value.agg} ${value.field}`).join(', ')}) at ${op.targetCell}`
      )
    }
    case 'set_rows_hidden':
      return `${op.hidden ? 'Hide' : 'Unhide'} row${(op.count ?? 1) === 1 ? ` ${op.row}` : `s ${op.row}–${op.row + (op.count ?? 1) - 1}`}`
    case 'set_cols_hidden':
      return `${op.hidden ? 'Hide' : 'Unhide'} column${
        (op.count ?? 1) === 1
          ? ` ${op.column}`
          : `s ${op.column}–${columnLabel(columnIndex(op.column) + (op.count ?? 1) - 1)}`
      }`
    case 'set_hyperlink':
      return op.target === null
        ? `Remove link at ${op.address}`
        : `Link ${op.address} → ${op.target}`
    case 'protect_sheet':
      return op.protected ? 'Protect sheet' : 'Unprotect sheet'
    case 'set_filter':
      return `Add auto-filter on ${op.range}`
    case 'clear_filter':
      return 'Remove auto-filter'
    case 'set_filter_criteria':
      return op.values === null
        ? `Clear filter criteria on column ${op.column}`
        : `Filter column ${op.column} to ${op.values.length} value${op.values.length === 1 ? '' : 's'}`
    case 'add_conditional_format':
      return `Conditional format ${op.range}: ${cfRuleLabel(op.rule)}`
    case 'clear_conditional_formats':
      return 'Clear conditional formats'
    case 'set_data_validation':
      return op.validation === null
        ? `Clear data validation on ${op.range}`
        : `Data validation ${op.range}: ${dvRuleLabel(op.validation)}`
    case 'add_defined_name':
      return `Define name ${op.name} = ${op.ref}`
    case 'delete_defined_name':
      return `Delete defined name ${op.name}`
    case 'set_page_setup': {
      const parts: string[] = []
      if (op.orientation !== undefined) parts.push(op.orientation)
      if (op.paperSize !== undefined) parts.push(`paper ${op.paperSize}`)
      if (op.scale !== undefined) parts.push(`scale ${op.scale}%`)
      if (op.fitToWidth !== undefined) parts.push(`fit width ${op.fitToWidth || 'auto'}`)
      if (op.fitToHeight !== undefined) parts.push(`fit height ${op.fitToHeight || 'auto'}`)
      if (op.margins !== undefined) parts.push(`${op.margins} margins`)
      if (op.printGridlines !== undefined)
        parts.push(`${op.printGridlines ? 'print' : 'no'} gridlines`)
      if (op.printHeadings !== undefined)
        parts.push(`${op.printHeadings ? 'print' : 'no'} headings`)
      if (op.printArea !== undefined)
        parts.push(op.printArea === null ? 'clear print area' : `print area ${op.printArea}`)
      return `Page setup: ${parts.join(', ')}`
    }
    case 'set_freeze':
      return op.rows === 0 && op.columns === 0
        ? 'Unfreeze panes'
        : `Freeze ${[
            op.rows > 0 ? `first ${op.rows} row${op.rows === 1 ? '' : 's'}` : '',
            op.columns > 0 ? `first ${op.columns} column${op.columns === 1 ? '' : 's'}` : '',
          ]
            .filter(Boolean)
            .join(' and ')}`
    case 'set_note':
      return op.text === null
        ? `Remove note at ${op.address}`
        : `Note at ${op.address}: "${op.text.length > 60 ? `${op.text.slice(0, 60)}…` : op.text}"`
    case 'refresh_pivot':
      return 'Refresh pivot tables'
  }
}

function cfRuleLabel(rule: CfRule): string {
  switch (rule.kind) {
    case 'number':
      return `${rule.operator} ${rule.value}${rule.value2 === undefined ? '' : ` and ${rule.value2}`}`
    case 'text':
      return `${rule.operator} "${rule.text}"`
    case 'blank':
      return rule.blank ? 'is empty' : 'is not empty'
    case 'duplicate':
      return rule.unique ? 'unique values' : 'duplicate values'
    case 'top10':
      return `${rule.bottom ? 'bottom' : 'top'} ${rule.rank}${rule.percent ? '%' : ''}`
    case 'formula':
      return rule.formula
    case 'colorScale':
      return `color scale ${rule.minColor} → ${rule.maxColor}`
    case 'dataBar':
      return `data bar${rule.color ? ` ${rule.color}` : ''}`
  }
}

function dvRuleLabel(rule: DvRule): string {
  switch (rule.kind) {
    case 'list':
      return `list (${rule.values.slice(0, 5).join(', ')}${rule.values.length > 5 ? ', …' : ''})`
    case 'listRef':
      return `list from ${rule.range}`
    case 'numberBetween':
      return `number between ${rule.min} and ${rule.max}`
    case 'dateBetween':
      return `date between ${rule.start} and ${rule.end}`
    case 'checkbox':
      return 'checkbox'
    case 'formula':
      return `custom ${rule.formula}`
  }
}

export function structuralOpLabel(op: StructuralOperation): string {
  switch (op.op) {
    case 'insert_rows':
      return op.count === 1
        ? `Insert 1 row before row ${op.row}`
        : `Insert ${op.count} rows before row ${op.row}`
    case 'delete_rows':
      return op.count === 1
        ? `Delete row ${op.row}`
        : `Delete rows ${op.row}–${op.row + op.count - 1}`
    case 'insert_cols':
      return op.count === 1
        ? `Insert 1 column before column ${op.column}`
        : `Insert ${op.count} columns before column ${op.column}`
    case 'delete_cols':
      return op.count === 1
        ? `Delete column ${op.column}`
        : `Delete columns ${op.column}–${columnLabel(columnIndex(op.column) + op.count - 1)}`
    case 'add_sheet':
      return `Add sheet "${op.name}"`
    case 'delete_sheet':
      return `Delete sheet ${op.sheetId}`
    case 'duplicate_sheet':
      return `Duplicate sheet ${op.sheetId}${op.name ? ` as "${op.name}"` : ''}`
    case 'set_sheet_hidden':
      return `${op.hidden ? 'Hide' : 'Unhide'} sheet ${op.sheetId}`
    case 'move_sheet':
      return `Move sheet ${op.sheetId} to position ${op.position}`
  }
}
