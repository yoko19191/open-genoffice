import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderOperationStore } from '@genoffice/agent-resource'
import { strToU8, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MineruOcrService,
  MineruOcrServiceError,
  type MineruCredentialBroker,
  type MineruCredentialStatus,
} from '../src/mineru-ocr-service'
import type { MineruClient } from '../src/mineru-client'
import { MineruError } from '../src/mineru-client'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222'
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-08-10T00:00:00.000Z')

class MemoryBroker implements MineruCredentialBroker {
  credential: { generation: number; secretPayload: string } | undefined
  capsules = new Map<string, { generation: number; payload: string }>()

  async status(): Promise<MineruCredentialStatus> {
    return this.credential
      ? { status: 'available', generation: this.credential.generation }
      : { status: 'missing' }
  }

  async get(): Promise<{ secretPayload: string } | undefined> {
    return this.credential && { secretPayload: this.credential.secretPayload }
  }

  async put(input: { expectedGeneration: number; secretPayload: string }): Promise<void> {
    if (input.expectedGeneration !== 0 || this.credential) throw new Error('credential_conflict')
    this.credential = { generation: 1, secretPayload: input.secretPayload }
  }

  async rotate(input: { expectedGeneration: number; secretPayload: string }): Promise<void> {
    if (!this.credential || input.expectedGeneration !== this.credential.generation) {
      throw new Error('credential_conflict')
    }
    this.credential = {
      generation: this.credential.generation + 1,
      secretPayload: input.secretPayload,
    }
  }

  async putOperationCapsule(input: {
    operationId: string
    expectedGeneration: number
    generation: number
    payload: string
  }): Promise<void> {
    const current = this.capsules.get(input.operationId)
    if (
      (current?.generation ?? 0) !== input.expectedGeneration ||
      input.generation !== input.expectedGeneration + 1
    ) {
      throw new Error('capsule_conflict')
    }
    this.capsules.set(input.operationId, {
      generation: input.generation,
      payload: input.payload,
    })
  }

  async getOperationCapsule(
    operationId: string,
  ): Promise<{ generation: number; payload: string } | undefined> {
    return this.capsules.get(operationId)
  }

  async deleteOperationCapsule(operationId: string, expectedGeneration: number): Promise<void> {
    if (this.capsules.get(operationId)?.generation !== expectedGeneration) {
      throw new Error('capsule_conflict')
    }
    this.capsules.delete(operationId)
  }
}

function completedClient(calls: string[]): MineruClient {
  let polls = 0
  return {
    async requestLocalUpload(fileName) {
      calls.push(`request:${fileName}`)
      return {
        batchId: 'private-batch-id',
        uploadUrl: 'https://signed.example/private-upload',
      }
    },
    async upload(url, bytes) {
      calls.push(`upload:${url}:${bytes.byteLength}`)
    },
    async getBatchResult(batchId, fileName) {
      calls.push(`poll:${batchId}:${fileName}`)
      polls += 1
      return polls === 1
        ? { state: 'converting' }
        : { state: 'done', resultUrl: 'https://signed.example/private-result' }
    },
  }
}

