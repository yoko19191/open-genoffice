import { Type, type TObject } from '@sinclair/typebox'
import { SlidePageCommitInputSchema } from './slide-page-spec-schema'

const slideIndex = (allowAll = false) =>
  Type.Integer({ minimum: allowAll ? -1 : 0, maximum: 100_000 })
const sourceId = () => Type.String({ minLength: 1, maxLength: 1_024 })
const coordinate = () => Type.Number({ minimum: -1_000_000, maximum: 1_000_000 })
const dimension = () => Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 })
const color = (allowNone = false) =>
  Type.String({ pattern: allowNone ? '^(?:none|#?[0-9a-fA-F]{6})$' : '^#?[0-9a-fA-F]{6}$' })
const uuid = () =>
  Type.String({
    pattern:
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  })
const literalUnion = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)))

const ParagraphSchema = Type.Object(
  {
    text: Type.String({ maxLength: 100_000 }),
    bold: Type.Optional(Type.Boolean()),
    italic: Type.Optional(Type.Boolean()),
    underline: Type.Optional(Type.Boolean()),
    fontSize: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1_000 })),
    fontFamily: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    color: Type.Optional(color()),
    align: Type.Optional(literalUnion(['left', 'center', 'right'] as const)),
  },
  { additionalProperties: false },
)

const paragraphs = () => Type.Array(ParagraphSchema, { minItems: 1, maxItems: 10_000 })
const boxFields = () => ({
  x: coordinate(),
  y: coordinate(),
  w: dimension(),
  h: dimension(),
})
const targetFields = () => ({ slideIndex: slideIndex(), sourceId: sourceId() })
const chartKind = () =>
  literalUnion(['bar', 'barStacked', 'line', 'area', 'pie', 'doughnut'] as const)
const dataSource = () => literalUnion(['user', 'document', 'search', 'sample'] as const)
const chartSeries = () =>
  Type.Array(
    Type.Object(
      {
        name: Type.String({ maxLength: 4_096 }),
        values: Type.Array(Type.Number(), { minItems: 1, maxItems: 10_000 }),
      },
      { additionalProperties: false },
    ),
    { minItems: 1, maxItems: 1_024 },
  )

