import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import {
  CredentialKindSchema,
  CredentialPersistenceSchema,
  CredentialProviderIdSchema,
  ModelSelectionRoleSchema,
  OpenAICompatibleProviderConfigurationSchema,
  MAX_FRAME_BYTES,
  NODE_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
} from '#renderer'

export {
  MAX_FRAME_BYTES,
  NODE_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  ModelCatalogProjectionSchema,
  ModelCapabilitySchema,
  OpenAICompatibleProviderConfigurationSchema,
  ModelSelectionRoleSchema,
  ResourceCatalogProjectionSchema,
  OAuthInteractionProjectionSchema,
  OAuthOperationProjectionSchema,
  ProviderCredentialStatusSchema,
  RuntimeHealthProjectionSchema,
  parseCredentialProviderId,
  parseModelCatalogProjection,
  parseResourceCatalogProjection,
  parseOpenAICompatibleProviderConfiguration,
  parseOAuthOperationProjection,
  parseProviderCredentialStatus,
  parseRuntimeHealthProjection,
  type ProviderCredentialStatus,
  type ModelCapability,
  type ModelCatalogProjection,
  type ResourceCatalogProjection,
  type OpenAICompatibleProviderConfiguration,
  type ModelDescriptor,
  type ModelProviderProjection,
  type ModelProviderState,
  type ModelSelectionRole,
  type ModelProviderErrorCode,
  type OAuthInteractionProjection,
  type OAuthOperationProjection,
  type RuntimeHealthProjection,
} from '#renderer'

const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' })
const OperationIdSchema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
})
const EntityIdSchema = Type.String({ minLength: 1, maxLength: 256 })
const SessionIdSchema = OperationIdSchema
const DocumentIdSchema = OperationIdSchema
const CredentialIdSchema = OperationIdSchema
const CredentialSlotSchema = Type.String({
  pattern: '^model/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}/default$',
})

const GenericRuntimeMethodSchema = Type.Union([
  Type.Literal('runtime.status'),
  Type.Literal('runtime.shutdown'),
  Type.Literal('session.close'),
  Type.Literal('session.steer'),
  Type.Literal('session.followUp'),
  Type.Literal('session.compact'),
])

const ElectronMethodSchema = Type.Union([
  Type.Literal('office.tool.abort'),
  Type.Literal('office.context.read'),
  Type.Literal('permission.request'),
])

const SessionEventTypeSchema = Type.Union([
  Type.Literal('session.opened'),
  Type.Literal('session.closed'),
  Type.Literal('session.snapshot.updated'),
  Type.Literal('run.queued'),
  Type.Literal('run.started'),
  Type.Literal('run.cancelling'),
  Type.Literal('run.completed'),
  Type.Literal('run.failed'),
  Type.Literal('run.aborted'),
  Type.Literal('run.interrupted'),
  Type.Literal('message.started'),
  Type.Literal('message.delta'),
  Type.Literal('message.completed'),
  Type.Literal('thinking.started'),
  Type.Literal('thinking.delta'),
  Type.Literal('thinking.completed'),
  Type.Literal('tool.requested'),
  Type.Literal('tool.started'),
  Type.Literal('tool.progress'),
  Type.Literal('tool.completed'),
  Type.Literal('tool.failed'),
  Type.Literal('tool.aborted'),
  Type.Literal('compaction.started'),
  Type.Literal('compaction.completed'),
  Type.Literal('compaction.failed'),
  Type.Literal('branch.created'),
  Type.Literal('branch.navigated'),
  Type.Literal('permission.requested'),
  Type.Literal('permission.resolved'),
  Type.Literal('runtime.degraded'),
  Type.Literal('diagnostic.available'),
])

