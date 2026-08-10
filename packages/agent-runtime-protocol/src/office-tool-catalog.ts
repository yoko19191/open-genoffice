import { Type, type TObject } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import catalog from '../fixtures/office-tool-catalog-baseline.json' with { type: 'json' }

type OfficeToolCatalogBinding = {
  app: 'docs' | 'pdf' | 'sheets' | 'slides'
  catalogHash: string
  descriptors: Array<{
    id: string
    modelAlias: string
    effect: 'read' | 'mutation' | 'external'
  }>
}

export type OfficeToolDefinition = OfficeToolCatalogBinding['descriptors'][number] & {
  label: string
  description: string
  parameters: TObject
}

function definition(
  app: 'docs' | 'pdf',
  modelAlias: string,
  effect: 'read' | 'mutation' | 'external',
  description: string,
  parameters: TObject,
): OfficeToolDefinition {
  return {
    id: `office:${app}:${modelAlias}`,
    modelAlias,
    effect,
    label: modelAlias.replaceAll('_', ' '),
    description,
    parameters,
  }
}

function pdfDefinition(
  modelAlias: string,
  effect: 'read' | 'mutation' | 'external',
  description: string,
  parameters: TObject,
): OfficeToolDefinition {
  return definition('pdf', modelAlias, effect, description, parameters)
}

function docsDefinition(
  modelAlias: string,
  effect: 'read' | 'mutation',
  description: string,
  parameters: TObject,
): OfficeToolDefinition {
  return definition('docs', modelAlias, effect, description, parameters)
}

const emptyInput = () => Type.Object({}, { additionalProperties: false })
const pageInput = () =>
  Type.Object({ page: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })

export const PDF_OFFICE_TOOL_DEFINITIONS: readonly OfficeToolDefinition[] = [
  pdfDefinition(
    'read_pages',
    'read',
    'Read text from at most ten original PDF pages. Read relevant pages before answering.',
    Type.Object(
      {
        start: Type.Integer({ minimum: 1 }),
        end: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
  ),
  pdfDefinition(
    'search_text',
    'read',
    'Search local PDF text and return at most forty page-numbered excerpts.',
    Type.Object(
      { query: Type.String({ minLength: 1, maxLength: 4_096 }) },
      { additionalProperties: false },
    ),
  ),
  pdfDefinition(
    'goto_page',
    'external',
    'Scroll the user view to an original PDF page.',
    pageInput(),
  ),
  pdfDefinition(
    'markup_text',
    'mutation',
    'Mark an exact text occurrence on an original PDF page.',
    Type.Object(
      {
        page: Type.Integer({ minimum: 1 }),
        text: Type.String({ minLength: 1, maxLength: 24_000 }),
        type: Type.Union([
          Type.Literal('highlight'),
          Type.Literal('underline'),
          Type.Literal('strikeout'),
        ]),
        all: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  ),
  pdfDefinition(
    'list_form_fields',
    'read',
    'List PDF form fields, options and current unsaved values.',
    emptyInput(),
  ),
  pdfDefinition(
    'fill_form_field',
    'mutation',
    'Fill a PDF form field after reading the current field inventory.',
    Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 1_024 }),
        value: Type.Optional(Type.String({ maxLength: 24_000 })),
        checked: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  ),
  pdfDefinition(
    'rotate_page',
    'mutation',
    'Rotate an original PDF page by 90 degrees.',
    Type.Object(
      {
        page: Type.Integer({ minimum: 1 }),
        direction: Type.Union([Type.Literal('left'), Type.Literal('right')]),
      },
      { additionalProperties: false },
    ),
  ),
  pdfDefinition(
    'delete_page',
    'mutation',
    'Delete an original PDF page while preserving at least one page.',
    pageInput(),
  ),
  pdfDefinition('get_outline', 'read', 'Read the local PDF outline.', emptyInput()),
]

const uuid = () =>
  Type.String({
    pattern:
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  })
const blockIndex = () => Type.Integer({ minimum: 0, maximum: 1_000_000 })
const nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Number>>(
  schema: T,
) => Type.Union([schema, Type.Null()])
const literalUnion = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)))

