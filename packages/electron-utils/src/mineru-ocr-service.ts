import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ProviderOperationStore,
  atomicWriteFile,
  atomicWriteJson,
  type ProviderOperationRecord,
} from '@genoffice/agent-resource'
import type { ArtifactRef } from '@genoffice/agent-runtime-protocol'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { downloadMineruDocx } from './mineru-archive'
import {
  MineruError,
  createMineruClient,
  waitForMineruResult,
  type MineruActiveState,
  type MineruClient,
} from './mineru-client'

const MINERU_CREDENTIAL_SLOT = 'ocr/mineru/default'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const MineruSettingsSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    enabled: Type.Boolean(),
    disclosureVersion: Type.Literal(1),
    updatedAt: Type.String({ minLength: 20, maxLength: 32 }),
  },
  { additionalProperties: false },
)

const ResumeCapsuleSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    batchId: Type.String({ minLength: 1, maxLength: 512 }),
    fileName: Type.String({ pattern: '^[0-9a-f-]{36}\\.pdf$' }),
    expiresAt: Type.String({ minLength: 20, maxLength: 32 }),
    resultUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
)

type MineruSettings = Static<typeof MineruSettingsSchema>
type ResumeCapsule = Static<typeof ResumeCapsuleSchema>

export type MineruCredentialStatus =
  { status: 'available'; generation: number } | { status: 'missing' | 'secure_storage_unavailable' }

export type MineruCredentialBroker = {
  status(slot: string): Promise<MineruCredentialStatus>
  get(slot: string): Promise<{ secretPayload: string } | undefined>
  put(input: {
    slot: string
    providerId: string
    kind: 'api_key'
    expectedGeneration: number
    secretPayload: string
  }): Promise<unknown>
  rotate(input: {
    slot: string
    providerId: string
    kind: 'api_key'
    expectedGeneration: number
    secretPayload: string
  }): Promise<unknown>
  putOperationCapsule(input: {
    operationId: string
    expectedGeneration: number
    generation: number
    payload: string
  }): Promise<unknown>
  getOperationCapsule(
    operationId: string,
  ): Promise<{ generation: number; payload: string } | undefined>
  deleteOperationCapsule(operationId: string, expectedGeneration: number): Promise<unknown>
}

export type MineruOcrStatus = {
  enabled: boolean
  credential: MineruCredentialStatus['status']
}

export type MineruOcrResult = {
  operation: ProviderOperationRecord
  artifact: ArtifactRef
}

export type MineruOcrServiceOptions = {
  rootDirectory: string
  credentialBroker: MineruCredentialBroker
  operationStore?: ProviderOperationStore
  platform?: NodeJS.Platform
  now?: () => Date
  randomUUID?: () => string
  readPdf?: (path: string) => Promise<Uint8Array>
  createClient?: (token: string) => MineruClient
  downloadDocx?: (url: string, options: { signal?: AbortSignal }) => Promise<Uint8Array>
  wait?: (projection: { state: MineruActiveState }, poll: number) => Promise<void>
}

export class MineruOcrServiceError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'MineruOcrServiceError'
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: unknown }).name === 'AbortError'
}

function parseCapsule(payload: string): ResumeCapsule {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new MineruOcrServiceError('mineru_resume_capsule_invalid')
  }
  if (!Value.Check(ResumeCapsuleSchema, parsed)) {
    throw new MineruOcrServiceError('mineru_resume_capsule_invalid')
  }
  return parsed as ResumeCapsule
}

export class MineruOcrService {
  private readonly settingsPath: string
  private readonly operationStore: ProviderOperationStore
  private readonly active = new Map<string, AbortController>()
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly readPdf: (path: string) => Promise<Uint8Array>
  private readonly createClient: (token: string) => MineruClient
  private readonly downloadDocx: NonNullable<MineruOcrServiceOptions['downloadDocx']>
  private readonly wait: NonNullable<MineruOcrServiceOptions['wait']>

  constructor(private readonly options: MineruOcrServiceOptions) {
    this.settingsPath = join(options.rootDirectory, 'state', 'mineru-settings.json')
    this.operationStore =
      options.operationStore ?? new ProviderOperationStore({ rootDirectory: options.rootDirectory })
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
    this.createId = options.randomUUID ?? randomUUID
    this.readPdf = options.readPdf ?? readFile
    this.createClient = options.createClient ?? ((token) => createMineruClient({ token }))
    this.downloadDocx = options.downloadDocx ?? downloadMineruDocx
    this.wait = options.wait ?? (() => Promise.resolve())
  }

