import { GlobalAssetSyncReconciler } from '../../src/sync/project-sync-reconciler.js'
import type { ProjectSyncEntry, SyncObjectStore } from '../../src/sync/types.js'

export const GLOBAL_ASSET_PROVIDER_SCOPE = 'global-provider-contract'

function fixture(extensionVersion: 1 | 2): ProjectSyncEntry[] {
  const repeated = new Uint8Array(1024 * 1024).fill(11)
  return [
    {
      canonicalPath: 'assets/styles/one.bin',
      kind: 'global-asset',
      bytes: repeated,
    },
    {
      canonicalPath: 'assets/styles/two.bin',
      kind: 'global-asset',
      bytes: repeated,
    },
    {
      canonicalPath: 'agent/skills/demo/SKILL.md',
      kind: 'global-skill',
      bytes: new TextEncoder().encode('# Demo\n'),
    },
    {
      canonicalPath: 'agent/extensions/demo.mjs',
      kind: 'global-extension',
      bytes: new TextEncoder().encode(`export const version = ${extensionVersion}\n`),
      executable: true,
    },
    {
      canonicalPath: 'agent/prompts/brief.md',
      kind: 'global-prompt',
      bytes: new TextEncoder().encode('# Brief\n'),
    },
    {
      canonicalPath: 'agent/packages.lock.json',
      kind: 'global-package-lock',
      bytes: new TextEncoder().encode('{"packages":[]}\n'),
      executable: true,
      network: true,
    },
    {
      canonicalPath: 'mcp/servers.json',
      kind: 'global-mcp-config',
      bytes: new TextEncoder().encode('{"schemaVersion":1,"servers":[]}\n'),
      network: true,
    },
    {
      canonicalPath: '.open-genoffice/credential-slots/mcp.json',
      kind: 'credential-slot',
      credentialSlot: { slotId: 'model/mcp/default', providerId: 'mcp-oauth' },
    },
  ]
}

export type GlobalAssetProviderContractResult = {
  initialRevisionId: string
  initialManifestHash: string
  updatedRevisionId: string
  updatedManifestHash: string
  unchangedRevisionId: string
  entryHashes: string[]
}

export async function runGlobalAssetProviderContract(
  createStore: () => SyncObjectStore,
): Promise<GlobalAssetProviderContractResult> {
  const publisher = new GlobalAssetSyncReconciler({
    store: createStore(),
    scopeId: GLOBAL_ASSET_PROVIDER_SCOPE,
    authorDeviceId: 'device-a',
  })
  const initial = await publisher.publish(fixture(1))
  if (initial.status !== 'published') throw new Error('global_initial_publish_failed')
  const updated = await publisher.publish(fixture(2), initial.remoteBase)
  if (updated.status !== 'published') throw new Error('global_update_publish_failed')
  const unchanged = await publisher.publish(fixture(2), updated.remoteBase)
  if (unchanged.status !== 'published') throw new Error('global_unchanged_publish_failed')
  return {
    initialRevisionId: initial.head.revisionId,
    initialManifestHash: initial.head.manifestHash,
    updatedRevisionId: updated.head.revisionId,
    updatedManifestHash: updated.head.manifestHash,
    unchangedRevisionId: unchanged.head.revisionId,
    entryHashes: updated.manifest.entries.map((entry) => entry.contentHash ?? '').sort(),
  }
}

export const EXPECTED_GLOBAL_ASSET_PROVIDER_RESULT: GlobalAssetProviderContractResult = {
  initialRevisionId: '96e116e263a46af7ecc590bc70cb7ae32d5ce99319e6a091b1d7fc264537b657',
  initialManifestHash: '2efc5f34016e153f77c003932db94ef4fca9e61723e02353431bfda554834acf',
  updatedRevisionId: '92a6d2273b2574237e68e8c6db574ade14a5f96a807d142d0178c91a9817517e',
  updatedManifestHash: '5845b9d8107bc6d07a6de401b8662e5aef068d22e12255b3fbe7fe5565cbb68c',
  unchangedRevisionId: '92a6d2273b2574237e68e8c6db574ade14a5f96a807d142d0178c91a9817517e',
  entryHashes: [
    '0435fd6520a1869af2b1ff1932bad6170325a21757f8d3b5cf5a69137bac5d35',
    '1a2036951819553b36c38faad3aa3eb4aa9421072cb9ea61ea67ab7ada105f10',
    '1b899d8abc9b3739e71f7c581e80d7d19084fdfe85d0a14f5d51cc2533af69cc',
    '31ca6c61ca3fcc54029a62bd082448b88718b913d24e195794969dd2d123b990',
    '5b73e021f74f025cb469d2e562f3cdc49ac01cea559c23d8f034749a2cb22a8f',
    '9ce290753f410d6001975a9e4d65f06dfb641a6676e38f3883b48f1560b0e52b',
    '9ce290753f410d6001975a9e4d65f06dfb641a6676e38f3883b48f1560b0e52b',
    'f37dbd8c7a953e0450e1e99cce8f31693d2984efa558e329b6306452f6c2d422',
  ],
}
