import { describe, expect, it } from 'vitest'
import {
  SHEETS_WORKBOOK_OPERATION_NAMES,
  parseSheetsWorkbookCommandBatch,
  parseSheetsWorkbookOperation,
} from '../src/sheets-workbook-schema'

const artifactId = '11111111-1111-4111-8111-111111111111'

const acceptedOperations: unknown[] = [
  { op: 'set_cell', sheetId: 's', address: 'A1', value: 1 },
  { op: 'set_formula', sheetId: 's', address: 'A2', formula: '=A1*2' },
  { op: 'clear_cell', sheetId: 's', address: 'A3' },
  { op: 'set_range', sheetId: 's', start: 'A1', values: [[1, 2]] },
  { op: 'clear_range', sheetId: 's', range: 'A1:B2' },
  { op: 'format_range', sheetId: 's', range: 'A1', format: { bold: true } },
  { op: 'sort_range', sheetId: 's', range: 'A1:B2', byColumn: 'A', order: 'asc' },
  { op: 'merge_cells', sheetId: 's', range: 'A1:B1' },
  { op: 'unmerge_cells', sheetId: 's', range: 'A1:B1' },
  { op: 'set_row_height', sheetId: 's', row: 1, heightPoints: 20 },
  { op: 'set_col_width', sheetId: 's', column: 'A', widthPx: 100 },
  { op: 'edit_chart', chartPath: 'xl/charts/chart1.xml', title: 'Revenue' },
  { op: 'add_chart', sheetId: 's', chartType: 'column', dataRange: 'A1:B2' },
  { op: 'add_shape', sheetId: 's', shapeType: 'rect', anchorCell: 'A1' },
  { op: 'edit_shape', visualId: 'shape-1', text: 'Updated' },
  { op: 'add_image', sheetId: 's', artifactId, anchorCell: 'B2' },
  { op: 'add_table', sheetId: 's', range: 'A1:B2', name: 'Sales' },
  { op: 'add_table_row', sheetId: 's', tableName: 'Sales' },
  { op: 'add_table_column', sheetId: 's', tableName: 'Sales', columnName: 'Total' },
  { op: 'delete_table_row', sheetId: 's', tableName: 'Sales', row: 1 },
  { op: 'delete_table_column', sheetId: 's', tableName: 'Sales', column: 1 },
  {
    op: 'add_pivot',
    sheetId: 's',
    sourceRange: 'A1:B2',
    targetCell: 'D1',
    rowFields: 'Region',
    values: [{ field: 'Revenue', agg: 'sum' }],
    filters: [{ kind: 'value', field: 'Region', op: 'top', count: 5 }],
  },
  { op: 'set_rows_hidden', sheetId: 's', row: 2, hidden: true },
  { op: 'set_cols_hidden', sheetId: 's', column: 'B', hidden: false },
  { op: 'set_hyperlink', sheetId: 's', address: 'A1', target: null },
  { op: 'protect_sheet', sheetId: 's', protected: true },
  { op: 'set_filter', sheetId: 's', range: 'A1:B2' },
  { op: 'clear_filter', sheetId: 's' },
  { op: 'set_filter_criteria', sheetId: 's', column: 'A', values: null },
  {
    op: 'add_conditional_format',
    sheetId: 's',
    range: 'A1',
    rule: {
      kind: 'number',
      operator: 'greaterThan',
      value: 1,
      format: { fillColor: '#00FF00' },
    },
  },
  { op: 'clear_conditional_formats', sheetId: 's' },
  { op: 'set_data_validation', sheetId: 's', range: 'A1', validation: { kind: 'checkbox' } },
  { op: 'add_defined_name', name: 'SalesArea', ref: 'Sheet1!$A$1:$B$2' },
  { op: 'delete_defined_name', name: 'SalesArea' },
  { op: 'set_page_setup', sheetId: 's', orientation: 'landscape' },
  { op: 'set_freeze', sheetId: 's', rows: 1, columns: 0 },
  { op: 'set_note', sheetId: 's', address: 'A1', text: null },
  { op: 'refresh_pivot', sheetId: 's' },
  { op: 'insert_rows', sheetId: 's', row: 1, count: 1 },
  { op: 'delete_rows', sheetId: 's', row: 1, count: 1 },
  { op: 'insert_cols', sheetId: 's', column: 'A', count: 1 },
  { op: 'delete_cols', sheetId: 's', column: 'A', count: 1 },
  { op: 'add_sheet', name: 'Summary' },
  { op: 'delete_sheet', sheetId: 's' },
  { op: 'duplicate_sheet', sheetId: 's', name: 'Copy' },
  { op: 'set_sheet_hidden', sheetId: 's', hidden: true },
  { op: 'move_sheet', sheetId: 's', position: 1 },
  { op: 'rename_sheet', sheetId: 's', name: 'Renamed' },
  { op: 'delete_visual', visualId: 'shape-1' },
  { op: 'delete_table', sheetId: 's', tableName: 'Sales' },
  { op: 'find_replace', sheetId: 's', range: 'A1:A2', find: 'old', replace: 'new' },
  { op: 'add_sparkline', sheetId: 's', type: 'line', dataRange: 'A1:B2' },
]

