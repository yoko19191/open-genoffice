import type { Static } from '@sinclair/typebox'
import type {
  CredentialSlotDescriptionSchema,
  ProjectManifestEntrySchema,
  ProjectSyncKindSchema,
  ProjectSyncManifestSchema,
  ReconcileIntentSchema,
  SyncHeadSchema,
  SyncRevisionSchema,
} from './schema.js'

export type SyncNamespace = 'project' | 'global'

export interface ProviderDiagnostics {
  ok: boolean
  strongEtag: boolean
  conditionalPut: boolean
  code?: string
}

export interface SyncObjectStore {
  probe(): Promise<ProviderDiagnostics>
  get(key: string): Promise<{ bytes: Uint8Array; versionToken: string } | null>
  putImmutable(key: string, bytes: Uint8Array): Promise<'created' | 'already-exists'>
  compareAndSwap(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | 'absent',
  ): Promise<{ versionToken: string } | { conflict: true }>
}

export type ProjectSyncKind = Static<typeof ProjectSyncKindSchema>

export type CredentialSlotDescription = Static<typeof CredentialSlotDescriptionSchema>

export interface ProjectSyncEntry {
  canonicalPath: string
  kind: ProjectSyncKind
  bytes?: Uint8Array
  tombstone?: boolean
  executable?: boolean
  network?: boolean
  credentialSlot?: CredentialSlotDescription
}

export type SyncRevision = Static<typeof SyncRevisionSchema>

export type ProjectManifestEntry = Static<typeof ProjectManifestEntrySchema>

export type ProjectSyncManifest = Static<typeof ProjectSyncManifestSchema>

export type SyncHead = Static<typeof SyncHeadSchema>

export interface RemoteBase {
  head: SyncHead
  versionToken: string
}

export type ReconcileIntent = Static<typeof ReconcileIntentSchema>

export interface ReconcileIntentStore {
  enqueue(intent: ReconcileIntent): Promise<void>
  load(scopeId: string): Promise<ReconcileIntent | null>
  clear(scopeId: string): Promise<void>
}

export class ProviderUnavailableError extends Error {
  constructor() {
    super('sync_provider_unavailable')
  }
}
