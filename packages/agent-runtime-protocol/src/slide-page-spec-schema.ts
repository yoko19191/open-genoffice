import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const uuid = Type.String({
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
})
const color = Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' })
const coordinateX = Type.Integer({ minimum: 0, maximum: 1_279 })
const coordinateY = Type.Integer({ minimum: 0, maximum: 719 })
const width = Type.Integer({ minimum: 1, maximum: 1_280 })
const height = Type.Integer({ minimum: 1, maximum: 720 })
const elementId = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' })
const literalUnion = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)))

export const SLIDE_PAGE_REGISTERED_FONTS = [
  'Aptos',
  'Arial',
  'Calibri',
  'Noto Sans',
  'Noto Sans CJK SC',
  'Noto Sans SC',
  'Microsoft YaHei',
  'PingFang SC',
  'SimSun',
  'Times New Roman',
] as const

const overlap = Type.Optional(
  Type.Array(elementId, { minItems: 1, maxItems: 32, uniqueItems: true }),
)
const box = {
  x: coordinateX,
  y: coordinateY,
  w: width,
  h: height,
}
const textStyle = {
  fontSizePt: Type.Optional(Type.Number({ minimum: 8, maximum: 96 })),
  fontFamily: Type.Optional(literalUnion(SLIDE_PAGE_REGISTERED_FONTS)),
  color: Type.Optional(color),
  bold: Type.Optional(Type.Boolean()),
  italic: Type.Optional(Type.Boolean()),
  align: Type.Optional(literalUnion(['left', 'center', 'right', 'justify'] as const)),
}

const TextSpecSchema = Type.Object(
  {
    id: elementId,
    kind: Type.Literal('text'),
    ...box,
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
    ...textStyle,
    allowOverlapWith: overlap,
  },
  { additionalProperties: false },
)

const ShapeSpecSchema = Type.Object(
  {
    id: elementId,
    kind: Type.Literal('shape'),
    shape: literalUnion([
      'rect',
      'roundRect',
      'ellipse',
      'triangle',
      'chevron',
      'rightArrow',
      'line',
    ] as const),
    ...box,
    fill: Type.Optional(color),
    stroke: Type.Optional(color),
    strokeWidthPt: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
    ...textStyle,
    allowOverlapWith: overlap,
  },
  { additionalProperties: false },
)

const ImageSpecSchema = Type.Object(
  {
    id: elementId,
    kind: Type.Literal('image'),
    artifactId: uuid,
    ...box,
    fit: Type.Optional(literalUnion(['contain', 'cover', 'stretch'] as const)),
    altText: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    allowOverlapWith: overlap,
  },
  { additionalProperties: false },
)

const ChartSpecSchema = Type.Object(
  {
    id: elementId,
    kind: Type.Literal('chart'),
    chartType: literalUnion(['bar', 'barStacked', 'line', 'area', 'pie', 'doughnut'] as const),
    ...box,
    title: Type.Optional(Type.String({ maxLength: 4_096 })),
    categories: Type.Array(Type.String({ maxLength: 4_096 }), {
      minItems: 1,
      maxItems: 128,
    }),
    series: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 4_096 }),
          values: Type.Array(Type.Number(), { minItems: 1, maxItems: 128 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 16 },
    ),
    dataSource: literalUnion(['user', 'document', 'search', 'sample'] as const),
    allowOverlapWith: overlap,
  },
  { additionalProperties: false },
)

const TableSpecSchema = Type.Object(
  {
    id: elementId,
    kind: Type.Literal('table'),
    ...box,
    rows: Type.Array(
      Type.Array(Type.String({ maxLength: 24_000 }), { minItems: 1, maxItems: 32 }),
      { minItems: 1, maxItems: 64 },
    ),
    allowOverlapWith: overlap,
  },
  { additionalProperties: false },
)

const SmartArtSpecSchema = Type.Object(
  {
    id: elementId,
    kind: Type.Literal('smartart'),
    layout: literalUnion([
      'list',
      'process',
      'cycle',
      'hierarchy',
      'pyramid',
      'matrix',
      'venn',
    ] as const),
    ...box,
    items: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      minItems: 1,
      maxItems: 8,
    }),
    allowOverlapWith: overlap,
  },
  { additionalProperties: false },
)

export const SlidePageSpecSchema = Type.Object(
  {
    version: Type.Literal(1),
    title: Type.String({ minLength: 1, maxLength: 512 }),
    canvas: Type.Object(
      { widthPx: Type.Literal(1_280), heightPx: Type.Literal(720) },
      { additionalProperties: false },
    ),
    background: Type.Union([
      Type.Object({ color }, { additionalProperties: false }),
      Type.Object({ artifactId: uuid }, { additionalProperties: false }),
    ]),
    elements: Type.Array(
      Type.Union([
        TextSpecSchema,
        ShapeSpecSchema,
        ImageSpecSchema,
        ChartSpecSchema,
        TableSpecSchema,
        SmartArtSpecSchema,
      ]),
      { maxItems: 64 },
    ),
  },
  { additionalProperties: false },
)

export const SlidePageCommitInputSchema = Type.Object(
  {
    mode: literalUnion(['append', 'insert', 'replace'] as const),
    index: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    spec: SlidePageSpecSchema,
  },
  { additionalProperties: false },
)

export type SlidePageSpec = Static<typeof SlidePageSpecSchema>
export type SlidePageElement = SlidePageSpec['elements'][number]
export type SlidePageCommitInput = Static<typeof SlidePageCommitInputSchema>

function assertSemanticSpec(spec: SlidePageSpec): void {
  const ids = new Set<string>()
  for (const element of spec.elements) {
    if (ids.has(element.id) || element.x + element.w > 1_280 || element.y + element.h > 720) {
      throw new Error('invalid_tool_arguments')
    }
    ids.add(element.id)
    if (element.kind === 'table') {
      const columns = element.rows[0]!.length
      if (element.rows.some((row) => row.length !== columns)) {
        throw new Error('invalid_tool_arguments')
      }
    }
    if (
      element.kind === 'chart' &&
      element.series.some((series) => series.values.length !== element.categories.length)
    ) {
      throw new Error('invalid_tool_arguments')
    }
  }
  for (const element of spec.elements) {
    if (element.allowOverlapWith?.some((id) => id === element.id || !ids.has(id))) {
      throw new Error('invalid_tool_arguments')
    }
  }
}

export function parseSlidePageSpec(value: unknown): SlidePageSpec {
  if (!Value.Check(SlidePageSpecSchema, value)) throw new Error('invalid_tool_arguments')
  const spec = value as SlidePageSpec
  assertSemanticSpec(spec)
  return spec
}

export function parseSlidePageCommitInput(value: unknown): SlidePageCommitInput {
  if (!Value.Check(SlidePageCommitInputSchema, value)) throw new Error('invalid_tool_arguments')
  const input = value as SlidePageCommitInput
  parseSlidePageSpec(input.spec)
  if ((input.mode === 'append') === (input.index !== undefined)) {
    throw new Error('invalid_tool_arguments')
  }
  return input
}