const DocsTargetSchema = Type.Intersect([
  Type.Object(
    {
      nodeType: Type.Optional(
        literalUnion(['docHeading', 'docParagraph', 'docListItem', 'image'] as const),
      ),
      headingLevel: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
      containsText: Type.Optional(Type.String({ minLength: 1, maxLength: 24_000 })),
      matchCase: Type.Optional(Type.Boolean()),
      blockIndexes: Type.Optional(
        Type.Array(blockIndex(), { minItems: 1, maxItems: 1_024, uniqueItems: true }),
      ),
      scope: Type.Optional(literalUnion(['selection', 'document'] as const)),
    },
    { additionalProperties: false },
  ),
  Type.Union([
    Type.Object({ nodeType: Type.String() }),
    Type.Object({ headingLevel: Type.Integer() }),
    Type.Object({ containsText: Type.String() }),
    Type.Object({ blockIndexes: Type.Array(Type.Integer(), { minItems: 1 }) }),
    Type.Object({ scope: Type.Literal('selection') }),
  ]),
])

const textStyleFields = [
  'color',
  'highlight',
  'sizeHalfPoints',
  'font',
  'bold',
  'italic',
  'underline',
  'strike',
  'baselineOffset',
  'link',
] as const
const paragraphStyleFields = [
  'align',
  'lineSpacing',
  'indentLeft',
  'indentRight',
  'indentFirstLine',
  'spaceBefore',
  'spaceAfter',
  'pageBreakBefore',
  'shadingFill',
  'borders',
] as const

