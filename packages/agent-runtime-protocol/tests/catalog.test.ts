import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import catalogFixture from '../fixtures/office-tool-catalog-baseline.json' with { type: 'json' }
import { canonicalizeOfficeToolCatalog, parseOfficeToolCatalog } from '../src'
import { resolveOfficeToolCatalogMetadata } from '../src/office-tool-catalog'

const repoRoot = new URL('../../../', import.meta.url)

async function registrations(sourceFile: string): Promise<string[]> {
  const source = await readFile(new URL(sourceFile, repoRoot), 'utf8')
  return [...source.matchAll(/^\s+name: ['"]([a-z_]+)['"]/gm)].map((match) => match[1])
}

describe('frozen four-application tool catalog', () => {
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

  it('matches every current renderer registration without omissions', async () => {
    const catalog = parseOfficeToolCatalog(catalogFixture)
    const sourceGroups = new Map<string, string[]>()
    for (const entry of catalog.entries) {
      const key = `${entry.app}:${entry.sourceFile}`
      sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), entry.legacyAlias])
    }

    const discovered: string[] = []
    for (const [key, expected] of sourceGroups) {
      const [app, sourceFile] = key.split(':', 2)
      const actual = await registrations(sourceFile)
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
