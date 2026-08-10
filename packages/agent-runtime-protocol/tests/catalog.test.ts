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
  PDF_OFFICE_TOOL_CATALOG_BINDING,
  PDF_OFFICE_TOOL_DEFINITIONS,
  parsePdfOfficeToolInput,
  resolveOfficeToolCatalogMetadata,
  resolveOfficeToolDefinitions,
} from '../src/office-tool-catalog'

const repoRoot = new URL('../../../', import.meta.url)

async function registrations(sourceFile: string): Promise<string[]> {
  const source = await readFile(new URL(sourceFile, repoRoot), 'utf8')
  return [...source.matchAll(/^\s+name: ['"]([a-z_]+)['"]/gm)].map((match) => match[1])
}

describe('frozen four-application tool catalog', () => {
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

  it('matches every current product registration without omissions', async () => {
    const catalog = parseOfficeToolCatalog(catalogFixture)
    const sourceGroups = new Map<string, string[]>()
    for (const entry of catalog.entries) {
      const key = `${entry.app}:${entry.sourceFile}`
      sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), entry.legacyAlias])
    }

    const discovered: string[] = []
    for (const [key, expected] of sourceGroups) {
      const [app, sourceFile] = key.split(':', 2)
      const actual =
        app === 'pdf'
          ? PDF_OFFICE_TOOL_DEFINITIONS.map(({ modelAlias }) => modelAlias)
          : await registrations(sourceFile)
      expect(actual.sort(), key).toEqual(expected.sort())
      discovered.push(...actual.map((alias) => `${app}:${alias}`))
    }

    expect(new Set(discovered).size).toBe(63)
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