const RuntimeErrorCodeSchema = Type.Union([
  Type.Literal('invalid_json'),
  Type.Literal('schema'),
  Type.Literal('invalid_request'),
  Type.Literal('hello_required'),
  Type.Literal('unauthorized'),
  Type.Literal('protocol_mismatch'),
  Type.Literal('runtime_mismatch'),
  Type.Literal('schema_mismatch'),
  Type.Literal('method_not_found'),
  Type.Literal('session_not_found'),
  Type.Literal('session_in_use'),
  Type.Literal('session_lease_invalid'),
  Type.Literal('session_lease_lost'),
  Type.Literal('document_mismatch'),
  Type.Literal('invalid_state'),
  Type.Literal('duplicate_operation_mismatch'),
  Type.Literal('cursor_expired'),
  Type.Literal('permission_denied'),
  Type.Literal('capability_revoked'),
  Type.Literal('provider_auth'),
  Type.Literal('rate_limit'),
  Type.Literal('unavailable'),
  Type.Literal('tool_failed'),
  Type.Literal('tool_not_in_snapshot'),
  Type.Literal('tool_timeout'),
  Type.Literal('mutation_outcome_unknown'),
  Type.Literal('abort_incomplete'),
  Type.Literal('artifact_invalid'),
  Type.Literal('runtime_unavailable'),
  Type.Literal('internal_error'),
  Type.Literal('secure_storage_unavailable'),
  Type.Literal('credential_generation_conflict'),
  Type.Literal('credential_index_invalid'),
  Type.Literal('credential_persist_failed'),
  Type.Literal('credential_decrypt_failed'),
  Type.Literal('credential_payload_invalid'),
  Type.Literal('credential_provider_id_invalid'),
  Type.Literal('credential_status_failed'),
  Type.Literal('credential_delete_failed'),
  Type.Literal('credential_persistence_conflict'),
  Type.Literal('model_not_selected'),
  Type.Literal('model_not_found'),
  Type.Literal('model_provider_not_found'),
  Type.Literal('model_provider_invalid'),
  Type.Literal('oauth_operation_exists'),
  Type.Literal('oauth_provider_unsupported'),
  Type.Literal('oauth_operation_not_found'),
  Type.Literal('oauth_not_waiting'),
  Type.Literal('oauth_response_invalid'),
])

export const CredentialBrokerMetadataSchema = Type.Object(
  {
    credentialId: CredentialIdSchema,
    slot: CredentialSlotSchema,
    providerId: CredentialProviderIdSchema,
    kind: CredentialKindSchema,
    generation: Type.Integer({ minimum: 1 }),
    status: Type.Literal('available'),
  },
  { additionalProperties: false },
)

export const CredentialBrokerStatusSchema = Type.Union([
  CredentialBrokerMetadataSchema,
  Type.Object(
    {
      slot: CredentialSlotSchema,
      status: Type.Union([Type.Literal('missing'), Type.Literal('secure_storage_unavailable')]),
    },
    { additionalProperties: false },
  ),
])

export const CredentialBrokerGetResultSchema = Type.Union([
  Type.Object(
    {
      metadata: CredentialBrokerMetadataSchema,
      secretPayload: Type.String({ minLength: 1, maxLength: 262_144 }),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
])

export const CredentialBrokerDeleteReceiptSchema = Type.Object(
  {
    slot: CredentialSlotSchema,
    generation: Type.Integer({ minimum: 1 }),
    status: Type.Literal('deleted'),
  },
  { additionalProperties: false },
)

const CredentialManagementPutRequestSchema = sessionRequestEnvelope(
  'credential.put',
  Type.Object(
    {
      providerId: CredentialProviderIdSchema,
      persistence: CredentialPersistenceSchema,
      secretPayload: Type.String({ minLength: 1, maxLength: 262_144 }),
    },
    { additionalProperties: false },
  ),
)

const CredentialManagementStatusRequestSchema = sessionRequestEnvelope(
  'credential.status',
  Type.Object({ providerId: CredentialProviderIdSchema }, { additionalProperties: false }),
)

const CredentialManagementDeleteRequestSchema = sessionRequestEnvelope(
  'credential.delete',
  Type.Object({ providerId: CredentialProviderIdSchema }, { additionalProperties: false }),
)

export const CredentialManagementRequestSchema = Type.Union([
  CredentialManagementPutRequestSchema,
  CredentialManagementStatusRequestSchema,
  CredentialManagementDeleteRequestSchema,
])

export const ArtifactRefSchema = Type.Object(
  {
    artifactId: Type.String({ minLength: 1 }),
    mediaType: Type.String({ minLength: 1 }),
    byteLength: Type.Integer({ minimum: 0 }),
    sha256: Sha256Schema,
    displayName: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

const OfficeToolIdSchema = Type.String({
  pattern: '^office:[a-z0-9-]+:[a-z][a-z0-9_]*$',
  maxLength: 256,
})

const OfficeToolActorSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('parent'),
      actorId: EntityIdSchema,
      sessionId: SessionIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('subagent'),
      actorId: EntityIdSchema,
      subagentRunId: EntityIdSchema,
      parentRunId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
])

export const OfficeToolInvocationSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    sessionId: SessionIdSchema,
    documentId: DocumentIdSchema,
    runId: EntityIdSchema,
    toolCallId: EntityIdSchema,
    toolId: OfficeToolIdSchema,
    toolOrder: Type.Integer({ minimum: 0 }),
    actor: OfficeToolActorSchema,
    permissionSnapshot: Type.Object(
      {
        snapshotId: EntityIdSchema,
        createdForRunId: EntityIdSchema,
        permissionVersion: EntityIdSchema,
        toolIds: Type.Array(OfficeToolIdSchema, { maxItems: 512 }),
      },
      { additionalProperties: false },
    ),
    input: Type.Unknown(),
  },
  { additionalProperties: false },
)