describe('MinerU OCR main-process lifecycle', () => {
  let root: string
  let broker: MemoryBroker

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mineru-ocr-service-'))
    broker = new MemoryBroker()
  })

  it('requires disclosure and persists a write-only credential without any network call', async () => {
    const createClient = vi.fn()
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      createClient,
      now: () => NOW,
    })
    await expect(
      service.enable({ disclosureAccepted: false, token: 'private-token' }),
    ).rejects.toEqual(new MineruOcrServiceError('mineru_disclosure_required'))
    await expect(
      service.enable({ disclosureAccepted: true, token: 'private-token' }),
    ).resolves.toEqual({ enabled: true, credential: 'available' })
    expect(createClient).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'state/mineru-settings.json'), 'utf8')).not.toContain(
      'private-token',
    )
    await expect(service.status()).resolves.toEqual({
      enabled: true,
      credential: 'available',
    })
    await expect(
      service.enable({ disclosureAccepted: true, token: 'rotated-token' }),
    ).resolves.toEqual({ enabled: true, credential: 'available' })
    expect(broker.credential).toEqual({ generation: 2, secretPayload: 'rotated-token' })
    await expect(service.disable()).resolves.toEqual({
      enabled: false,
      credential: 'available',
    })
  })

  it('rejects empty credentials and unavailable secure storage before writing settings', async () => {
    const service = new MineruOcrService({ rootDirectory: root, credentialBroker: broker })
    await expect(service.enable({ disclosureAccepted: true, token: '   ' })).rejects.toEqual(
      new MineruOcrServiceError('mineru_credential_invalid'),
    )
    vi.spyOn(broker, 'status').mockResolvedValueOnce({
      status: 'secure_storage_unavailable',
    })
    await expect(
      service.enable({ disclosureAccepted: true, token: 'private-token' }),
    ).rejects.toEqual(new MineruOcrServiceError('mineru_secure_storage_unavailable'))
    await expect(service.status()).resolves.toEqual({ enabled: false, credential: 'missing' })
  })

  it('does not read a PDF, credential or network while disabled', async () => {
    const readPdf = vi.fn()
    const createClient = vi.fn()
    const get = vi.spyOn(broker, 'get')
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      readPdf,
      createClient,
    })
    await expect(
      service.convert({
        operationId: OPERATION_ID,
        documentId: DOCUMENT_ID,
        sourcePath: '/private/source.pdf',
      }),
    ).rejects.toEqual(new MineruOcrServiceError('mineru_disabled'))
    expect(readPdf).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
    await expect(service.recoverPending()).resolves.toEqual([])
  })

  it('dispatches one PDF once and registers only an opaque validated ArtifactRef', async () => {
    const calls: string[] = []
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      readPdf: async () => new TextEncoder().encode('%PDF-private document content'),
      createClient: (token) => {
        expect(token).toBe('private-token')
        return completedClient(calls)
      },
      downloadDocx: async (url) => {
        calls.push(`download:${url}`)
        return new Uint8Array([1, 2, 3, 4])
      },
      wait: async () => undefined,
      randomUUID: () => ARTIFACT_ID,
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    const result = await service.convert({
      operationId: OPERATION_ID,
      documentId: DOCUMENT_ID,
      sourcePath: '/private/source.pdf',
    })
    expect(calls.filter((call) => call.startsWith('request:'))).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith('upload:'))).toHaveLength(1)
    expect(result.operation).toMatchObject({
      state: 'completed',
      providerState: 'done',
      artifactId: ARTIFACT_ID,
    })
    expect(result.artifact).toMatchObject({
      artifactId: ARTIFACT_ID,
      byteLength: 4,
      displayName: 'MinerU conversion.docx',
    })
    await expect(
      readFile(join(root, 'assets/provider/mineru', `${ARTIFACT_ID}.docx`)),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
    expect(broker.capsules.has(OPERATION_ID)).toBe(false)
    const redacted = await readFile(join(root, 'state/provider-operations.json'), 'utf8')
    for (const forbidden of [
      'private-token',
      'private-batch-id',
      'signed.example',
      '/private/source.pdf',
      'private document content',
    ]) {
      expect(redacted).not.toContain(forbidden)
    }
    await expect(service.resume(OPERATION_ID)).resolves.toEqual(result)
    await expect(service.cancel(OPERATION_ID)).resolves.toMatchObject({ state: 'completed' })
    await expect(service.recoverPending()).resolves.toEqual([result])
    const exported = join(root, 'user-selected.docx')
    await expect(service.exportArtifact(OPERATION_ID, exported)).resolves.toEqual(result.artifact)
    await expect(readFile(exported)).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({
      materializedAt: NOW.toISOString(),
    })
    await expect(service.recoverPending()).resolves.toEqual([])
    await expect(service.exportArtifact(DOCUMENT_ID, exported)).rejects.toEqual(
      new MineruOcrServiceError('mineru_artifact_unavailable'),
    )
    await expect(service.exportArtifact('../escape', exported)).rejects.toEqual(
      new MineruOcrServiceError('mineru_operation_invalid'),
    )
  })

  it('resumes only polling and download for the same batch without reading or resubmitting', async () => {
    const operationStore = new ProviderOperationStore({ rootDirectory: root })
    await operationStore.commit(
      {
        operationId: OPERATION_ID,
        providerId: 'mineru',
        documentId: DOCUMENT_ID,
        state: 'dispatched',
        providerState: 'waiting-file',
        generation: 1,
        updatedAt: NOW.toISOString(),
        expiresAt: '2026-08-11T00:00:00.000Z',
      },
      0,
    )
    broker.credential = { generation: 1, secretPayload: 'private-token' }
    broker.capsules.set(OPERATION_ID, {
      generation: 1,
      payload: JSON.stringify({
        schemaVersion: 1,
        batchId: 'same-private-batch',
        fileName: `${OPERATION_ID}.pdf`,
        expiresAt: '2026-08-11T00:00:00.000Z',
      }),
    })
    const requestLocalUpload = vi.fn(async () => {
      throw new Error('must_not_resubmit')
    })
    const upload = vi.fn(async () => {
      throw new Error('must_not_reupload')
    })
    const readPdf = vi.fn()
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      operationStore,
      readPdf,
      createClient: () => ({
        requestLocalUpload,
        upload,
        getBatchResult: async (batchId) => {
          expect(batchId).toBe('same-private-batch')
          return { state: 'done', resultUrl: 'https://signed.example/result' }
        },
      }),
      downloadDocx: async () => new Uint8Array([5, 6, 7]),
      randomUUID: () => ARTIFACT_ID,
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    await expect(service.recoverPending()).resolves.toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({ state: 'completed', artifactId: ARTIFACT_ID }),
      }),
    ])
    expect(readPdf).not.toHaveBeenCalled()
    expect(requestLocalUpload).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('cancels locally while making it explicit that the remote batch may continue', async () => {
    let pollStarted!: () => void
    const polling = new Promise<void>((resolve) => {
      pollStarted = resolve
    })
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      readPdf: async () => new TextEncoder().encode('%PDF-private'),
      createClient: () => ({
        requestLocalUpload: async () => ({
          batchId: 'private-batch',
          uploadUrl: 'https://signed.example/upload',
        }),
        upload: async () => undefined,
        getBatchResult: async (_batchId, _fileName, options) => {
          pollStarted()
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            )
          })
        },
      }),
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    const conversion = service.convert({
      operationId: OPERATION_ID,
      documentId: DOCUMENT_ID,
      sourcePath: '/private/source.pdf',
    })
    const cancelledConversion = expect(conversion).rejects.toEqual(
      new MineruOcrServiceError('mineru_cancelled_local'),
    )
    await polling
    await expect(service.cancel(OPERATION_ID)).resolves.toMatchObject({
      state: 'cancelled_local',
      errorCode: 'mineru_remote_may_continue',
    })
    await cancelledConversion
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({
      state: 'cancelled_local',
      errorCode: 'mineru_remote_may_continue',
    })
  })

  it('marks an expired Resume Capsule interrupted before creating a network client', async () => {
    const operationStore = new ProviderOperationStore({ rootDirectory: root })
    await operationStore.commit(
      {
        operationId: OPERATION_ID,
        providerId: 'mineru',
        documentId: DOCUMENT_ID,
        state: 'running',
        providerState: 'converting',
        generation: 1,
        updatedAt: NOW.toISOString(),
        expiresAt: NOW.toISOString(),
      },
      0,
    )
    broker.capsules.set(OPERATION_ID, {
      generation: 1,
      payload: JSON.stringify({
        schemaVersion: 1,
        batchId: 'expired-private-batch',
        fileName: `${OPERATION_ID}.pdf`,
        expiresAt: NOW.toISOString(),
      }),
    })
    const createClient = vi.fn()
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      operationStore,
      createClient,
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    await expect(service.resume(OPERATION_ID)).rejects.toEqual(
      new MineruOcrServiceError('mineru_resume_expired'),
    )
    expect(createClient).not.toHaveBeenCalled()
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({
      state: 'interrupted',
      errorCode: 'mineru_resume_expired',
    })
  })

  it('fails closed on invalid identifiers, PDFs, settings and Resume Capsules', async () => {
    const createClient = vi.fn(() => completedClient([]))
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      readPdf: async () => new Uint8Array([1, 2, 3]),
      createClient,
      now: () => NOW,
    })
    await expect(service.getOperation('../escape')).rejects.toEqual(
      new MineruOcrServiceError('mineru_operation_invalid'),
    )
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    await expect(
      service.convert({
        operationId: OPERATION_ID,
        documentId: DOCUMENT_ID,
        sourcePath: '/private/invalid.pdf',
      }),
    ).rejects.toEqual(new MineruOcrServiceError('mineru_pdf_invalid'))
    expect(createClient).not.toHaveBeenCalled()

    const secondRoot = await mkdtemp(join(tmpdir(), 'mineru-invalid-settings-'))
    await mkdir(join(secondRoot, 'state'))
    await writeFile(join(secondRoot, 'state/mineru-settings.json'), '{not-json')
    const invalidJson = new MineruOcrService({
      rootDirectory: secondRoot,
      credentialBroker: new MemoryBroker(),
    })
    await expect(invalidJson.status()).rejects.toEqual(
      new MineruOcrServiceError('mineru_settings_invalid'),
    )
    await writeFile(join(secondRoot, 'state/mineru-settings.json'), '{}')
    await expect(invalidJson.status()).rejects.toEqual(
      new MineruOcrServiceError('mineru_settings_invalid'),
    )
  })

  it.each(['not-json', JSON.stringify({ schemaVersion: 1 })])(
    'rejects a corrupt Resume Capsule without network: %s',
    async (payload) => {
      const operationStore = new ProviderOperationStore({ rootDirectory: root })
      await operationStore.commit(
        {
          operationId: OPERATION_ID,
          providerId: 'mineru',
          documentId: DOCUMENT_ID,
          state: 'running',
          generation: 1,
          updatedAt: NOW.toISOString(),
          expiresAt: '2026-08-11T00:00:00.000Z',
        },
        0,
      )
      broker.capsules.set(OPERATION_ID, { generation: 1, payload })
      const createClient = vi.fn()
      const service = new MineruOcrService({
        rootDirectory: root,
        credentialBroker: broker,
        operationStore,
        createClient,
        now: () => NOW,
      })
      await service.enable({ disclosureAccepted: true, token: 'private-token' })
      await expect(service.resume(OPERATION_ID)).rejects.toEqual(
        new MineruOcrServiceError('mineru_resume_capsule_invalid'),
      )
      expect(createClient).not.toHaveBeenCalled()
    },
  )

  it('rejects missing operations, capsules, credentials and duplicate operations', async () => {
    const operationStore = new ProviderOperationStore({ rootDirectory: root })
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      operationStore,
      readPdf: async () => new TextEncoder().encode('%PDF-private'),
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    await expect(service.resume(OPERATION_ID)).rejects.toEqual(
      new MineruOcrServiceError('mineru_operation_missing'),
    )
    await expect(service.cancel(OPERATION_ID)).rejects.toEqual(
      new MineruOcrServiceError('mineru_operation_missing'),
    )
    await operationStore.commit(
      {
        operationId: OPERATION_ID,
        providerId: 'mineru',
        documentId: DOCUMENT_ID,
        state: 'preparing',
        generation: 1,
        updatedAt: NOW.toISOString(),
        expiresAt: '2026-08-11T00:00:00.000Z',
      },
      0,
    )
    await expect(service.resume(OPERATION_ID)).rejects.toEqual(
      new MineruOcrServiceError('mineru_resume_capsule_missing'),
    )
    await expect(service.recoverPending()).resolves.toEqual([])
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({
      state: 'interrupted',
      errorCode: 'mineru_resume_capsule_missing',
    })
    await expect(
      service.convert({
        operationId: OPERATION_ID,
        documentId: DOCUMENT_ID,
        sourcePath: '/private/source.pdf',
      }),
    ).rejects.toEqual(new MineruOcrServiceError('mineru_operation_exists'))
  })

  it.each([
    [new MineruError('mineru_service_failed', 'service'), 'mineru_service_failed'],
    [new Error('private detail'), 'mineru_operation_failed'],
  ])('records only a stable public failure code', async (failure, expectedCode) => {
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      readPdf: async () => new TextEncoder().encode('%PDF-private'),
      createClient: () => {
        throw failure
      },
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    await expect(
      service.convert({
        operationId: OPERATION_ID,
        documentId: DOCUMENT_ID,
        sourcePath: '/private/source.pdf',
      }),
    ).rejects.toEqual(new MineruOcrServiceError(expectedCode))
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({
      state: 'failed',
      errorCode: expectedCode,
    })
  })

  it('uses production defaults for file read, client, polling, download, clock and artifact ID', async () => {
    const sourcePath = join(root, 'source.pdf')
    await writeFile(sourcePath, '%PDF-private')
    const docx = zipSync({
      '[Content_Types].xml': strToU8('wordprocessingml.document.main+xml'),
      'word/document.xml': strToU8('<w:document/>'),
    })
    const archive = zipSync({ 'result.docx': docx })
    const responses = [
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            batch_id: 'private-batch',
            file_urls: ['https://signed.example/upload'],
          },
        }),
      ),
      new Response(null, { status: 200 }),
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            extract_result: [{ file_name: `${OPERATION_ID}.pdf`, state: 'pending' }],
          },
        }),
      ),
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            extract_result: [
              {
                file_name: `${OPERATION_ID}.pdf`,
                state: 'done',
                full_zip_url: 'https://signed.example/result',
              },
            ],
          },
        }),
      ),
      new Response(new Uint8Array(archive), { status: 200 }),
    ]
    const fetch = vi.fn(async () => responses.shift()!)
    vi.stubGlobal('fetch', fetch)
    try {
      const service = new MineruOcrService({ rootDirectory: root, credentialBroker: broker })
      await service.enable({ disclosureAccepted: true, token: 'private-token' })
      await expect(
        service.convert({
          operationId: OPERATION_ID,
          documentId: DOCUMENT_ID,
          sourcePath,
        }),
      ).resolves.toMatchObject({ operation: { state: 'completed' } })
      expect(fetch).toHaveBeenCalledTimes(5)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a second active conversion and disable aborts only local work', async () => {
    let polling!: () => void
    const pollStarted = new Promise<void>((resolve) => {
      polling = resolve
    })
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      readPdf: async () => new TextEncoder().encode('%PDF-private'),
      createClient: () => ({
        requestLocalUpload: async () => ({
          batchId: 'private-batch',
          uploadUrl: 'https://signed.example/upload',
        }),
        upload: async () => undefined,
        getBatchResult: async (_batch, _file, options) => {
          polling()
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            )
          })
        },
      }),
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    const first = service.convert({
      operationId: OPERATION_ID,
      documentId: DOCUMENT_ID,
      sourcePath: '/private/source.pdf',
    })
    const cancelledConversion = expect(first).rejects.toEqual(
      new MineruOcrServiceError('mineru_cancelled_local'),
    )
    await pollStarted
    await expect(
      service.convert({
        operationId: OPERATION_ID,
        documentId: DOCUMENT_ID,
        sourcePath: '/private/source.pdf',
      }),
    ).rejects.toEqual(new MineruOcrServiceError('mineru_operation_active'))
    await expect(service.disable()).resolves.toEqual({
      enabled: false,
      credential: 'available',
    })
    await cancelledConversion
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({
      state: 'cancelled_local',
      errorCode: 'mineru_remote_may_continue',
    })
  })

  it('records failures raised while resuming and rejects concurrent resume attempts', async () => {
    const operationStore = new ProviderOperationStore({ rootDirectory: root })
    await operationStore.commit(
      {
        operationId: OPERATION_ID,
        providerId: 'mineru',
        documentId: DOCUMENT_ID,
        state: 'running',
        generation: 1,
        updatedAt: NOW.toISOString(),
        expiresAt: '2026-08-11T00:00:00.000Z',
      },
      0,
    )
    broker.capsules.set(OPERATION_ID, {
      generation: 1,
      payload: JSON.stringify({
        schemaVersion: 1,
        batchId: 'private-batch',
        fileName: `${OPERATION_ID}.pdf`,
        expiresAt: '2026-08-11T00:00:00.000Z',
      }),
    })
    let rejectPoll!: (error: Error) => void
    let polling!: () => void
    const pollStarted = new Promise<void>((resolve) => {
      polling = resolve
    })
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      operationStore,
      createClient: () => ({
        requestLocalUpload: vi.fn(),
        upload: vi.fn(),
        getBatchResult: async () => {
          polling()
          return new Promise((_resolve, reject) => {
            rejectPoll = reject
          })
        },
      }),
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    const first = service.resume(OPERATION_ID)
    const failedResume = expect(first).rejects.toEqual(
      new MineruOcrServiceError('mineru_service_failed'),
    )
    await pollStarted
    await expect(service.resume(OPERATION_ID)).rejects.toEqual(
      new MineruOcrServiceError('mineru_operation_active'),
    )
    rejectPoll(new MineruError('mineru_service_failed', 'service'))
    await failedResume
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({
      state: 'failed',
      errorCode: 'mineru_service_failed',
    })
  })

  it.each([
    ['missing credential', 'credential'],
    ['invalid allocated capsule', 'capsule'],
    ['missing stored capsule', 'stored'],
    ['invalid artifact ID', 'artifact'],
  ])('fails closed for %s', async (_case, mode) => {
    const service = new MineruOcrService({
      rootDirectory: root,
      credentialBroker: broker,
      readPdf: async () => new TextEncoder().encode('%PDF-private'),
      createClient: () => ({
        requestLocalUpload: async () => ({
          batchId: mode === 'capsule' ? '' : 'private-batch',
          uploadUrl: 'https://signed.example/upload',
        }),
        upload: async () => {
          if (mode === 'stored') broker.capsules.delete(OPERATION_ID)
        },
        getBatchResult: async () => ({
          state: 'done',
          resultUrl: 'https://signed.example/result',
        }),
      }),
      downloadDocx: async () => new Uint8Array([1]),
      randomUUID: () => (mode === 'artifact' ? 'invalid' : ARTIFACT_ID),
      now: () => NOW,
    })
    await service.enable({ disclosureAccepted: true, token: 'private-token' })
    if (mode === 'credential') broker.credential = undefined
    await expect(
      service.convert({
        operationId: OPERATION_ID,
        documentId: DOCUMENT_ID,
        sourcePath: '/private/source.pdf',
      }),
    ).rejects.toBeInstanceOf(MineruOcrServiceError)
    await expect(service.getOperation(OPERATION_ID)).resolves.toMatchObject({ state: 'failed' })
  })
})
