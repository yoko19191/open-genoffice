import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson } from './atomic-file'

const OperationIdSchema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
})

export const ProviderOperationRecordSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    providerId: Type.String({ pattern: '^[a-z0-9][a-z0-9._-]{0,127}$' }),
    documentId: OperationIdSchema,
    state: Type.Union([
      Type.Literal('preparing'),
      Type.Literal('dispatched'),
      Type.Literal('running'),
      Type.Literal('validating'),
      Type.Literal('completed'),
      Type.Literal('failed'),
      Type.Literal('cancelled_local'),
      Type.Literal('interrupted'),
    ]),
    providerState: Type.Optional(
      Type.Union([
        Type.Literal('waiting-file'),
        Type.Literal('pending'),
        Type.Literal('running'),
        Type.Literal('converting'),
        Type.Literal('uploading'),
        Type.Literal('done'),
      ]),
    ),
    generation: Type.Integer({ minimum: 1 }),
    updatedAt: Type.String({ minLength: 20, maxLength: 32 }),
    expiresAt: Type.String({ minLength: 20, maxLength: 32 }),
    artifactId: Type.Optional(OperationIdSchema),
    materializedAt: Type.Optional(Type.String({ minLength: 20, maxLength: 32 })),
    errorCode: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' })),
  },
  { additionalProperties: false },
)

const ProviderOperationIndexSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operations: Type.Array(ProviderOperationRecordSchema),
  },
  { additionalProperties: false },
)

export type ProviderOperationRecord = Static<typeof ProviderOperationRecordSchema>
type ProviderOperationIndex = Static<typeof ProviderOperationIndexSchema>

export class ProviderOperationStoreError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ProviderOperationStoreError'
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class ProviderOperationStore {
  private queue = Promise.resolve()
  private readonly path: string
  private readonly platform: NodeJS.Platform

  constructor(options: { rootDirectory: string; platform?: NodeJS.Platform }) {
    this.path = join(options.rootDirectory, 'state', 'provider-operations.json')
    this.platform = options.platform ?? process.platform
  }

  async get(operationId: string): Promise<ProviderOperationRecord | undefined> {
    return (await this.read()).operations.find((operation) => operation.operationId === operationId)
  }

  async list(): Promise<ProviderOperationRecord[]> {
    return [...(await this.read()).operations]
  }

  commit(
    record: ProviderOperationRecord,
    expectedGeneration: number,
  ): Promise<ProviderOperationRecord> {
    return this.serialize(async () => {
      if (
        !Value.Check(ProviderOperationRecordSchema, record) ||
        record.generation !== expectedGeneration + 1
      ) {
        throw new ProviderOperationStoreError('provider_operation_invalid')
      }
      const index = await this.read()
      const current = index.operations.find((item) => item.operationId === record.operationId)
      if ((current?.generation ?? 0) !== expectedGeneration) {
        throw new ProviderOperationStoreError('provider_operation_generation_conflict')
      }
      const next: ProviderOperationIndex = {
        schemaVersion: 1,
        operations: [
          ...index.operations.filter((item) => item.operationId !== record.operationId),
          record,
        ].sort((left, right) => left.operationId.localeCompare(right.operationId)),
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await atomicWriteJson(this.path, next, { platform: this.platform })
      return record
    })
  }

  private async read(): Promise<ProviderOperationIndex> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (missing(error)) return { schemaVersion: 1, operations: [] }
      throw new ProviderOperationStoreError('provider_operation_index_invalid')
    }
    if (!Value.Check(ProviderOperationIndexSchema, parsed)) {
      throw new ProviderOperationStoreError('provider_operation_index_invalid')
    }
    return parsed as ProviderOperationIndex
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
