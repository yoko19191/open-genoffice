import {
  Type,
  type Static,
  type TObject,
  type TProperties,
  type TSchema,
  type TUnsafe,
} from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const strict = <Properties extends TProperties>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false })
const literals = <const Values extends readonly [string, ...string[]]>(values: Values) =>
  Type.Union(values.map((value) => Type.Literal(value))) as TUnsafe<Values[number]>
const nullable = <Schema extends TSchema>(schema: Schema) => Type.Union([schema, Type.Null()])
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength })
const integer = (minimum: number, maximum: number) => Type.Integer({ minimum, maximum })

const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
})
const sheetId = text(256)
const cellAddress = Type.String({ pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}$' })
const cellRange = Type.String({
  pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$',
})
const columnLabel = Type.String({ pattern: '^[A-Z]{1,3}$' })
const sheetName = Type.String({ minLength: 1, maxLength: 31, pattern: '^[^:\\\\/?*\\[\\]]+$' })
const hexColor = Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' })
const cellScalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])
const definedName = text(255)

const borderPatch = strict({
  type: literals(['all', 'top', 'bottom', 'left', 'right', 'none']),
  color: Type.Optional(hexColor),
})
const formatPatch = strict({
  bold: Type.Optional(nullable(Type.Boolean())),
  italic: Type.Optional(nullable(Type.Boolean())),
  underline: Type.Optional(nullable(Type.Boolean())),
  strikethrough: Type.Optional(nullable(Type.Boolean())),
  fontFamily: Type.Optional(nullable(text(128))),
  fontSize: Type.Optional(nullable(Type.Number({ minimum: 1, maximum: 409 }))),
  fontColor: Type.Optional(nullable(hexColor)),
  fillColor: Type.Optional(nullable(hexColor)),
  numberFormat: Type.Optional(nullable(text(255))),
  horizontalAlign: Type.Optional(nullable(literals(['left', 'center', 'right']))),
  verticalAlign: Type.Optional(nullable(literals(['top', 'center', 'bottom']))),
  wrapText: Type.Optional(nullable(Type.Boolean())),
  textRotation: Type.Optional(nullable(Type.Union([integer(-90, 90), Type.Literal('vertical')]))),
  indent: Type.Optional(nullable(integer(0, 250))),
  border: Type.Optional(borderPatch),
})

const cfFormat = strict({
  fillColor: Type.Optional(hexColor),
  fontColor: Type.Optional(hexColor),
  bold: Type.Optional(Type.Boolean()),
  italic: Type.Optional(Type.Boolean()),
})
export const SheetsConditionalFormatRuleSchema = Type.Union([
  strict({
    kind: Type.Literal('number'),
    operator: literals([
      'greaterThan',
      'greaterThanOrEqual',
      'lessThan',
      'lessThanOrEqual',
      'equal',
      'notEqual',
      'between',
      'notBetween',
    ]),
    value: Type.Number(),
    value2: Type.Optional(Type.Number()),
    format: cfFormat,
  }),
  strict({
    kind: Type.Literal('text'),
    operator: literals(['contains', 'notContains', 'beginsWith', 'endsWith']),
    text: text(255),
    format: cfFormat,
  }),
  strict({ kind: Type.Literal('blank'), blank: Type.Boolean(), format: cfFormat }),
  strict({
    kind: Type.Literal('duplicate'),
    unique: Type.Optional(Type.Boolean()),
    format: cfFormat,
  }),
  strict({
    kind: Type.Literal('top10'),
    rank: integer(1, 1_000),
    percent: Type.Optional(Type.Boolean()),
    bottom: Type.Optional(Type.Boolean()),
    format: cfFormat,
  }),
  strict({
    kind: Type.Literal('formula'),
    formula: Type.String({ pattern: '^=', maxLength: 8_192 }),
    format: cfFormat,
  }),
  strict({
    kind: Type.Literal('colorScale'),
    minColor: hexColor,
    midColor: Type.Optional(hexColor),
    maxColor: hexColor,
  }),
  strict({ kind: Type.Literal('dataBar'), color: Type.Optional(hexColor) }),
])

