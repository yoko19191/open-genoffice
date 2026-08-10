import catalog from '../fixtures/office-tool-catalog-baseline.json' with { type: 'json' }

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