  async status(): Promise<MineruOcrStatus> {
    const [settings, credential] = await Promise.all([
      this.readSettings(),
      this.options.credentialBroker.status(MINERU_CREDENTIAL_SLOT),
    ])
    return { enabled: settings.enabled, credential: credential.status }
  }

  async enable(input: { disclosureAccepted: boolean; token: string }): Promise<MineruOcrStatus> {
    if (!input.disclosureAccepted) {
      throw new MineruOcrServiceError('mineru_disclosure_required')
    }
    if (!input.token.trim()) throw new MineruOcrServiceError('mineru_credential_invalid')
    const status = await this.options.credentialBroker.status(MINERU_CREDENTIAL_SLOT)
    if (status.status === 'secure_storage_unavailable') {
      throw new MineruOcrServiceError('mineru_secure_storage_unavailable')
    }
    const write = {
      slot: MINERU_CREDENTIAL_SLOT,
      providerId: 'mineru',
      kind: 'api_key' as const,
      expectedGeneration: status.status === 'available' ? status.generation : 0,
      secretPayload: input.token,
    }
    if (status.status === 'available') await this.options.credentialBroker.rotate(write)
    else await this.options.credentialBroker.put(write)
    await this.writeSettings(true)
    return { enabled: true, credential: 'available' }
  }

  async disable(): Promise<MineruOcrStatus> {
    for (const controller of this.active.values()) controller.abort()
    await this.writeSettings(false)
    const credential = await this.options.credentialBroker.status(MINERU_CREDENTIAL_SLOT)
    return { enabled: false, credential: credential.status }
  }

  async getOperation(operationId: string): Promise<ProviderOperationRecord | undefined> {
    this.assertUuid(operationId)
    return this.operationStore.get(operationId)
  }

  async convert(input: {
    operationId: string
    documentId: string
    sourcePath: string
  }): Promise<MineruOcrResult> {
    this.assertUuid(input.operationId)
    this.assertUuid(input.documentId)
    await this.requireEnabled()
    if (this.active.has(input.operationId)) {
      throw new MineruOcrServiceError('mineru_operation_active')
    }
    if (await this.operationStore.get(input.operationId)) {
      throw new MineruOcrServiceError('mineru_operation_exists')
    }
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString()
    await this.operationStore.commit(
      {
        operationId: input.operationId,
        providerId: 'mineru',
        documentId: input.documentId,
        state: 'preparing',
        generation: 1,
        updatedAt: this.now().toISOString(),
        expiresAt,
      },
      0,
    )
    const controller = new AbortController()
    this.active.set(input.operationId, controller)
    try {
      const pdfBytes = await this.readPdf(input.sourcePath)
      this.assertPdf(pdfBytes)
      const client = await this.authorizedClient()
      const fileName = `${input.operationId}.pdf`
      const allocation = await client.requestLocalUpload(fileName, {
        signal: controller.signal,
      })
      await this.writeCapsule(input.operationId, {
        schemaVersion: 1,
        batchId: allocation.batchId,
        fileName,
        expiresAt,
      })
      await client.upload(allocation.uploadUrl, pdfBytes, { signal: controller.signal })
      await this.update(input.operationId, {
        state: 'dispatched',
        providerState: 'waiting-file',
      })
      return await this.continueExisting(input.operationId, client, controller.signal)
    } catch (error) {
      await this.recordFailure(input.operationId, error)
      throw this.publicError(error)
    } finally {
      this.active.delete(input.operationId)
    }
  }

  async resume(operationId: string): Promise<MineruOcrResult> {
    this.assertUuid(operationId)
    await this.requireEnabled()
    if (this.active.has(operationId)) throw new MineruOcrServiceError('mineru_operation_active')
    const operation = await this.operationStore.get(operationId)
    if (!operation) throw new MineruOcrServiceError('mineru_operation_missing')
    if (operation.state === 'completed' && operation.artifactId) {
      return { operation, artifact: await this.artifactRef(operation.artifactId) }
    }
    const capsuleRecord = await this.options.credentialBroker.getOperationCapsule(operationId)
    if (!capsuleRecord) throw new MineruOcrServiceError('mineru_resume_capsule_missing')
    const capsule = parseCapsule(capsuleRecord.payload)
    if (Date.parse(capsule.expiresAt) <= this.now().getTime()) {
      await this.update(operationId, {
        state: 'interrupted',
        errorCode: 'mineru_resume_expired',
      })
      throw new MineruOcrServiceError('mineru_resume_expired')
    }
    const controller = new AbortController()
    this.active.set(operationId, controller)
    try {
      return await this.continueExisting(
        operationId,
        await this.authorizedClient(),
        controller.signal,
        capsule,
      )
    } catch (error) {
      await this.recordFailure(operationId, error)
      throw this.publicError(error)
    } finally {
      this.active.delete(operationId)
    }
  }