export const SheetsDataValidationRuleSchema = Type.Union([
  strict({
    kind: Type.Literal('list'),
    values: Type.Array(text(255), { minItems: 1, maxItems: 100 }),
  }),
  strict({ kind: Type.Literal('listRef'), range: cellRange }),
  strict({ kind: Type.Literal('numberBetween'), min: Type.Number(), max: Type.Number() }),
  strict({
    kind: Type.Literal('dateBetween'),
    start: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    end: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  }),
  strict({ kind: Type.Literal('checkbox') }),
  strict({
    kind: Type.Literal('formula'),
    formula: Type.String({ pattern: '^=', maxLength: 8_192 }),
  }),
])

const pivotValue = strict({
  field: text(255),
  agg: literals(['sum', 'count', 'average', 'max', 'min']),
  numFmt: Type.Optional(text(255)),
  showDataAs: Type.Optional(literals(['percentOfTotal', 'percentOfRow', 'percentOfCol'])),
  formula: Type.Optional(text(1_024)),
})
const pivotGrouping = Type.Union([
  strict({
    kind: Type.Literal('date'),
    field: text(255),
    dateUnit: literals(['year', 'quarter', 'month']),
  }),
  strict({
    kind: Type.Literal('range'),
    field: text(255),
    rangeStep: Type.Number({ exclusiveMinimum: 0 }),
    rangeStart: Type.Optional(Type.Number()),
  }),
])
const pivotFilter = Type.Union([
  strict({
    kind: Type.Literal('label'),
    field: text(255),
    op: literals(['equal', 'contains', 'beginsWith']),
    value: Type.String({ maxLength: 255 }),
  }),
  strict({
    kind: Type.Literal('value'),
    field: text(255),
    valueIndex: Type.Optional(integer(0, 7)),
    op: literals(['top', 'greaterThan', 'between']),
    count: Type.Optional(integer(1, 10_000)),
    from: Type.Optional(Type.Number()),
    to: Type.Optional(Type.Number()),
  }),
])