export const SessionMessageProjectionSchema = Type.Object(
  {
    id: EntityIdSchema,
    role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('toolResult')]),
    text: Type.String(),
    toolCallId: Type.Optional(EntityIdSchema),
    toolName: Type.Optional(EntityIdSchema),
    isError: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export const SessionSnapshotSchema = Type.Object(
  {
    sessionId: EntityIdSchema,
    documentId: DocumentIdSchema,
    messages: Type.Array(SessionMessageProjectionSchema),
    activeRun: Type.Optional(
      Type.Object(
        {
          runId: EntityIdSchema,
          state: Type.Union([
            Type.Literal('queued'),
            Type.Literal('running'),
            Type.Literal('cancelling'),
            Type.Literal('completed'),
            Type.Literal('failed'),
            Type.Literal('aborted'),
            Type.Literal('interrupted'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    branch: Type.Optional(
      Type.Object(
        {
          parentSessionId: Type.Optional(SessionIdSchema),
          activeLeafId: Type.Optional(EntityIdSchema),
          nodes: Type.Array(
            Type.Object(
              {
                entryId: EntityIdSchema,
                parentEntryId: Type.Union([EntityIdSchema, Type.Null()]),
                kind: Type.String({ minLength: 1, maxLength: 64 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 4096 },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    lastSequence: Type.Integer({ minimum: 0 }),
    cursor: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const ProtocolErrorSchema = Type.Object(
  {
    code: RuntimeErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
    correlationId: Type.String({ minLength: 1 }),
    details: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
    ),
  },
  { additionalProperties: false },
)

const GenericRequestEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('request'),
    id: Type.String({ minLength: 1 }),
    method: Type.Union([GenericRuntimeMethodSchema, ElectronMethodSchema]),
    correlationId: Type.String({ minLength: 1 }),
    params: Type.Unknown(),
  },
  { additionalProperties: false },
)

function sessionRequestEnvelope<
  TMethod extends string,
  TParams extends ReturnType<typeof Type.Object>,
>(method: TMethod, params: TParams) {
  return Type.Object(
    {
      protocolVersion: Type.Literal(PROTOCOL_VERSION),
      kind: Type.Literal('request'),
      id: EntityIdSchema,
      method: Type.Literal(method),
      correlationId: EntityIdSchema,
      params,
    },
    { additionalProperties: false },
  )
}

const SessionCreateRequestSchema = sessionRequestEnvelope(
  'session.create',
  Type.Object(
    {
      operationId: OperationIdSchema,
      documentId: DocumentIdSchema,
    },
    { additionalProperties: false },
  ),
)

const ModelCatalogRequestSchema = sessionRequestEnvelope(
  'model.catalog',
  Type.Object({}, { additionalProperties: false }),
)

const ResourceCatalogRequestSchema = sessionRequestEnvelope(
  'resource.catalog',
  Type.Object(
    { projectRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) },
    { additionalProperties: false },
  ),
)

const ProjectTrustGrantRequestSchema = sessionRequestEnvelope(
  'project.trust.grant',
  Type.Object(
    {
      operationId: OperationIdSchema,
      projectRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    },
    { additionalProperties: false },
  ),
)

const ProjectTrustRevokeRequestSchema = sessionRequestEnvelope(
  'project.trust.revoke',
  Type.Object(
    {
      operationId: OperationIdSchema,
      projectRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    },
    { additionalProperties: false },
  ),
)

export const ResourceManagementRequestSchema = Type.Union([
  ResourceCatalogRequestSchema,
  ProjectTrustGrantRequestSchema,
  ProjectTrustRevokeRequestSchema,
])

const ModelSelectRequestSchema = sessionRequestEnvelope(
  'model.select',
  Type.Object(
    {
      role: ModelSelectionRoleSchema,
      providerId: CredentialProviderIdSchema,
      modelId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
)

const ModelProviderConfigureRequestSchema = sessionRequestEnvelope(
  'model.provider.configure',
  OpenAICompatibleProviderConfigurationSchema,
)

const ModelOAuthStartRequestSchema = sessionRequestEnvelope(
  'model.oauth.start',
  Type.Object(
    { operationId: OperationIdSchema, providerId: CredentialProviderIdSchema },
    { additionalProperties: false },
  ),
)

const ModelOAuthStatusRequestSchema = sessionRequestEnvelope(
  'model.oauth.status',
  Type.Object({ operationId: OperationIdSchema }, { additionalProperties: false }),
)

const ModelOAuthRespondRequestSchema = sessionRequestEnvelope(
  'model.oauth.respond',
  Type.Object(
    {
      operationId: OperationIdSchema,
      value: Type.String({ minLength: 1, maxLength: 16_384 }),
    },
    { additionalProperties: false },
  ),
)

const ModelOAuthCancelRequestSchema = sessionRequestEnvelope(
  'model.oauth.cancel',
  Type.Object({ operationId: OperationIdSchema }, { additionalProperties: false }),
)

const ModelLogoutRequestSchema = sessionRequestEnvelope(
  'model.logout',
  Type.Object({ providerId: CredentialProviderIdSchema }, { additionalProperties: false }),
)

export const ModelManagementRequestSchema = Type.Union([
  ModelCatalogRequestSchema,
  ModelSelectRequestSchema,
  ModelProviderConfigureRequestSchema,
  ModelOAuthStartRequestSchema,
  ModelOAuthStatusRequestSchema,
  ModelOAuthRespondRequestSchema,
  ModelOAuthCancelRequestSchema,
  ModelLogoutRequestSchema,
])

const OfficeToolInvokeRequestSchema = sessionRequestEnvelope(
  'office.tool.invoke',
  OfficeToolInvocationSchema,
)

const CredentialWriteParamsSchema = Type.Object(
  {
    slot: CredentialSlotSchema,
    providerId: CredentialProviderIdSchema,
    kind: CredentialKindSchema,
    expectedGeneration: Type.Integer({ minimum: 0 }),
    secretPayload: Type.String({ minLength: 1, maxLength: 262_144 }),
  },
  { additionalProperties: false },
)

const CredentialPutRequestSchema = sessionRequestEnvelope(
  'credential.put',
  Type.Object(
    {
      ...CredentialWriteParamsSchema.properties,
      expectedGeneration: Type.Literal(0),
    },
    { additionalProperties: false },
  ),
)

const CredentialRotateRequestSchema = sessionRequestEnvelope(
  'credential.rotate',
  Type.Object(
    {
      ...CredentialWriteParamsSchema.properties,
      expectedGeneration: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
)

const CredentialGetRequestSchema = sessionRequestEnvelope(
  'credential.get',
  Type.Object({ slot: CredentialSlotSchema }, { additionalProperties: false }),
)

const CredentialStatusRequestSchema = sessionRequestEnvelope(
  'credential.status',
  Type.Object({ slot: CredentialSlotSchema }, { additionalProperties: false }),
)

const CredentialDeleteRequestSchema = sessionRequestEnvelope(
  'credential.delete',
  Type.Object(
    {
      slot: CredentialSlotSchema,
      expectedGeneration: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
)

export const CredentialBrokerRequestSchema = Type.Union([
  CredentialPutRequestSchema,
  CredentialGetRequestSchema,
  CredentialStatusRequestSchema,
  CredentialRotateRequestSchema,
  CredentialDeleteRequestSchema,
])

const SessionOpenRequestSchema = sessionRequestEnvelope(
  'session.open',
  Type.Object(
    {
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
    },
    { additionalProperties: false },
  ),
)

const SessionPromptRequestSchema = sessionRequestEnvelope(
  'session.prompt',
  Type.Object(
    {
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
      text: Type.String({ minLength: 1, maxLength: 262_144 }),
      projectRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
      artifacts: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 16 })),
    },
    { additionalProperties: false },
  ),
)

const SessionAbortRequestSchema = sessionRequestEnvelope(
  'session.abort',
  Type.Object(
    {
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
      runId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
)

const SessionForkRequestSchema = sessionRequestEnvelope(
  'session.fork',
  Type.Object(
    {
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
    },
    { additionalProperties: false },
  ),
)

const SessionNavigateRequestSchema = sessionRequestEnvelope(
  'session.navigate',
  Type.Object(
    {
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
      targetEntryId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
)

const SessionSnapshotRequestSchema = sessionRequestEnvelope(
  'session.snapshot',
  Type.Object(
    {
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
    },
    { additionalProperties: false },
  ),
)

const SessionSubscribeRequestSchema = sessionRequestEnvelope(
  'session.subscribe',
  Type.Object(
    {
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
      afterCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
)

const HelloRequestEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('request'),
    id: Type.String({ minLength: 1 }),
    method: Type.Literal('runtime.hello'),
    correlationId: Type.String({ minLength: 1 }),
    params: Type.Object(
      {
        protocolVersion: Type.Literal(PROTOCOL_VERSION),
        runtimeVersion: Type.Literal(RUNTIME_VERSION),
        schemaVersion: Type.Literal(SCHEMA_VERSION),
        token: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

const ArtifactRegisterRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('request'),
    id: Type.String({ minLength: 1 }),
    method: Type.Literal('artifact.register'),
    correlationId: Type.String({ minLength: 1 }),
    params: Type.Object(
      {
        sessionId: Type.String({ minLength: 1 }),
        documentId: DocumentIdSchema,
        path: Type.String({ minLength: 1 }),
        artifact: ArtifactRefSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export const RequestEnvelopeSchema = Type.Union([
  GenericRequestEnvelopeSchema,
  HelloRequestEnvelopeSchema,
  ArtifactRegisterRequestSchema,
  OfficeToolInvokeRequestSchema,
  CredentialPutRequestSchema,
  CredentialGetRequestSchema,
  CredentialStatusRequestSchema,
  CredentialRotateRequestSchema,
  CredentialDeleteRequestSchema,
  CredentialManagementPutRequestSchema,
  CredentialManagementStatusRequestSchema,
  CredentialManagementDeleteRequestSchema,
  SessionCreateRequestSchema,
  SessionOpenRequestSchema,
  SessionPromptRequestSchema,
  SessionAbortRequestSchema,
  SessionForkRequestSchema,
  SessionNavigateRequestSchema,
  SessionSnapshotRequestSchema,
  SessionSubscribeRequestSchema,
  ModelCatalogRequestSchema,
  ResourceCatalogRequestSchema,
  ProjectTrustGrantRequestSchema,
  ProjectTrustRevokeRequestSchema,
  ModelSelectRequestSchema,
  ModelProviderConfigureRequestSchema,
  ModelOAuthStartRequestSchema,
  ModelOAuthStatusRequestSchema,
  ModelOAuthRespondRequestSchema,
  ModelOAuthCancelRequestSchema,
  ModelLogoutRequestSchema,
])

const ResponseResultEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('response'),
    id: Type.String({ minLength: 1 }),
    correlationId: Type.String({ minLength: 1 }),
    result: Type.Unknown(),
  },
  { additionalProperties: false },
)

const ResponseErrorEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('response'),
    id: Type.String({ minLength: 1 }),
    correlationId: Type.String({ minLength: 1 }),
    error: ProtocolErrorSchema,
  },
  { additionalProperties: false },
)

export const ResponseEnvelopeSchema = Type.Union([
  ResponseResultEnvelopeSchema,
  ResponseErrorEnvelopeSchema,
])

export const EventEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('event'),
    eventId: Type.String({ minLength: 1 }),
    instanceId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    documentId: DocumentIdSchema,
    runId: Type.Optional(Type.String({ minLength: 1 })),
    sequence: Type.Integer({ minimum: 1 }),
    cursor: Type.String({ minLength: 1 }),
    occurredAt: Type.String({ minLength: 1 }),
    type: SessionEventTypeSchema,
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
)

export const SessionConnectionReceiptSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    documentId: DocumentIdSchema,
    snapshot: SessionSnapshotSchema,
    cursor: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

export const SessionPromptReceiptSchema = Type.Object(
  {
    runId: EntityIdSchema,
    acceptedCursor: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

export const SessionAbortReceiptSchema = Type.Object(
  {
    runId: EntityIdSchema,
    state: Type.Union([Type.Literal('cancelling'), Type.Literal('already_terminal')]),
    acceptedCursor: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

export const SessionForkReceiptSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    parentSessionId: SessionIdSchema,
    documentId: DocumentIdSchema,
    snapshot: SessionSnapshotSchema,
    cursor: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

export const SessionNavigateReceiptSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    documentId: DocumentIdSchema,
    activeLeafId: EntityIdSchema,
    snapshot: SessionSnapshotSchema,
    cursor: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

export const OfficeToolReceiptSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    toolCallId: EntityIdSchema,
    toolId: OfficeToolIdSchema,
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed')]),
    output: Type.String(),
    details: Type.Optional(Type.Unknown()),
    mutationOutcome: Type.Optional(
      Type.Union([
        Type.Literal('not_started'),
        Type.Literal('committed'),
        Type.Literal('rolled_back'),
        Type.Literal('unknown'),
      ]),
    ),
    errorCode: Type.Optional(
      Type.Union([Type.Literal('mutation_outcome_unknown'), Type.Literal('tool_failed')]),
    ),
    provenance: Type.Object(
      {
        actorId: EntityIdSchema,
        runId: EntityIdSchema,
        documentId: DocumentIdSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export const SessionSubscriptionReceiptSchema = Type.Object(
  {
    resetRequired: Type.Boolean(),
    snapshot: SessionSnapshotSchema,
    events: Type.Array(EventEnvelopeSchema),
  },
  { additionalProperties: false },
)

export const AgentSessionConnectRequestSchema = Type.Object(
  {
    documentId: DocumentIdSchema,
    sessionId: Type.Optional(SessionIdSchema),
    afterCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
)

export const AgentSessionCommandSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('prompt'),
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
      text: Type.String({ minLength: 1, maxLength: 262_144 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('abort'),
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
      runId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('fork'),
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('navigate'),
      operationId: OperationIdSchema,
      sessionId: SessionIdSchema,
      documentId: DocumentIdSchema,
      targetEntryId: EntityIdSchema,
    },
    { additionalProperties: false },
  ),
])

export const AgentSessionConnectReceiptSchema = Type.Object(
  {
    connectionId: OperationIdSchema,
    sessionId: SessionIdSchema,
    documentId: DocumentIdSchema,
    resetRequired: Type.Boolean(),
    snapshot: SessionSnapshotSchema,
    events: Type.Array(EventEnvelopeSchema),
  },
  { additionalProperties: false },
)

export const ProtocolEnvelopeSchema = Type.Union([
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
])

export const OfficeToolCatalogSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sourceBaselineCommit: Type.String({ pattern: '^[0-9a-f]{40}$' }),
    entries: Type.Array(
      Type.Object(
        {
          app: Type.Union([
            Type.Literal('docs'),
            Type.Literal('pdf'),
            Type.Literal('sheets'),
            Type.Literal('slides'),
          ]),
          legacyAlias: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }),
          targetId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          effect: Type.Union([
            Type.Literal('read'),
            Type.Literal('mutation'),
            Type.Literal('external'),
          ]),
          disposition: Type.Union([
            Type.Literal('office-executor'),
            Type.Literal('platform'),
            Type.Literal('skill'),
            Type.Literal('resource'),
            Type.Literal('retired'),
          ]),
          sourceFile: Type.String({ pattern: '^apps/(pdf|docs|sheets|slides)/src/.+\\.ts$' }),
        },
        { additionalProperties: false },
      ),
      { minItems: 63, maxItems: 63 },
    ),
  },
  { additionalProperties: false },
)

const BootstrapSchema = Type.Object(
  {
    kind: Type.Literal('bootstrap'),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    runtimeVersion: Type.Literal(RUNTIME_VERSION),
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    parentPid: Type.Integer({ minimum: 1 }),
    endpoint: Type.String({ minLength: 1 }),
    token: Sha256Schema,
  },
  { additionalProperties: false },
)

const RuntimeBundleManifestSchema = Type.Object(
  {
    manifestVersion: Type.Literal(1),
    runtimeName: Type.Literal(RUNTIME_NAME),
    runtimeVersion: Type.Literal(RUNTIME_VERSION),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    nodeVersion: Type.Literal(NODE_VERSION),
    piVersion: Type.Literal(PI_VERSION),
    platform: Type.Union([Type.Literal('darwin'), Type.Literal('win32'), Type.Literal('linux')]),
    arch: Type.Union([Type.Literal('arm64'), Type.Literal('x64')]),
    libc: Type.Optional(Type.Literal('glibc')),
    executable: Type.String({ minLength: 1 }),
    entry: Type.String({ minLength: 1 }),
    treeSha256: Sha256Schema,
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          sha256: Sha256Schema,
          size: Type.Integer({ minimum: 0 }),
          mode: Type.Optional(Type.String({ pattern: '^0[0-7]{3}$' })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    noticesSha256: Sha256Schema,
    generatedFromLockSha256: Sha256Schema,
  },
  { additionalProperties: false },
)

export type BootstrapRecord = Static<typeof BootstrapSchema>
export type RuntimeBundleManifest = Static<typeof RuntimeBundleManifestSchema>
export type ArtifactRef = Static<typeof ArtifactRefSchema>
export type OfficeToolInvocation = Static<typeof OfficeToolInvocationSchema>
export type OfficeToolReceipt = Static<typeof OfficeToolReceiptSchema>
export type SessionMessageProjection = Static<typeof SessionMessageProjectionSchema>
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>
export type EventEnvelope = Static<typeof EventEnvelopeSchema>
export type SessionConnectionReceipt = Static<typeof SessionConnectionReceiptSchema>
export type SessionPromptReceipt = Static<typeof SessionPromptReceiptSchema>
export type SessionAbortReceipt = Static<typeof SessionAbortReceiptSchema>
export type SessionForkReceipt = Static<typeof SessionForkReceiptSchema>
export type SessionNavigateReceipt = Static<typeof SessionNavigateReceiptSchema>
export type SessionSubscriptionReceipt = Static<typeof SessionSubscriptionReceiptSchema>
export type AgentSessionConnectRequest = Static<typeof AgentSessionConnectRequestSchema>
export type AgentSessionCommand = Static<typeof AgentSessionCommandSchema>
export type AgentSessionConnectReceipt = Static<typeof AgentSessionConnectReceiptSchema>
export type ProtocolEnvelope = Static<typeof ProtocolEnvelopeSchema>
export type OfficeToolCatalog = Static<typeof OfficeToolCatalogSchema>
export type CredentialBrokerMetadata = Static<typeof CredentialBrokerMetadataSchema>
export type CredentialBrokerStatus = Static<typeof CredentialBrokerStatusSchema>
export type CredentialBrokerGetResult = Exclude<
  Static<typeof CredentialBrokerGetResultSchema>,
  null
>
export type CredentialBrokerDeleteReceipt = Static<typeof CredentialBrokerDeleteReceiptSchema>
export type CredentialBrokerRequest = Static<typeof CredentialBrokerRequestSchema>
export type CredentialManagementRequest = Static<typeof CredentialManagementRequestSchema>
export type ModelManagementRequest = Static<typeof ModelManagementRequestSchema>
export type ResourceManagementRequest = Static<typeof ResourceManagementRequestSchema>

export function parseBootstrapLine(line: string): BootstrapRecord {
  try {
    const value: unknown = JSON.parse(line)
    if (Value.Check(BootstrapSchema, value)) return value
  } catch {
    // All bootstrap parse failures intentionally share a secret-free error.
  }
  throw new Error('invalid_bootstrap')
}

export function parseCredentialBrokerRequest(value: unknown): CredentialBrokerRequest {
  if (Value.Check(CredentialBrokerRequestSchema, value)) return value
  throw new Error('credential_broker_request_invalid')
}

export function parseCredentialBrokerMetadata(value: unknown): CredentialBrokerMetadata {
  if (Value.Check(CredentialBrokerMetadataSchema, value)) return value
  throw new Error('credential_broker_metadata_invalid')
}

export function parseCredentialBrokerStatus(value: unknown): CredentialBrokerStatus {
  if (Value.Check(CredentialBrokerStatusSchema, value)) return value
  throw new Error('credential_broker_status_invalid')
}

export function parseCredentialBrokerGetResult(
  value: unknown,
): CredentialBrokerGetResult | undefined {
  if (!Value.Check(CredentialBrokerGetResultSchema, value)) {
    throw new Error('credential_broker_get_result_invalid')
  }
  return value ?? undefined
}

export function parseCredentialBrokerDeleteReceipt(value: unknown): CredentialBrokerDeleteReceipt {
  if (Value.Check(CredentialBrokerDeleteReceiptSchema, value)) return value
  throw new Error('credential_broker_delete_receipt_invalid')
}

export function parseCredentialManagementRequest(value: unknown): CredentialManagementRequest {
  if (Value.Check(CredentialManagementRequestSchema, value)) return value
  throw new Error('credential_management_request_invalid')
}

export function parseModelManagementRequest(value: unknown): ModelManagementRequest {
  if (Value.Check(ModelManagementRequestSchema, value)) return value
  throw new Error('model_management_request_invalid')
}

export function parseResourceManagementRequest(value: unknown): ResourceManagementRequest {
  if (Value.Check(ResourceManagementRequestSchema, value)) return value
  throw new Error('resource_management_request_invalid')
}

export function parseRuntimeBundleManifest(value: unknown): RuntimeBundleManifest {
  if (Value.Check(RuntimeBundleManifestSchema, value)) return value
  throw new Error('runtime_bundle_invalid')
}

export function parseSessionConnectionReceipt(value: unknown): SessionConnectionReceipt {
  if (Value.Check(SessionConnectionReceiptSchema, value)) return value
  throw new Error('session_connection_receipt_invalid')
}

export function parseSessionPromptReceipt(value: unknown): SessionPromptReceipt {
  if (Value.Check(SessionPromptReceiptSchema, value)) return value
  throw new Error('session_prompt_receipt_invalid')
}

export function parseSessionAbortReceipt(value: unknown): SessionAbortReceipt {
  if (Value.Check(SessionAbortReceiptSchema, value)) return value
  throw new Error('session_abort_receipt_invalid')
}

export function parseSessionForkReceipt(value: unknown): SessionForkReceipt {
  if (
    Value.Check(SessionForkReceiptSchema, value) &&
    value.sessionId !== value.parentSessionId &&
    value.snapshot.sessionId === value.sessionId &&
    value.snapshot.documentId === value.documentId &&
    value.snapshot.branch?.parentSessionId === value.parentSessionId
  ) {
    return value
  }
  throw new Error('session_fork_receipt_invalid')
}

export function parseSessionNavigateReceipt(value: unknown): SessionNavigateReceipt {
  if (
    Value.Check(SessionNavigateReceiptSchema, value) &&
    value.snapshot.sessionId === value.sessionId &&
    value.snapshot.documentId === value.documentId &&
    value.snapshot.branch?.activeLeafId === value.activeLeafId
  ) {
    return value
  }
  throw new Error('session_navigate_receipt_invalid')
}

export function parseOfficeToolInvocation(value: unknown): OfficeToolInvocation {
  if (Value.Check(OfficeToolInvocationSchema, value)) return value
  throw new Error('office_tool_invocation_invalid')
}

export function parseOfficeToolReceipt(value: unknown): OfficeToolReceipt {
  if (Value.Check(OfficeToolReceiptSchema, value)) return value
  throw new Error('office_tool_receipt_invalid')
}

export function parseSessionSnapshot(value: unknown): SessionSnapshot {
  if (Value.Check(SessionSnapshotSchema, value)) return value
  throw new Error('session_snapshot_invalid')
}

export function parseSessionSubscriptionReceipt(value: unknown): SessionSubscriptionReceipt {
  if (Value.Check(SessionSubscriptionReceiptSchema, value)) return value
  throw new Error('session_subscription_receipt_invalid')
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  if (Value.Check(EventEnvelopeSchema, value)) return value
  throw new Error('event_envelope_invalid')
}

export function parseAgentSessionConnectRequest(value: unknown): AgentSessionConnectRequest {
  if (Value.Check(AgentSessionConnectRequestSchema, value)) return value
  throw new Error('agent_session_connect_request_invalid')
}

export function parseAgentSessionCommand(value: unknown): AgentSessionCommand {
  if (Value.Check(AgentSessionCommandSchema, value)) return value
  throw new Error('agent_session_command_invalid')
}

export function parseAgentSessionConnectReceipt(value: unknown): AgentSessionConnectReceipt {
  if (Value.Check(AgentSessionConnectReceiptSchema, value)) return value
  throw new Error('agent_session_connect_receipt_invalid')
}

export function parseOfficeToolCatalog(value: unknown): OfficeToolCatalog {
  if (Value.Check(OfficeToolCatalogSchema, value)) return value
  throw new Error('office_tool_catalog_invalid')
}

export function canonicalizeOfficeToolCatalog(catalog: OfficeToolCatalog): string {
  const entries = [...catalog.entries]
    .sort(
      (left, right) =>
        left.app.localeCompare(right.app) || left.legacyAlias.localeCompare(right.legacyAlias),
    )
    .map((entry) => ({
      app: entry.app,
      legacyAlias: entry.legacyAlias,
      targetId: entry.targetId,
      effect: entry.effect,
      disposition: entry.disposition,
      sourceFile: entry.sourceFile,
    }))
  return `${JSON.stringify(
    {
      schemaVersion: catalog.schemaVersion,
      sourceBaselineCommit: catalog.sourceBaselineCommit,
      entries,
    },
    null,
    2,
  )}\n`
}

export function parseProtocolFrame(frame: string): ProtocolEnvelope {
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame_too_large')
  if (/"[^"\\]*(?:base64|dataUri)[^"\\]*"\s*:/i.test(frame)) {
    throw new Error('inline_binary_forbidden')
  }

  try {
    const value: unknown = JSON.parse(frame)
    if (Value.Check(ProtocolEnvelopeSchema, value)) return value
  } catch {
    // Frame errors never include the untrusted payload.
  }
  throw new Error('protocol_frame_invalid')
}

export function createNdjsonFrameDecoder() {
  const textDecoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''

  function decode(chunk?: Uint8Array): string {
    try {
      return textDecoder.decode(chunk, { stream: chunk !== undefined })
    } catch {
      throw new Error('invalid_utf8')
    }
  }

  return {
    push(chunk: string | Uint8Array): ProtocolEnvelope[] {
      pending += typeof chunk === 'string' ? chunk : decode(chunk)
      const lines = pending.split('\n')
      pending = lines.pop()!
      if (Buffer.byteLength(pending, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame_too_large')
      return lines.filter((line) => line.trim() !== '').map(parseProtocolFrame)
    },
    end(): ProtocolEnvelope[] {
      pending += decode()
      if (pending.trim() !== '') throw new Error('unterminated_frame')
      pending = ''
      return []
    },
  }
}