export const SLIDES_OFFICE_TOOL_SCHEMAS = {
  get_deck_context: Type.Object({}, { additionalProperties: false }),
  read_slide: Type.Object({ slideIndex: slideIndex() }, { additionalProperties: false }),
  set_element_text: Type.Object(
    { ...targetFields(), paragraphs: paragraphs() },
    { additionalProperties: false },
  ),
  set_element_style: Type.Object(
    {
      ...targetFields(),
      fontSize: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1_000 })),
      color: Type.Optional(color()),
      bold: Type.Optional(Type.Boolean()),
      italic: Type.Optional(Type.Boolean()),
      underline: Type.Optional(Type.Boolean()),
      fontFamily: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      align: Type.Optional(literalUnion(['left', 'center', 'right'] as const)),
    },
    { additionalProperties: false },
  ),
  set_element_transform: Type.Object(
    {
      ...targetFields(),
      x: Type.Optional(coordinate()),
      y: Type.Optional(coordinate()),
      w: Type.Optional(dimension()),
      h: Type.Optional(dimension()),
      rotationDeg: Type.Optional(Type.Number({ minimum: -36_000, maximum: 36_000 })),
    },
    { additionalProperties: false },
  ),
  execute_slide_script: Type.Object(
    {
      slideIndex: slideIndex(),
      code: Type.String({ minLength: 1, maxLength: 25_000 }),
      explanation: Type.Optional(Type.String({ maxLength: 64 })),
    },
    { additionalProperties: false },
  ),
  set_element_fill: Type.Object(
    { ...targetFields(), fill: color(true) },
    { additionalProperties: false },
  ),
  set_element_stroke: Type.Object(
    {
      ...targetFields(),
      color: Type.Optional(color()),
      widthPt: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
      remove: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  insert_image: Type.Object(
    { slideIndex: slideIndex(), artifactId: uuid(), ...boxFields() },
    { additionalProperties: false },
  ),
  delete_slide: Type.Object({ slideIndex: slideIndex() }, { additionalProperties: false }),
  add_slide: Type.Object(
    { sourceIndex: slideIndex(), clearText: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  add_text_box: Type.Object(
    { slideIndex: slideIndex(), ...boxFields(), paragraphs: paragraphs() },
    { additionalProperties: false },
  ),
  add_shape: Type.Object(
    {
      slideIndex: slideIndex(),
      kind: Type.String({ minLength: 1, maxLength: 128 }),
      ...boxFields(),
      fillColor: Type.Optional(color()),
      paragraphs: Type.Optional(paragraphs()),
    },
    { additionalProperties: false },
  ),
  add_chart: Type.Object(
    {
      slideIndex: slideIndex(),
      kind: chartKind(),
      title: Type.Optional(Type.String({ maxLength: 4_096 })),
      categories: Type.Array(Type.String({ maxLength: 4_096 }), {
        minItems: 1,
        maxItems: 10_000,
      }),
      series: chartSeries(),
      dataSource: dataSource(),
      x: Type.Optional(coordinate()),
      y: Type.Optional(coordinate()),
      w: Type.Optional(dimension()),
      h: Type.Optional(dimension()),
    },
    { additionalProperties: false },
  ),
  add_smartart: Type.Object(
    {
      slideIndex: slideIndex(),
      layout: literalUnion([
        'list',
        'process',
        'cycle',
        'hierarchy',
        'pyramid',
        'matrix',
        'venn',
      ] as const),
      items: Type.Array(Type.String({ maxLength: 4_096 }), { minItems: 1, maxItems: 1_024 }),
      x: Type.Optional(coordinate()),
      y: Type.Optional(coordinate()),
      w: Type.Optional(dimension()),
      h: Type.Optional(dimension()),
    },
    { additionalProperties: false },
  ),
  add_table: Type.Object(
    {
      slideIndex: slideIndex(),
      rows: Type.Integer({ minimum: 1, maximum: 1_000 }),
      cols: Type.Integer({ minimum: 1, maximum: 1_000 }),
      cells: Type.Optional(
        Type.Array(Type.Array(Type.String({ maxLength: 100_000 }), { maxItems: 1_000 }), {
          maxItems: 1_000,
        }),
      ),
      x: Type.Optional(coordinate()),
      y: Type.Optional(coordinate()),
      w: Type.Optional(dimension()),
      h: Type.Optional(dimension()),
    },
    { additionalProperties: false },
  ),
  edit_table_cell: Type.Object(
    {
      ...targetFields(),
      row: Type.Integer({ minimum: 0, maximum: 999 }),
      col: Type.Integer({ minimum: 0, maximum: 999 }),
      paragraphs: paragraphs(),
    },
    { additionalProperties: false },
  ),
  edit_table_structure: Type.Object(
    {
      ...targetFields(),
      kind: literalUnion(['insert-row', 'delete-row', 'insert-col', 'delete-col'] as const),
      index: Type.Integer({ minimum: 0, maximum: 999 }),
      before: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  edit_table_style: Type.Object(
    {
      ...targetFields(),
      styleName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      firstRow: Type.Optional(Type.Boolean()),
      bandRow: Type.Optional(Type.Boolean()),
      shadingColor: Type.Optional(color(true)),
      borderColor: Type.Optional(color()),
      borderWidthPt: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
      borderPreset: Type.Optional(literalUnion(['all', 'none'] as const)),
    },
    { additionalProperties: false },
  ),
  edit_chart: Type.Object(
    {
      ...targetFields(),
      kind: Type.Optional(chartKind()),
      categories: Type.Optional(
        Type.Array(Type.String({ maxLength: 4_096 }), { minItems: 1, maxItems: 10_000 }),
      ),
      series: Type.Optional(chartSeries()),
      dataSource: Type.Optional(dataSource()),
      colorScheme: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      title: Type.Optional(Type.String({ maxLength: 4_096 })),
      legendPos: Type.Optional(literalUnion(['b', 't', 'r', 'l', 'none'] as const)),
      dataLabels: Type.Optional(Type.Boolean()),
      gridlines: Type.Optional(Type.Boolean()),
      switchRowCol: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  set_slide_background: Type.Object(
    {
      slideIndex: slideIndex(true),
      color: Type.Optional(color()),
      artifactId: Type.Optional(uuid()),
    },
    { additionalProperties: false },
  ),
  delete_element: Type.Object(targetFields(), { additionalProperties: false }),
  ungroup_element: Type.Object(targetFields(), { additionalProperties: false }),
  commit_slide_page: SlidePageCommitInputSchema,
} as const satisfies Record<string, TObject>

export type SlidesOfficeToolAlias = keyof typeof SLIDES_OFFICE_TOOL_SCHEMAS