export const SHEETS_WORKBOOK_OPERATION_SCHEMAS = [
  strict({
    op: Type.Literal('set_cell'),
    sheetId,
    address: cellAddress,
    value: cellScalar,
    expectedValue: Type.Optional(cellScalar),
  }),
  strict({
    op: Type.Literal('set_formula'),
    sheetId,
    address: cellAddress,
    formula: Type.String({ pattern: '^=', maxLength: 8_192 }),
    expectedFormula: Type.Optional(Type.String()),
  }),
  strict({ op: Type.Literal('clear_cell'), sheetId, address: cellAddress }),
  strict({
    op: Type.Literal('set_range'),
    sheetId,
    start: Type.Optional(cellAddress),
    range: Type.Optional(cellRange),
    values: Type.Array(Type.Array(cellScalar, { minItems: 1, maxItems: 100 }), {
      minItems: 1,
      maxItems: 500,
    }),
  }),
  strict({ op: Type.Literal('clear_range'), sheetId, range: cellRange }),
  strict({ op: Type.Literal('format_range'), sheetId, range: cellRange, format: formatPatch }),
  strict({
    op: Type.Literal('sort_range'),
    sheetId,
    range: cellRange,
    byColumn: columnLabel,
    order: literals(['asc', 'desc']),
    hasHeader: Type.Optional(Type.Boolean()),
  }),
  strict({ op: Type.Literal('merge_cells'), sheetId, range: cellRange }),
  strict({ op: Type.Literal('unmerge_cells'), sheetId, range: cellRange }),
  strict({
    op: Type.Literal('set_row_height'),
    sheetId,
    row: integer(1, 9_999_999),
    count: Type.Optional(integer(1, 500)),
    heightPoints: Type.Number({ minimum: 2, maximum: 409 }),
  }),
  strict({
    op: Type.Literal('set_col_width'),
    sheetId,
    column: columnLabel,
    count: Type.Optional(integer(1, 100)),
    widthPx: Type.Number({ minimum: 10, maximum: 2_000 }),
  }),
  strict({
    op: Type.Literal('edit_chart'),
    chartPath: Type.String({
      pattern: '^(xl/charts/[A-Za-z0-9._-]+\\.xml|(added|demo)-chart-[A-Za-z0-9._-]+)$',
    }),
    title: Type.Optional(Type.String({ maxLength: 255 })),
    chartType: Type.Optional(literals(['column', 'bar', 'line', 'area', 'pie', 'doughnut'])),
    seriesColors: Type.Optional(Type.Record(Type.String({ pattern: '^[0-9]{1,3}$' }), hexColor)),
    legend: Type.Optional(literals(['none', 'right', 'bottom', 'top', 'left'])),
    dataLabels: Type.Optional(literals(['none', 'value', 'percent', 'category-percent'])),
    grouping: Type.Optional(literals(['clustered', 'stacked', 'percentStacked'])),
    axisTitles: Type.Optional(
      strict({
        category: Type.Optional(nullable(Type.String({ maxLength: 255 }))),
        value: Type.Optional(nullable(Type.String({ maxLength: 255 }))),
      }),
    ),
    seriesData: Type.Optional(
      Type.Array(
        strict({
          index: integer(0, 255),
          name: Type.Optional(Type.String({ maxLength: 255 })),
          valuesRange: Type.Optional(cellRange),
          categoriesRange: Type.Optional(cellRange),
          sheetId: Type.Optional(sheetId),
        }),
        { minItems: 1, maxItems: 24 },
      ),
    ),
  }),
  strict({
    op: Type.Literal('add_chart'),
    sheetId,
    chartType: literals([
      'column',
      'bar',
      'line',
      'area',
      'pie',
      'doughnut',
      'scatter',
      'radar',
      'combo',
    ]),
    dataRange: cellRange,
    title: Type.Optional(Type.String({ maxLength: 255 })),
    anchorCell: Type.Optional(cellAddress),
  }),
  strict({
    op: Type.Literal('add_shape'),
    sheetId,
    shapeType: literals([
      'rect',
      'roundRect',
      'snip1Rect',
      'snip2SameRect',
      'snip2DiagRect',
      'snipRoundRect',
      'round1Rect',
      'round2SameRect',
      'round2DiagRect',
      'ellipse',
      'triangle',
      'rtTriangle',
      'parallelogram',
      'trapezoid',
      'diamond',
      'pentagon',
      'hexagon',
      'octagon',
      'plus',
      'mathPlus',
      'pie',
      'chord',
      'teardrop',
      'frame',
      'halfFrame',
      'corner',
      'diagStripe',
      'donut',
      'noSmoking',
      'blockArc',
      'foldedCorner',
      'bevel',
      'cube',
      'can',
      'lightningBolt',
      'heart',
      'sun',
      'moon',
      'cloud',
      'arc',
      'plaque',
      'smileyFace',
      'leftBracket',
      'rightBracket',
      'leftBrace',
      'rightBrace',
      'rightArrow',
      'leftArrow',
      'upArrow',
      'downArrow',
      'leftRightArrow',
      'upDownArrow',
      'quadArrow',
      'bentArrow',
      'uturnArrow',
      'curvedRightArrow',
      'stripedRightArrow',
      'notchedRightArrow',
      'chevron',
      'homePlate',
      'star4',
      'star5',
      'star6',
      'star7',
      'star8',
      'star10',
      'star12',
      'star16',
      'star24',
      'star32',
      'irregularSeal1',
      'irregularSeal2',
      'ribbon',
      'ribbon2',
      'wave',
      'doubleWave',
      'flowChartProcess',
      'flowChartAlternateProcess',
      'flowChartDecision',
      'flowChartPredefinedProcess',
      'flowChartInternalStorage',
      'flowChartDocument',
      'flowChartMultidocument',
      'flowChartTerminator',
      'flowChartPreparation',
      'flowChartManualInput',
      'flowChartManualOperation',
      'flowChartConnector',
      'flowChartOffpageConnector',
      'flowChartMagneticDisk',
      'flowChartMagneticDrum',
      'flowChartDisplay',
      'flowChartDelay',
      'flowChartOr',
      'flowChartCollate',
      'flowChartSort',
      'flowChartExtract',
      'flowChartMerge',
      'flowChartSummingJunction',
      'flowChartPunchedTape',
      'wedgeRectCallout',
      'wedgeRoundRectCallout',
      'wedgeEllipseCallout',
      'cloudCallout',
      'textbox',
    ]),
    anchorCell: cellAddress,
    fillColor: Type.Optional(hexColor),
    text: Type.Optional(Type.String({ maxLength: 1_000 })),
  }),
  strict({
    op: Type.Literal('edit_shape'),
    visualId: text(128),
    text: Type.Optional(Type.String({ maxLength: 1_000 })),
    fillColor: Type.Optional(hexColor),
    anchorCell: Type.Optional(cellAddress),
  }),
  strict({ op: Type.Literal('add_image'), sheetId, artifactId: uuid, anchorCell: cellAddress }),
  strict({
    op: Type.Literal('add_table'),
    sheetId,
    range: cellRange,
    name: Type.Optional(definedName),
    style: Type.Optional(Type.String({ pattern: '^TableStyle(?:Light|Medium|Dark)[1-9][0-9]?$' })),
    bandedRows: Type.Optional(Type.Boolean()),
  }),
  strict({
    op: Type.Literal('add_table_row'),
    sheetId,
    tableName: text(255),
    row: Type.Optional(integer(1, 9_999_999)),
    count: Type.Optional(integer(1, 1_000)),
  }),
  strict({
    op: Type.Literal('add_table_column'),
    sheetId,
    tableName: text(255),
    column: Type.Optional(integer(1, 16_384)),
    columnName: text(255),
    count: Type.Optional(integer(1, 100)),
  }),
  strict({
    op: Type.Literal('delete_table_row'),
    sheetId,
    tableName: text(255),
    row: integer(1, 9_999_999),
    count: Type.Optional(integer(1, 1_000)),
  }),
  strict({
    op: Type.Literal('delete_table_column'),
    sheetId,
    tableName: text(255),
    column: integer(1, 16_384),
    count: Type.Optional(integer(1, 100)),
  }),
  strict({
    op: Type.Literal('add_pivot'),
    sheetId,
    sourceRange: cellRange,
    targetCell: cellAddress,
    targetSheetId: Type.Optional(sheetId),
    rowFields: Type.Union([text(255), Type.Array(text(255), { minItems: 1, maxItems: 8 })]),
    columnField: Type.Optional(
      Type.Union([text(255), Type.Array(text(255), { minItems: 1, maxItems: 8 })]),
    ),
    pageFields: Type.Optional(Type.Array(text(255), { maxItems: 4 })),
    values: Type.Array(pivotValue, { minItems: 1, maxItems: 8 }),
    groupings: Type.Optional(Type.Array(pivotGrouping, { maxItems: 8 })),
    filters: Type.Optional(Type.Array(pivotFilter, { maxItems: 8 })),
    name: Type.Optional(text(255)),
  }),
  strict({
    op: Type.Literal('set_rows_hidden'),
    sheetId,
    row: integer(1, 9_999_999),
    count: Type.Optional(integer(1, 10_000)),
    hidden: Type.Boolean(),
  }),
  strict({
    op: Type.Literal('set_cols_hidden'),
    sheetId,
    column: columnLabel,
    count: Type.Optional(integer(1, 1_000)),
    hidden: Type.Boolean(),
  }),
  strict({
    op: Type.Literal('set_hyperlink'),
    sheetId,
    address: cellAddress,
    target: nullable(text(2_048)),
  }),
  strict({ op: Type.Literal('protect_sheet'), sheetId, protected: Type.Boolean() }),
  strict({ op: Type.Literal('set_filter'), sheetId, range: cellRange }),
  strict({ op: Type.Literal('clear_filter'), sheetId }),
  strict({
    op: Type.Literal('set_filter_criteria'),
    sheetId,
    column: columnLabel,
    values: nullable(Type.Array(Type.String({ maxLength: 255 }), { minItems: 1, maxItems: 1_000 })),
  }),
  strict({
    op: Type.Literal('add_conditional_format'),
    sheetId,
    range: cellRange,
    rule: SheetsConditionalFormatRuleSchema,
  }),
  strict({ op: Type.Literal('clear_conditional_formats'), sheetId }),
  strict({
    op: Type.Literal('set_data_validation'),
    sheetId,
    range: cellRange,
    validation: nullable(SheetsDataValidationRuleSchema),
  }),
  strict({ op: Type.Literal('add_defined_name'), name: definedName, ref: text(8_192) }),
  strict({ op: Type.Literal('delete_defined_name'), name: text(255) }),
  strict({
    op: Type.Literal('set_page_setup'),
    sheetId,
    orientation: Type.Optional(literals(['portrait', 'landscape'])),
    paperSize: Type.Optional(integer(1, 118)),
    scale: Type.Optional(integer(10, 400)),
    fitToWidth: Type.Optional(integer(0, 1_000)),
    fitToHeight: Type.Optional(integer(0, 1_000)),
    margins: Type.Optional(literals(['normal', 'wide', 'narrow'])),
    printGridlines: Type.Optional(Type.Boolean()),
    printHeadings: Type.Optional(Type.Boolean()),
    printArea: Type.Optional(nullable(cellRange)),
  }),
  strict({
    op: Type.Literal('set_freeze'),
    sheetId,
    rows: integer(0, 100),
    columns: integer(0, 100),
  }),
  strict({
    op: Type.Literal('set_note'),
    sheetId,
    address: cellAddress,
    text: nullable(text(32_000)),
  }),
  strict({ op: Type.Literal('refresh_pivot'), sheetId }),
  strict({
    op: Type.Literal('insert_rows'),
    sheetId,
    row: integer(1, 9_999_999),
    count: integer(1, 500),
  }),
  strict({
    op: Type.Literal('delete_rows'),
    sheetId,
    row: integer(1, 9_999_999),
    count: integer(1, 500),
  }),
  strict({ op: Type.Literal('insert_cols'), sheetId, column: columnLabel, count: integer(1, 100) }),
  strict({ op: Type.Literal('delete_cols'), sheetId, column: columnLabel, count: integer(1, 100) }),
  strict({ op: Type.Literal('add_sheet'), name: sheetName }),
  strict({ op: Type.Literal('delete_sheet'), sheetId }),
  strict({ op: Type.Literal('duplicate_sheet'), sheetId, name: Type.Optional(sheetName) }),
  strict({ op: Type.Literal('set_sheet_hidden'), sheetId, hidden: Type.Boolean() }),
  strict({ op: Type.Literal('move_sheet'), sheetId, position: integer(1, 1_000) }),
  strict({ op: Type.Literal('rename_sheet'), sheetId, name: sheetName }),
  strict({ op: Type.Literal('delete_visual'), visualId: text(300) }),
  strict({ op: Type.Literal('delete_table'), sheetId, tableName: text(255) }),
  strict({
    op: Type.Literal('find_replace'),
    sheetId,
    range: cellRange,
    find: text(255),
    replace: Type.String({ maxLength: 255 }),
    matchCase: Type.Optional(Type.Boolean()),
    wholeCell: Type.Optional(Type.Boolean()),
  }),
  strict({
    op: Type.Literal('add_sparkline'),
    sheetId,
    type: literals(['line', 'column', 'stacked']),
    dataRange: cellRange,
    targetCell: Type.Optional(cellAddress),
    color: Type.Optional(hexColor),
  }),
] as const

