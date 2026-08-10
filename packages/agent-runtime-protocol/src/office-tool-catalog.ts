import { createHash } from 'node:crypto'
import { Type, type TSchema } from '@sinclair/typebox'
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
  parameters: TSchema
}

function definition(
  modelAlias: string,
  effect: 'read' | 'mutation' | 'external',
  description: string,
  parameters: TSchema,
): OfficeToolDefinition {
  return {
    id: `office:pdf:${modelAlias}`,
    modelAlias,
    effect,
    label: modelAlias.replaceAll('_', ' '),
    description,
    parameters,
  }
}

const emptyInput = () => Type.Object({}, { additionalProperties: false })
const pageInput = () =>
  Type.Object({ page: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })

export const PDF_OFFICE_TOOL_DEFINITIONS: readonly OfficeToolDefinition[] = [
  definition(
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
  definition(
    'search_text',
    'read',
    'Search local PDF text and return at most forty page-numbered excerpts.',
    Type.Object(
      { query: Type.String({ minLength: 1, maxLength: 4_096 }) },
      { additionalProperties: false },
    ),
  ),
  definition(
    'goto_page',
    'external',
    'Scroll the user view to an original PDF page.',
    pageInput(),
  ),
  definition(
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
  definition(
    'list_form_fields',
    'read',
    'List PDF form fields, options and current unsaved values.',
    emptyInput(),
  ),
  definition(
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
  definition(
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
  definition(
    'delete_page',
    'mutation',
    'Delete an original PDF page while preserving at least one page.',
    pageInput(),
  ),
  definition('get_outline', 'read', 'Read the local PDF outline.', emptyInput()),
]

function descriptorProjection(definitions: readonly OfficeToolDefinition[]) {
  return definitions.map(({ id, modelAlias, effect }) => ({ id, modelAlias, effect }))
}

function catalogHash(descriptors: OfficeToolCatalogBinding['descriptors']): string {
  return createHash('sha256').update(JSON.stringify(descriptors)).digest('hex')
}

const pdfDescriptors = descriptorProjection(PDF_OFFICE_TOOL_DEFINITIONS)

export const PDF_OFFICE_TOOL_CATALOG_BINDING: OfficeToolCatalogBinding = {
  app: 'pdf',
  catalogHash: catalogHash(pdfDescriptors),
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
  throw new Error('office_tool_catalog_mismatch')
}

export function parsePdfOfficeToolInput(toolId: string, value: unknown): unknown {
  const descriptor = PDF_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
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