describe('Sheets Workbook TypeBox source', () => {
  it('accepts exactly the frozen 52 discriminants and applies legacy defaults', () => {
    expect(acceptedOperations).toHaveLength(52)
    expect(acceptedOperations.map((value) => (value as { op: string }).op)).toEqual(
      SHEETS_WORKBOOK_OPERATION_NAMES,
    )
    const parsed = acceptedOperations.map(parseSheetsWorkbookOperation)
    expect(parsed[9]).toMatchObject({ op: 'set_row_height', count: 1 })
    expect(parsed[17]).toMatchObject({ op: 'add_table_row', count: 1 })
    expect(parsed[21]).toMatchObject({
      op: 'add_pivot',
      filters: [expect.objectContaining({ valueIndex: 0 })],
    })
    expect(parsed[22]).toMatchObject({ op: 'set_rows_hidden', count: 1 })
  })

  it('normalizes a valid batch and keeps structural operations mutually exclusive', () => {
    expect(
      parseSheetsWorkbookCommandBatch({
        dslVersion: 1,
        transactionId: 'tx-1',
        baseRevision: 0,
        summary: '  Update values  ',
        operations: [acceptedOperations[0]],
      }),
    ).toMatchObject({ summary: 'Update values' })
    expect(() =>
      parseSheetsWorkbookCommandBatch({
        dslVersion: 1,
        transactionId: 'tx-2',
        baseRevision: 0,
        summary: 'Mixed',
        operations: [acceptedOperations[0], acceptedOperations[38]],
      }),
    ).toThrow(/separate batches/)
  })

  it.each([
    { op: 'set_range', sheetId: 's', values: [[1]] },
    { op: 'format_range', sheetId: 's', range: 'A1', format: {} },
    { op: 'edit_shape', visualId: 'shape-1' },
    { op: 'edit_chart', chartPath: 'xl/charts/chart1.xml' },
    {
      op: 'add_conditional_format',
      sheetId: 's',
      range: 'A1',
      rule: { kind: 'blank', blank: true, format: {} },
    },
    { op: 'set_page_setup', sheetId: 's' },
    { op: 'add_defined_name', name: '1bad', ref: 'A1' },
    {
      op: 'add_pivot',
      sheetId: 's',
      sourceRange: 'A1:B2',
      targetCell: 'D1',
      rowFields: 'Region',
      values: [{ field: 'Revenue', agg: 'sum' }],
      name: '1bad',
    },
  ])('rejects semantic refinement violations', (operation) => {
    expect(() => parseSheetsWorkbookOperation(operation)).toThrow()
  })

  it.each([
    { op: 'add_image', sheetId: 's', anchorCell: 'A1', path: '/private/logo.png' },
    { op: 'add_image', sheetId: 's', anchorCell: 'A1', url: 'https://example.test/a.png' },
    { op: 'set_cell', sheetId: 's', address: 'A1', value: Number.NaN },
    { op: 'read_local_file', path: '/private/data.xlsx' },
    { ...(acceptedOperations[0] as object), unknown: true },
  ])('fails closed on unsafe or unknown operation input', (operation) => {
    expect(() => parseSheetsWorkbookOperation(operation)).toThrow('invalid_workbook_operation')
  })

  it('rejects invalid batch envelopes and blank normalized names', () => {
    expect(() => parseSheetsWorkbookCommandBatch({ dslVersion: 1 })).toThrow(
      'invalid_workbook_command_batch',
    )
    expect(() => parseSheetsWorkbookOperation({ op: 'add_sheet', name: '   ' })).toThrow(
      'invalid_workbook_operation',
    )
  })
})