const DocsCommandSchema = Type.Union([
  Type.Object(
    {
      updateTextStyle: Type.Object(
        {
          target: DocsTargetSchema,
          style: Type.Object(
            {
              color: Type.Optional(nullable(Type.String({ maxLength: 128 }))),
              highlight: Type.Optional(nullable(Type.String({ maxLength: 128 }))),
              sizeHalfPoints: Type.Optional(nullable(Type.Number({ minimum: 1, maximum: 2_000 }))),
              font: Type.Optional(nullable(Type.String({ maxLength: 256 }))),
              bold: Type.Optional(Type.Boolean()),
              italic: Type.Optional(Type.Boolean()),
              underline: Type.Optional(Type.Boolean()),
              strike: Type.Optional(Type.Boolean()),
              baselineOffset: Type.Optional(
                Type.Union([
                  literalUnion(['SUPERSCRIPT', 'SUBSCRIPT', 'NONE'] as const),
                  Type.Null(),
                ]),
              ),
              link: Type.Optional(
                Type.Union([
                  Type.Object(
                    { url: Type.String({ minLength: 1, maxLength: 4_096 }) },
                    { additionalProperties: false },
                  ),
                  Type.Null(),
                ]),
              ),
            },
            { additionalProperties: false, minProperties: 1 },
          ),
          fields: Type.Array(literalUnion(textStyleFields), {
            minItems: 1,
            maxItems: textStyleFields.length,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      updateParagraphStyle: Type.Object(
        {
          target: DocsTargetSchema,
          style: Type.Object(
            {
              align: Type.Optional(
                Type.Union([
                  literalUnion(['left', 'center', 'right', 'justify'] as const),
                  Type.Null(),
                ]),
              ),
              lineSpacing: Type.Optional(nullable(Type.Number({ minimum: 0, maximum: 100 }))),
              indentLeft: Type.Optional(
                nullable(Type.Number({ minimum: -100_000, maximum: 100_000 })),
              ),
              indentRight: Type.Optional(
                nullable(Type.Number({ minimum: -100_000, maximum: 100_000 })),
              ),
              indentFirstLine: Type.Optional(
                nullable(Type.Number({ minimum: -100_000, maximum: 100_000 })),
              ),
              spaceBefore: Type.Optional(nullable(Type.Number({ minimum: 0, maximum: 100_000 }))),
              spaceAfter: Type.Optional(nullable(Type.Number({ minimum: 0, maximum: 100_000 }))),
              pageBreakBefore: Type.Optional(Type.Boolean()),
              shadingFill: Type.Optional(nullable(Type.String({ maxLength: 128 }))),
              borders: Type.Optional(nullable(Type.String({ maxLength: 32 }))),
            },
            { additionalProperties: false, minProperties: 1 },
          ),
          fields: Type.Array(literalUnion(paragraphStyleFields), {
            minItems: 1,
            maxItems: paragraphStyleFields.length,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      setHeadingLevel: Type.Object(
        { target: DocsTargetSchema, level: Type.Integer({ minimum: 0, maximum: 6 }) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      replaceAllText: Type.Object(
        {
          containsText: Type.String({ minLength: 1, maxLength: 24_000 }),
          replaceText: Type.String({ maxLength: 24_000 }),
          matchCase: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      deleteBlocks: Type.Object({ target: DocsTargetSchema }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      moveBlocks: Type.Object(
        {
          blockIndexes: Type.Array(blockIndex(), {
            minItems: 1,
            maxItems: 1_024,
            uniqueItems: true,
          }),
          afterBlockIndex: Type.Integer({ minimum: -1, maximum: 1_000_000 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      createParagraphBullets: Type.Object(
        {
          target: DocsTargetSchema,
          bulletPreset: Type.Optional(
            Type.String({ pattern: '^(BULLET|NUMBERED)', maxLength: 128 }),
          ),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      deleteParagraphBullets: Type.Object(
        { target: DocsTargetSchema },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      updateImageProperties: Type.Object(
        {
          target: DocsTargetSchema,
          properties: Type.Object(
            {
              widthPx: Type.Optional(nullable(Type.Number({ minimum: 1, maximum: 16_384 }))),
              heightPx: Type.Optional(nullable(Type.Number({ minimum: 1, maximum: 16_384 }))),
              align: Type.Optional(
                Type.Union([literalUnion(['left', 'center', 'right'] as const), Type.Null()]),
              ),
            },
            { additionalProperties: false, minProperties: 1 },
          ),
          fields: Type.Array(literalUnion(['widthPx', 'heightPx', 'align'] as const), {
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      insertToc: Type.Object(
        { afterBlockIndex: Type.Integer({ minimum: -1, maximum: 1_000_000 }) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
])

const chartKind = () => literalUnion(['bar', 'line', 'pie'] as const)
const chartValues = () =>
  Type.Array(Type.Union([Type.Number(), Type.Null()]), { minItems: 1, maxItems: 1_024 })

export const DOCS_OFFICE_TOOL_DEFINITIONS: readonly OfficeToolDefinition[] = [
  docsDefinition(
    'get_document_context',
    'read',
    'Read the live block list, selection, tracked-deletion state and document statistics.',
    emptyInput(),
  ),
  docsDefinition(
    'read_blocks',
    'read',
    'Read restricted HTML for a current block range with 24k character pagination.',
    Type.Object(
      {
        startBlockIndex: blockIndex(),
        endBlockIndex: blockIndex(),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
      },
      { additionalProperties: false },
    ),
  ),
  docsDefinition(
    'insert_content',
    'mutation',
    'Insert restricted HTML at the cursor or after a current block index.',
    Type.Object(
      {
        html: Type.String({ minLength: 1, maxLength: 1_000_000 }),
        afterBlockIndex: Type.Optional(Type.Integer({ minimum: -1, maximum: 1_000_000 })),
      },
      { additionalProperties: false },
    ),
  ),
  docsDefinition(
    'replace_blocks',
    'mutation',
    'Replace a current block range with restricted HTML.',
    Type.Object(
      {
        startBlockIndex: blockIndex(),
        endBlockIndex: blockIndex(),
        html: Type.String({ minLength: 1, maxLength: 1_000_000 }),
      },
      { additionalProperties: false },
    ),
  ),
  docsDefinition(
    'apply_commands',
    'mutation',
    'Execute at most 64 typed document commands sequentially in one tool transaction.',
    Type.Object(
      { commands: Type.Array(DocsCommandSchema, { minItems: 1, maxItems: 64 }) },
      { additionalProperties: false },
    ),
  ),
  docsDefinition(
    'insert_image',
    'mutation',
    'Insert one scope-bound PNG ArtifactRef without renderer network or path access.',
    Type.Object(
      {
        artifactId: uuid(),
        maxWidthPx: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_096 })),
      },
      { additionalProperties: false },
    ),
  ),
  docsDefinition(
    'insert_chart',
    'mutation',
    'Insert a native editable bar, line or pie chart.',
    Type.Object(
      {
        kind: chartKind(),
        title: Type.Optional(Type.String({ maxLength: 4_096 })),
        categories: Type.Array(Type.String({ maxLength: 4_096 }), {
          minItems: 1,
          maxItems: 1_024,
        }),
        series: Type.Array(
          Type.Object(
            {
              name: Type.Optional(Type.String({ maxLength: 4_096 })),
              values: chartValues(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 128 },
        ),
        afterBlockIndex: Type.Optional(Type.Integer({ minimum: -1, maximum: 1_000_000 })),
      },
      { additionalProperties: false },
    ),
  ),
  docsDefinition(
    'edit_chart',
    'mutation',
    'Edit an existing native or generated chart without changing its point cardinality.',
    Type.Object(
      {
        blockIndex: blockIndex(),
        title: Type.Optional(Type.String({ maxLength: 4_096 })),
        categories: Type.Optional(
          Type.Array(Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()]), {
            minItems: 1,
            maxItems: 1_024,
          }),
        ),
        series: Type.Optional(
          Type.Array(
            Type.Object(
              {
                index: Type.Integer({ minimum: 0, maximum: 127 }),
                name: Type.Optional(Type.String({ maxLength: 4_096 })),
                values: Type.Optional(chartValues()),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 128 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  ),
]

function descriptorProjection(definitions: readonly OfficeToolDefinition[]) {
  return definitions.map(({ id, modelAlias, effect }) => ({ id, modelAlias, effect }))
}

const pdfDescriptors = descriptorProjection(PDF_OFFICE_TOOL_DEFINITIONS)
const docsDescriptors = descriptorProjection(DOCS_OFFICE_TOOL_DEFINITIONS)

export const DOCS_OFFICE_TOOL_CATALOG_BINDING: OfficeToolCatalogBinding = {
  app: 'docs',
  catalogHash: '8981cc5f0b46f5483102d01e0dc8f2620b0c4a84db7627b47648a4e84672be9f',
  descriptors: docsDescriptors,
}

export const PDF_OFFICE_TOOL_CATALOG_BINDING: OfficeToolCatalogBinding = {
  app: 'pdf',
  catalogHash: 'c7df023595cbfa4780424841dd03f18cc21156c534fb24fc6e6b225571956e82',
  descriptors: pdfDescriptors,
}

export function resolveOfficeToolDefinitions(
  binding: OfficeToolCatalogBinding,
): readonly OfficeToolDefinition[] {
  if (
    binding.app === 'pdf' &&
    binding.catalogHash === PDF_OFFICE_TOOL_CATALOG_BINDING.catalogHash &&
    JSON.stringify(binding.descriptors) ===
      JSON.stringify(PDF_OFFICE_TOOL_CATALOG_BINDING.descriptors)
  ) {
    return PDF_OFFICE_TOOL_DEFINITIONS
  }
  if (
    binding.app === 'docs' &&
    binding.catalogHash === DOCS_OFFICE_TOOL_CATALOG_BINDING.catalogHash &&
    JSON.stringify(binding.descriptors) ===
      JSON.stringify(DOCS_OFFICE_TOOL_CATALOG_BINDING.descriptors)
  ) {
    return DOCS_OFFICE_TOOL_DEFINITIONS
  }
  throw new Error('office_tool_catalog_mismatch')
}

export function parsePdfOfficeToolInput(toolId: string, value: unknown): unknown {
  const descriptor = PDF_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
  if (!descriptor) throw new Error('tool_not_in_snapshot')
  if (Value.Check(descriptor.parameters, value)) return value
  throw new Error('invalid_tool_arguments')
}

export function parseDocsOfficeToolInput(toolId: string, value: unknown): unknown {
  const descriptor = DOCS_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
  if (!descriptor) throw new Error('tool_not_in_snapshot')
  if (Value.Check(descriptor.parameters, value)) return value
  throw new Error('invalid_tool_arguments')
}

export type OfficeToolCatalogMetadata = {
  modelAlias: string
  effect: 'read' | 'mutation' | 'external'
}

/** Resolves only canonical Office tools from the frozen migration catalog. */
export function resolveOfficeToolCatalogMetadata(
  canonicalToolId: string,
): OfficeToolCatalogMetadata | undefined {
  if (!canonicalToolId.startsWith('office:')) return undefined
  const entry = catalog.entries.find(({ targetId }) => targetId === canonicalToolId)
  if (!entry) return undefined
  return {
    modelAlias: entry.legacyAlias,
    effect: entry.effect as OfficeToolCatalogMetadata['effect'],
  }
}
