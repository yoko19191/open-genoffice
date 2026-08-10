import { Type } from '@sinclair/typebox'

const HashSchema = Type.String({ pattern: '^[a-f0-9]{64}$' })
export const SyncScopeIdSchema = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' })

export const ProjectSyncKindSchema = Type.Union([
  Type.Literal('office-document'),
  Type.Literal('project-asset'),
  Type.Literal('project-metadata'),
  Type.Literal('project-resource'),
  Type.Literal('pi-session-snapshot'),
  Type.Literal('credential-slot'),
])

export const CredentialSlotDescriptionSchema = Type.Object(
  {
    slotId: SyncScopeIdSchema,
    providerId: SyncScopeIdSchema,
  },
  { additionalProperties: false },
)

export const SyncHeadSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scopeId: SyncScopeIdSchema,
    revisionId: HashSchema,
    manifestHash: HashSchema,
  },
  { additionalProperties: false },
)

export const SyncRevisionSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    namespace: Type.Union([Type.Literal('project'), Type.Literal('global')]),
    scopeId: SyncScopeIdSchema,
    canonicalPath: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    contentHash: Type.Optional(HashSchema),
    size: Type.Integer({ minimum: 0 }),
    tombstone: Type.Boolean(),
    parents: Type.Array(HashSchema, { maxItems: 2 }),
    authorDeviceId: SyncScopeIdSchema,
    event: Type.Union([
      Type.Literal('create'),
      Type.Literal('update'),
      Type.Literal('delete'),
      Type.Literal('resolve'),
    ]),
    executable: Type.Boolean(),
    network: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const ProjectManifestEntrySchema = Type.Object(
  {
    canonicalPath: Type.String({ minLength: 1 }),
    kind: ProjectSyncKindSchema,
    contentHash: Type.Optional(HashSchema),
    size: Type.Integer({ minimum: 0 }),
    revisionId: HashSchema,
    tombstone: Type.Boolean(),
    executable: Type.Boolean(),
    network: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const ProjectSyncManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    namespace: Type.Literal('project'),
    scopeId: SyncScopeIdSchema,
    entries: Type.Array(ProjectManifestEntrySchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false },
)

export const ReconcileIntentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operation: Type.Literal('reconcile'),
    scopeId: SyncScopeIdSchema,
    paths: Type.Array(Type.String({ minLength: 1 }), { maxItems: 10_000 }),
  },
  { additionalProperties: false },
)
