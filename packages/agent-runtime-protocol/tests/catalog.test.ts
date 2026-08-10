import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import catalogFixture from '../fixtures/office-tool-catalog-baseline.json' with { type: 'json' }
import {
  canonicalizeOfficeToolCatalog,
  parseOfficeToolCatalog,
  parseOfficeToolCatalogBinding,
} from '../src'
import {
  DOCS_OFFICE_TOOL_CATALOG_BINDING,
  DOCS_OFFICE_TOOL_DEFINITIONS,
  PDF_OFFICE_TOOL_CATALOG_BINDING,
  PDF_OFFICE_TOOL_DEFINITIONS,
  SHEETS_OFFICE_TOOL_CATALOG_BINDING,
  SHEETS_OFFICE_TOOL_DEFINITIONS,
  parseDocsOfficeToolInput,
  parsePdfOfficeToolInput,
  parseSheetsOfficeToolInput,
  resolveOfficeToolCatalogMetadata,
  resolveOfficeToolDefinitions,
} from '../src/office-tool-catalog'

const repoRoot = new URL('../../../', import.meta.url)

async function registrations(sourceFile: string): Promise<string[]> {
  const source = await readFile(new URL(sourceFile, repoRoot), 'utf8')
  return [...source.matchAll(/^\s+name: ['"]([a-z_]+)['"]/gm)].map((match) => match[1])
}

describe('frozen four-application tool catalog', () => {
  it('publishes exactly eight Docs Office executors and excludes three platform aliases', () => {
    expect(DOCS_OFFICE_TOOL_DEFINITIONS.map(({ modelAlias }) => modelAlias)).toEqual([
      'get_document_context',
      'read_blocks',
      'insert_content',
      'replace_blocks',
      'apply_commands',
      'insert_image',
      'insert_chart',
      'edit_chart',
    ])
    expect(DOCS_OFFICE_TOOL_CATALOG_BINDING).toMatchObject({
      app: 'docs',
      catalogHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      descriptors: [
        expect.objectContaining({ effect: 'read', modelAlias: 'get_document_context' }),
        expect.objectContaining({ effect: 'read', modelAlias: 'read_blocks' }),
        ...Array.from({ length: 6 }, () => expect.objectContaining({ effect: 'mutation' })),
      ],
    })
    expect(DOCS_OFFICE_TOOL_CATALOG_BINDING.catalogHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(DOCS_OFFICE_TOOL_CATALOG_BINDING.descriptors))
        .digest('hex'),
    )
    expect(resolveOfficeToolDefinitions(DOCS_OFFICE_TOOL_CATALOG_BINDING)).toBe(
      DOCS_OFFICE_TOOL_DEFINITIONS,
    )
    expect(DOCS_OFFICE_TOOL_DEFINITIONS.map(({ modelAlias }) => modelAlias)).not.toEqual(
      expect.arrayContaining(['web_search', 'image_search', 'read_attachment']),
    )
  })

  it('validates Docs restricted inputs and the fixed command batch at the catalog boundary', () => {
    expect(
      parseDocsOfficeToolInput('office:docs:read_blocks', {
        startBlockIndex: 0,
        endBlockIndex: 3,
        offset: 24_000,
      }),
    ).toEqual({ startBlockIndex: 0, endBlockIndex: 3, offset: 24_000 })
    expect(
      parseDocsOfficeToolInput('office:docs:insert_image', {
        artifactId: '11111111-1111-4111-8111-111111111111',
        maxWidthPx: 480,
      }),
    ).toEqual({
      artifactId: '11111111-1111-4111-8111-111111111111',
      maxWidthPx: 480,
    })
    expect(() =>
      parseDocsOfficeToolInput('office:docs:insert_image', {
        artifactId: '11111111-1111-4111-8111-111111111111',
        url: 'https://example.test/image.png',
      }),
    ).toThrowError('invalid_tool_arguments')
    expect(() =>
      parseDocsOfficeToolInput('office:docs:apply_commands', {
        commands: Array.from({ length: 65 }, () => ({ insertToc: { afterBlockIndex: -1 } })),
      }),
    ).toThrowError('invalid_tool_arguments')
    expect(() =>
      parseDocsOfficeToolInput('office:docs:apply_commands', {
        commands: [{ runJavascript: { source: 'private' } }],
      }),
    ).toThrowError('invalid_tool_arguments')
    expect(() => parseDocsOfficeToolInput('office:docs:unknown', {})).toThrowError(
      'tool_not_in_snapshot',
    )
  })

  it('publishes the exact PDF runtime descriptors and a deterministic binding hash', () => {
    expect(PDF_OFFICE_TOOL_DEFINITIONS.map(({ modelAlias }) => modelAlias)).toEqual([
      'read_pages',
      'search_text',
      'goto_page',
      'markup_text',
      'list_form_fields',
      'fill_form_field',
      'rotate_page',
      'delete_page',
      'get_outline',
    ])
    expect(PDF_OFFICE_TOOL_CATALOG_BINDING).toMatchObject({
      app: 'pdf',
      catalogHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      descriptors: [
        {
          id: 'office:pdf:read_pages',
          modelAlias: 'read_pages',
          effect: 'read',
        },
        expect.any(Object),
        expect.objectContaining({ effect: 'external', modelAlias: 'goto_page' }),
        expect.objectContaining({ effect: 'mutation', modelAlias: 'markup_text' }),
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ modelAlias: 'get_outline' }),
      ],
    })
    expect(PDF_OFFICE_TOOL_CATALOG_BINDING.catalogHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(PDF_OFFICE_TOOL_CATALOG_BINDING.descriptors))
        .digest('hex'),
    )
    expect(parseOfficeToolCatalogBinding(PDF_OFFICE_TOOL_CATALOG_BINDING)).toEqual(
      PDF_OFFICE_TOOL_CATALOG_BINDING,
    )
    expect(resolveOfficeToolDefinitions(PDF_OFFICE_TOOL_CATALOG_BINDING)).toBe(
      PDF_OFFICE_TOOL_DEFINITIONS,
    )
    expect(() =>
      parseOfficeToolCatalogBinding({ ...PDF_OFFICE_TOOL_CATALOG_BINDING, catalogHash: 'short' }),
    ).toThrowError('office_tool_catalog_binding_invalid')
    expect(() =>
      resolveOfficeToolDefinitions({
        ...PDF_OFFICE_TOOL_CATALOG_BINDING,
        catalogHash: '0'.repeat(64),
      }),
    ).toThrowError('office_tool_catalog_mismatch')
    expect(() =>
      resolveOfficeToolDefinitions({
        ...PDF_OFFICE_TOOL_CATALOG_BINDING,
        descriptors: PDF_OFFICE_TOOL_CATALOG_BINDING.descriptors.slice(0, -1),
      }),
    ).toThrowError('office_tool_catalog_mismatch')
  })

  it('validates PDF inputs from the same TypeBox definitions used by Runtime and main', () => {
    expect(parsePdfOfficeToolInput('office:pdf:read_pages', { start: 1, end: 10 })).toEqual({
      start: 1,
      end: 10,
    })
    expect(parsePdfOfficeToolInput('office:pdf:list_form_fields', {})).toEqual({})
    expect(() =>
      parsePdfOfficeToolInput('office:pdf:markup_text', {
        page: 1,
        text: 'exact',
        type: 'highlight',
        endpoint: 'https://example.test',
      }),
    ).toThrowError('invalid_tool_arguments')
    expect(() => parsePdfOfficeToolInput('office:pdf:unknown', {})).toThrowError(
      'tool_not_in_snapshot',
    )
  })

  it('publishes the exact six Sheets executors and one deterministic binding', () => {
    expect(SHEETS_OFFICE_TOOL_DEFINITIONS.map(({ modelAlias }) => modelAlias)).toEqual([
      'get_workbook_context',
      'read_range',
      'read_formats',
      'read_sheet_features',
      'read_cells',
      'propose_operations',
    ])
    expect(SHEETS_OFFICE_TOOL_CATALOG_BINDING.catalogHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(SHEETS_OFFICE_TOOL_CATALOG_BINDING.descriptors))
        .digest('hex'),
    )
    expect(resolveOfficeToolDefinitions(SHEETS_OFFICE_TOOL_CATALOG_BINDING)).toBe(
      SHEETS_OFFICE_TOOL_DEFINITIONS,
    )
  })

  it('uses the 52-operation TypeBox source at both Sheets boundaries', () => {
    expect(
      parseSheetsOfficeToolInput('office:sheets:propose_operations', {
        summary: '更新合计',
        operations: [
          {
            op: 'set_formula',
            sheetId: 'sheet-1',
            address: 'B2',
            formula: '=SUM(A1:A10)',
          },
        ],
      }),
    ).toMatchObject({ summary: '更新合计' })
    expect(() =>
      parseSheetsOfficeToolInput('office:sheets:propose_operations', {
        summary: '读取本机文件',
        operations: [
          {
            op: 'add_image',
            sheetId: 'sheet-1',
            anchorCell: 'A1',
            path: '/Users/private/image.png',
          },
        ],
      }),
    ).toThrowError('invalid_tool_arguments')
    expect(() =>
      parseSheetsOfficeToolInput('office:sheets:read_range', {
        range: 'A1:B2',
        endpoint: 'https://example.test/private',
      }),
    ).toThrowError('invalid_tool_arguments')
  })

  it('resolves canonical Office effects without treating platform ids as Office tools', () => {
    expect(resolveOfficeToolCatalogMetadata('office:pdf:read_pages')).toEqual({
      modelAlias: 'read_pages',
      effect: 'read',
    })
    expect(resolveOfficeToolCatalogMetadata('office:pdf:delete_page')).toEqual({
      modelAlias: 'delete_page',
      effect: 'mutation',
    })
    expect(resolveOfficeToolCatalogMetadata('platform:artifact:read_text')).toBeUndefined()
    expect(resolveOfficeToolCatalogMetadata('office:pdf:unknown')).toBeUndefined()
  })

  it('validates and canonicalizes the 63-instance migration baseline', () => {
    const catalog = parseOfficeToolCatalog(catalogFixture)
    expect(catalog.entries).toHaveLength(63)
    expect(catalog.entries.filter((entry) => entry.disposition === 'office-executor')).toHaveLength(
      46,
    )
    expect(catalog.entries.filter((entry) => entry.disposition === 'retired')).toHaveLength(2)
    expect(canonicalizeOfficeToolCatalog(catalog)).toBe(
      `${JSON.stringify(catalogFixture, null, 2)}\n`,
    )
  })

  it('matches migrated Office definitions and remaining legacy registrations without omissions', async () => {
    const catalog = parseOfficeToolCatalog(catalogFixture)
    const sourceGroups = new Map<string, string[]>()
    for (const entry of catalog.entries) {
      if (entry.app === 'docs' || entry.app === 'pdf' || entry.app === 'sheets') continue
      const key = `${entry.app}:${entry.sourceFile}`
      sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), entry.legacyAlias])
    }

    for (const [key, expected] of sourceGroups) {
      const [, sourceFile] = key.split(':', 2)
      expect((await registrations(sourceFile)).sort(), key).toEqual(expected.sort())
    }

    for (const [app, definitions] of [
      ['docs', DOCS_OFFICE_TOOL_DEFINITIONS],
      ['pdf', PDF_OFFICE_TOOL_DEFINITIONS],
      ['sheets', SHEETS_OFFICE_TOOL_DEFINITIONS],
    ] as const) {
      const expected = catalog.entries
        .filter((entry) => entry.app === app && entry.disposition === 'office-executor')
        .map(({ legacyAlias }) => legacyAlias)
      expect(definitions.map(({ modelAlias }) => modelAlias).sort(), app).toEqual(expected.sort())
    }
  })

  it('keeps canonical Office IDs unique and all owners Genspark-free', () => {
    const catalog = parseOfficeToolCatalog(catalogFixture)
    const officeIds = catalog.entries
      .filter((entry) => entry.disposition === 'office-executor')
      .map((entry) => entry.targetId)
    expect(new Set(officeIds).size).toBe(46)
    expect(JSON.stringify(catalog)).not.toMatch(/genspark|\bgsk\b|cloudpptx/i)
  })

  it.each([
    [{ ...catalogFixture, unexpected: true }],
    [{ ...catalogFixture, schemaVersion: 2 }],
    [{ ...catalogFixture, entries: catalogFixture.entries.slice(1) }],
  ])('rejects a drifted or unknown catalog manifest', (value) => {
    expect(() => parseOfficeToolCatalog(value)).toThrowError('office_tool_catalog_invalid')
  })
})