export const SheetsWorkbookOperationSchema = Type.Union([...SHEETS_WORKBOOK_OPERATION_SCHEMAS])
export type SheetsWorkbookOperation = Static<typeof SheetsWorkbookOperationSchema>
export type SheetsConditionalFormatRule = Static<typeof SheetsConditionalFormatRuleSchema>
export type SheetsDataValidationRule = Static<typeof SheetsDataValidationRuleSchema>

export const SheetsWorkbookCommandBatchSchema = strict({
  dslVersion: Type.Literal(1),
  transactionId: text(128),
  baseRevision: Type.Integer({ minimum: 0 }),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
  operations: Type.Array(SheetsWorkbookOperationSchema, { minItems: 1, maxItems: 1_000 }),
})
export type SheetsWorkbookCommandBatch = Static<typeof SheetsWorkbookCommandBatchSchema>

export const SHEETS_WORKBOOK_OPERATION_NAMES = SHEETS_WORKBOOK_OPERATION_SCHEMAS.map(
  (schema) => schema.properties.op.const,
)

const structuralOperations = new Set([
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
const layoutOperations = new Set([
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
const cellOperations = new Set([
  'set_cell',
  'set_formula',
  'clear_cell',
  'set_range',
  'clear_range',
  'format_range',
  'sort_range',
  'find_replace',
  ...layoutOperations,
])
const defaultCount = new Set([
  'set_row_height',
  'set_col_width',
  'add_table_row',
  'add_table_column',
  'delete_table_row',
  'delete_table_column',
  'set_rows_hidden',
  'set_cols_hidden',
])

function hasValue(value: object): boolean {
  return Object.values(value).some((entry) => entry !== undefined)
}

function normalizeOperation(operation: SheetsWorkbookOperation): SheetsWorkbookOperation {
  const normalized = { ...operation } as SheetsWorkbookOperation & Record<string, unknown>
  if (defaultCount.has(operation.op) && normalized.count === undefined) normalized.count = 1
  if (operation.op === 'add_pivot') {
    if (operation.filters) {
      normalized.filters = operation.filters.map((filter) =>
        filter.kind === 'value' && filter.valueIndex === undefined
          ? { ...filter, valueIndex: 0 }
          : filter,
      )
    }
  }
  if ('name' in operation && typeof operation.name === 'string')
    normalized.name = operation.name.trim()
  return normalized
}

function assertOperationRefinements(operation: SheetsWorkbookOperation): void {
  const definedOperationName =
    operation.op === 'add_defined_name' || operation.op === 'add_table' ? operation.name : undefined
  if (
    definedOperationName !== undefined &&
    !/^[\p{L}_\\][\p{L}\p{N}_.\\]{0,254}$/u.test(definedOperationName)
  ) {
    throw new Error('invalid defined name')
  }
  if (
    operation.op === 'add_pivot' &&
    operation.name !== undefined &&
    !/^[\p{L}_\\][\p{L}\p{N}_.\\ ]{0,254}$/u.test(operation.name)
  ) {
    throw new Error('invalid pivot name')
  }
  if (
    operation.op === 'set_range' &&
    operation.start === undefined &&
    operation.range === undefined
  ) {
    throw new Error('set_range needs start or range')
  }
  if (operation.op === 'format_range' && !hasValue(operation.format)) {
    throw new Error('format must set at least one property')
  }
  if (
    operation.op === 'edit_shape' &&
    !hasValue({
      text: operation.text,
      fillColor: operation.fillColor,
      anchorCell: operation.anchorCell,
    })
  ) {
    throw new Error('edit_shape needs at least one of text / fillColor / anchorCell')
  }
  if (
    operation.op === 'edit_chart' &&
    !hasValue({
      title: operation.title,
      chartType: operation.chartType,
      seriesColors: operation.seriesColors,
      legend: operation.legend,
      dataLabels: operation.dataLabels,
      grouping: operation.grouping,
      axisTitles: operation.axisTitles,
      seriesData: operation.seriesData,
    })
  )
    throw new Error('edit_chart needs at least one property')
  if (
    operation.op === 'add_conditional_format' &&
    'format' in operation.rule &&
    !hasValue(operation.rule.format)
  ) {
    throw new Error('conditional format must set at least one property')
  }
  if (operation.op === 'set_page_setup') {
    const { op: _op, sheetId: _sheetId, ...settings } = operation
    if (!hasValue(settings)) throw new Error('set_page_setup needs at least one setting')
  }
}

export function parseSheetsWorkbookOperation(value: unknown): SheetsWorkbookOperation {
  if (!Value.Check(SheetsWorkbookOperationSchema, value)) {
    throw new Error('invalid_workbook_operation')
  }
  const normalized = normalizeOperation(value)
  if ('name' in normalized && typeof normalized.name === 'string' && normalized.name.length === 0) {
    throw new Error('invalid_workbook_operation')
  }
  assertOperationRefinements(normalized)
  return normalized
}

export function parseSheetsWorkbookCommandBatch(value: unknown): SheetsWorkbookCommandBatch {
  if (!Value.Check(SheetsWorkbookCommandBatchSchema, value)) {
    throw new Error('invalid_workbook_command_batch')
  }
  const summary = value.summary.trim()
  if (!summary) throw new Error('invalid_workbook_command_batch')
  const operations = value.operations.map(parseSheetsWorkbookOperation)
  const hasStructural = operations.some((operation) => structuralOperations.has(operation.op))
  const hasCell = operations.some((operation) => cellOperations.has(operation.op))
  if (hasStructural && hasCell) {
    throw new Error(
      'Structural operations (rows/columns/sheets) and cell edits must be proposed in separate batches.',
    )
  }
  return { ...value, summary, operations }
}

export function sheetsWorkbookOperationsInput(): TObject {
  return strict({
    summary: Type.String({ minLength: 1, maxLength: 500 }),
    operations: Type.Array(SheetsWorkbookOperationSchema, { minItems: 1, maxItems: 1_000 }),
  })
}