  async recoverPending(): Promise<MineruOcrResult[]> {
    if (!(await this.readSettings()).enabled) return []
    const operations = await this.operationStore.list()
    const recovered: MineruOcrResult[] = []
    for (const operation of operations) {
      if (operation.state === 'completed' && operation.artifactId && !operation.materializedAt) {
        recovered.push({ operation, artifact: await this.artifactRef(operation.artifactId) })
      }
    }
    const candidates = operations.filter((operation) =>
      ['preparing', 'dispatched', 'running', 'validating'].includes(operation.state),
    )
    for (const operation of candidates) {
      const capsule = await this.options.credentialBroker.getOperationCapsule(operation.operationId)
      if (!capsule) {
        await this.update(operation.operationId, {
          state: 'interrupted',
          errorCode: 'mineru_resume_capsule_missing',
        })
        continue
      }
      try {
        recovered.push(await this.resume(operation.operationId))
      } catch {
        // resume records only a stable failed/interrupted projection.
      }
    }
    return recovered
  }

  async cancel(operationId: string): Promise<ProviderOperationRecord> {
    this.assertUuid(operationId)
    const controller = this.active.get(operationId)
    const current = await this.operationStore.get(operationId)
    if (!current) throw new MineruOcrServiceError('mineru_operation_missing')
    if (['completed', 'failed', 'cancelled_local', 'interrupted'].includes(current.state)) {
      return current
    }
    const cancelled = await this.update(operationId, {
      state: 'cancelled_local',
      errorCode: 'mineru_remote_may_continue',
    })
    controller?.abort()
    return cancelled
  }

  async exportArtifact(operationId: string, targetPath: string): Promise<ArtifactRef> {
    this.assertUuid(operationId)
    const operation = await this.operationStore.get(operationId)
    if (operation?.state !== 'completed' || !operation.artifactId) {
      throw new MineruOcrServiceError('mineru_artifact_unavailable')
    }
    const artifactId = operation.artifactId
    const bytes = await readFile(this.artifactPath(artifactId))
    await atomicWriteFile(targetPath, bytes, { platform: this.platform })
    await this.update(operationId, { materializedAt: this.now().toISOString() })
    return this.createArtifactRef(artifactId, bytes)
  }

  private async continueExisting(
    operationId: string,
    client: MineruClient,
    signal: AbortSignal,
    knownCapsule?: ResumeCapsule,
  ): Promise<MineruOcrResult> {
    const stored = knownCapsule
      ? { payload: JSON.stringify(knownCapsule) }
      : await this.options.credentialBroker.getOperationCapsule(operationId)
    if (!stored) throw new MineruOcrServiceError('mineru_resume_capsule_missing')
    const capsule = knownCapsule ?? parseCapsule(stored.payload)
    await this.update(operationId, { state: 'running', providerState: 'pending' })
    const resultUrl =
      capsule.resultUrl ??
      (await waitForMineruResult(client, capsule.batchId, capsule.fileName, {
        signal,
        wait: async (projection, poll) => {
          await this.update(operationId, {
            state: 'running',
            providerState: projection.state,
          })
          await this.wait(projection, poll)
        },
      }))
    await this.writeCapsule(operationId, { ...capsule, resultUrl })
    await this.update(operationId, { state: 'validating', providerState: 'done' })
    const docx = await this.downloadDocx(resultUrl, { signal })
    const artifactId = this.createId()
    this.assertUuid(artifactId)
    await atomicWriteFile(this.artifactPath(artifactId), docx, { platform: this.platform })
    const artifact = this.createArtifactRef(artifactId, docx)
    const operation = await this.update(operationId, {
      state: 'completed',
      providerState: 'done',
      artifactId,
    })
    const capsuleRecord = await this.options.credentialBroker.getOperationCapsule(operationId)
    if (capsuleRecord) {
      await this.options.credentialBroker.deleteOperationCapsule(
        operationId,
        capsuleRecord.generation,
      )
    }
    return { operation, artifact }
  }

  private async authorizedClient(): Promise<MineruClient> {
    const credential = await this.options.credentialBroker.get(MINERU_CREDENTIAL_SLOT)
    if (!credential) throw new MineruOcrServiceError('mineru_credential_missing')
    return this.createClient(credential.secretPayload)
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.readSettings()).enabled) {
      throw new MineruOcrServiceError('mineru_disabled')
    }
  }

  private async readSettings(): Promise<MineruSettings> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.settingsPath, 'utf8'))
    } catch (error) {
      if (missing(error)) {
        return {
          schemaVersion: 1,
          enabled: false,
          disclosureVersion: 1,
          updatedAt: new Date(0).toISOString(),
        }
      }
      throw new MineruOcrServiceError('mineru_settings_invalid')
    }
    if (!Value.Check(MineruSettingsSchema, parsed)) {
      throw new MineruOcrServiceError('mineru_settings_invalid')
    }
    return parsed as MineruSettings
  }

  private writeSettings(enabled: boolean): Promise<void> {
    return atomicWriteJson(
      this.settingsPath,
      {
        schemaVersion: 1,
        enabled,
        disclosureVersion: 1,
        updatedAt: this.now().toISOString(),
      } satisfies MineruSettings,
      { platform: this.platform },
    )
  }

  private async writeCapsule(operationId: string, capsule: ResumeCapsule): Promise<void> {
    if (!Value.Check(ResumeCapsuleSchema, capsule)) {
      throw new MineruOcrServiceError('mineru_resume_capsule_invalid')
    }
    const current = await this.options.credentialBroker.getOperationCapsule(operationId)
    const expectedGeneration = current?.generation ?? 0
    await this.options.credentialBroker.putOperationCapsule({
      operationId,
      expectedGeneration,
      generation: expectedGeneration + 1,
      payload: JSON.stringify(capsule),
    })
  }

  private async update(
    operationId: string,
    patch: Partial<
      Pick<
        ProviderOperationRecord,
        'state' | 'providerState' | 'artifactId' | 'materializedAt' | 'errorCode'
      >
    >,
  ): Promise<ProviderOperationRecord> {
    const current = await this.operationStore.get(operationId)
    if (!current) throw new MineruOcrServiceError('mineru_operation_missing')
    const record: ProviderOperationRecord = {
      ...current,
      ...patch,
      generation: current.generation + 1,
      updatedAt: this.now().toISOString(),
    }
    if (patch.errorCode === undefined) delete record.errorCode
    return this.operationStore.commit(record, current.generation)
  }

  private async recordFailure(operationId: string, error: unknown): Promise<void> {
    const current = await this.operationStore.get(operationId)
    if (!current || current.state === 'completed' || current.state === 'cancelled_local') return
    const errorCode = isAbort(error)
      ? 'mineru_remote_may_continue'
      : error instanceof MineruError || error instanceof MineruOcrServiceError
        ? error.code
        : 'mineru_operation_failed'
    await this.update(operationId, {
      state: isAbort(error) ? 'cancelled_local' : 'failed',
      errorCode,
    })
  }

  private publicError(error: unknown): MineruOcrServiceError {
    if (error instanceof MineruOcrServiceError) return error
    if (error instanceof MineruError) return new MineruOcrServiceError(error.code)
    if (isAbort(error)) return new MineruOcrServiceError('mineru_cancelled_local')
    return new MineruOcrServiceError('mineru_operation_failed')
  }

  private artifactPath(artifactId: string): string {
    return join(this.options.rootDirectory, 'assets', 'provider', 'mineru', `${artifactId}.docx`)
  }

  private async artifactRef(artifactId: string): Promise<ArtifactRef> {
    this.assertUuid(artifactId)
    return this.createArtifactRef(artifactId, await readFile(this.artifactPath(artifactId)))
  }

  private createArtifactRef(artifactId: string, bytes: Uint8Array): ArtifactRef {
    return {
      artifactId,
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      displayName: 'MinerU conversion.docx',
    }
  }

  private assertUuid(value: string): void {
    if (!UUID_PATTERN.test(value)) throw new MineruOcrServiceError('mineru_operation_invalid')
  }

  private assertPdf(bytes: Uint8Array): void {
    if (
      bytes.byteLength < 5 ||
      String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-' ||
      bytes.byteLength > 256 * 1024 * 1024
    ) {
      throw new MineruOcrServiceError('mineru_pdf_invalid')
    }
  }
}
