import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SecureStorageBroker,
  SecureStorageBrokerError,
  type SafeStorageAdapter,
  type SecureStorageFailurePoint,
} from '../src/secure-storage-broker'

const SLOT = 'model/openai/default'
const PROVIDER_ID = 'openai'
const API_KEY_SECRET = JSON.stringify({ type: 'api_key', key: 'sk-secret-canary' })
const OAUTH_SECRET = JSON.stringify({
  type: 'oauth',
  access: 'oauth-access-canary',
  refresh: 'oauth-refresh-canary',
  expires: 4_102_444_800_000,
})
let credentialSequence = 0

function fakeSafeStorage(
  options: {
    available?: boolean
    backend?: ReturnType<SafeStorageAdapter['getSelectedStorageBackend']>
    shouldReEncrypt?: boolean
    encryptFails?: boolean
    decryptFails?: boolean
  } = {},
) {
  const calls: string[] = []
  let shouldReEncrypt = options.shouldReEncrypt ?? false
  const adapter: SafeStorageAdapter = {
    isAsyncEncryptionAvailable: async () => options.available ?? true,
    getSelectedStorageBackend: () => options.backend ?? 'unknown',
    async encryptStringAsync(value) {
      if (options.encryptFails) throw new Error('fake_encrypt_failure')
      calls.push(`encrypt:${value.length}`)
      return Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`)
    },
    async decryptStringAsync(value) {
      if (options.decryptFails) throw new Error('fake_decrypt_failure')
      calls.push(`decrypt:${value.length}`)
      const result = Buffer.from(value.toString().slice('cipher:'.length), 'base64').toString()
      const current = shouldReEncrypt
      shouldReEncrypt = false
      return { result, shouldReEncrypt: current }
    },
  }
  return { adapter, calls }
}

async function createBroker(options: {
  platform?: NodeJS.Platform
  available?: boolean
  backend?: ReturnType<SafeStorageAdapter['getSelectedStorageBackend']>
  shouldReEncrypt?: boolean
  encryptFails?: boolean
  decryptFails?: boolean
  rootDirectory?: string
  failAt?: SecureStorageFailurePoint
}) {
  const rootDirectory =
    options.rootDirectory ?? (await mkdtemp(join(tmpdir(), 'secure-storage-broker-')))
  const storage = fakeSafeStorage(options)
  const broker = await SecureStorageBroker.create({
    rootDirectory,
    runtimeVersion: '1.0.0',
    platform: options.platform ?? 'darwin',
    safeStorage: storage.adapter,
    randomUUID: () => {
      credentialSequence += 1
      return `00000000-0000-4000-8000-${credentialSequence.toString().padStart(12, '0')}`
    },
    failAt: options.failAt,
  })
  return { broker, rootDirectory, calls: storage.calls }
}

describe('Electron main SecureStorageBroker', () => {
  it('stores operation Resume Capsules by generation without plaintext or traversal', async () => {
    const { broker, rootDirectory } = await createBroker({ platform: 'darwin' })
    const operationId = '11111111-1111-4111-8111-111111111111'
    const privateCapsule = JSON.stringify({
      batchId: 'private-batch-id',
      uploadUrl: 'https://signed.example/private',
      resultUrl: 'https://result.example/private',
    })
    await expect(
      broker.putOperationCapsule({
        operationId,
        expectedGeneration: 0,
        generation: 1,
        payload: privateCapsule,
      }),
    ).resolves.toEqual({ operationId, generation: 1 })
    await expect(broker.getOperationCapsule(operationId)).resolves.toEqual({
      operationId,
      generation: 1,
      payload: privateCapsule,
    })
    await expect(
      broker.putOperationCapsule({
        operationId,
        expectedGeneration: 0,
        generation: 2,
        payload: privateCapsule,
      }),
    ).rejects.toEqual(new SecureStorageBrokerError('operation_capsule_generation_conflict'))
    const bytes = await readFile(
      join(rootDirectory, 'state/secure-store/operation-capsules', `${operationId}.bin`),
    )
    expect(bytes.toString()).not.toContain('private-batch-id')
    await expect(broker.getOperationCapsule('../escape')).rejects.toEqual(
      new SecureStorageBrokerError('operation_capsule_invalid'),
    )
    await expect(broker.deleteOperationCapsule(operationId, 1)).resolves.toEqual({
      operationId,
      generation: 1,
      status: 'deleted',
    })
    await expect(broker.getOperationCapsule(operationId)).resolves.toBeUndefined()
  })

  it.each(['darwin', 'win32'] as const)(
    'persists and reads an API key through system storage on %s without plaintext files',
    async (platform) => {
      const { broker, rootDirectory, calls } = await createBroker({ platform })
      const saved = await broker.put({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'api_key',
        expectedGeneration: 0,
        secretPayload: API_KEY_SECRET,
      })

      expect(saved).toMatchObject({ slot: SLOT, generation: 1, status: 'available' })
      await expect(broker.get(SLOT)).resolves.toEqual({
        metadata: saved,
        secretPayload: API_KEY_SECRET,
      })
      await expect(broker.status(SLOT)).resolves.toEqual(saved)
      expect(calls).toEqual([
        `encrypt:${API_KEY_SECRET.length}`,
        expect.stringMatching(/^decrypt:\d+$/),
      ])

      const index = await readFile(join(rootDirectory, 'state/secure-store/index.json'), 'utf8')
      const [blob] = await readdir(join(rootDirectory, 'state/secure-store/blobs'))
      const ciphertext = await readFile(join(rootDirectory, 'state/secure-store/blobs', blob))
      for (const canary of ['sk-secret-canary', API_KEY_SECRET]) {
        expect(index).not.toContain(canary)
        expect(ciphertext.toString()).not.toContain(canary)
      }
    },
  )

  it.each([
    { available: false, backend: 'gnome_libsecret' as const },
    { available: true, backend: 'basic_text' as const },
    { available: true, backend: 'unknown' as const },
  ])('hard-fails Linux persistence for an unsafe backend: %j', async (backend) => {
    const { broker, rootDirectory } = await createBroker({ platform: 'linux', ...backend })
    await expect(
      broker.put({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'api_key',
        expectedGeneration: 0,
        secretPayload: API_KEY_SECRET,
      }),
    ).rejects.toEqual(new SecureStorageBrokerError('secure_storage_unavailable'))
    await expect(broker.status(SLOT)).resolves.toEqual({
      slot: SLOT,
      status: 'secure_storage_unavailable',
    })
    await expect(
      access(join(rootDirectory, 'state/secure-store/index.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses generation CAS, serialized slots, and atomic old-or-new crash recovery', async () => {
    const initial = await createBroker({ platform: 'linux', backend: 'gnome_libsecret' })
    const generation1 = await initial.broker.put({
      slot: SLOT,
      providerId: PROVIDER_ID,
      kind: 'oauth',
      expectedGeneration: 0,
      secretPayload: OAUTH_SECRET,
    })
    await expect(
      initial.broker.rotate({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'oauth',
        expectedGeneration: 0,
        secretPayload: `${OAUTH_SECRET}-stale`,
      }),
    ).rejects.toEqual(new SecureStorageBrokerError('credential_generation_conflict'))

    const afterBlob = await createBroker({
      platform: 'linux',
      backend: 'gnome_libsecret',
      rootDirectory: initial.rootDirectory,
      failAt: 'after_blob_commit',
    })
    await expect(
      afterBlob.broker.rotate({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'oauth',
        expectedGeneration: generation1.generation,
        secretPayload: `${OAUTH_SECRET}-generation-2`,
      }),
    ).rejects.toThrow('injected_secure_storage_failure')
    const recoveredOld = await createBroker({
      platform: 'linux',
      backend: 'gnome_libsecret',
      rootDirectory: initial.rootDirectory,
    })
    await expect(recoveredOld.broker.get(SLOT)).resolves.toMatchObject({
      metadata: { generation: 1 },
      secretPayload: OAUTH_SECRET,
    })

    const afterIndex = await createBroker({
      platform: 'linux',
      backend: 'gnome_libsecret',
      rootDirectory: initial.rootDirectory,
      failAt: 'after_index_commit',
    })
    await expect(
      afterIndex.broker.rotate({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'oauth',
        expectedGeneration: 1,
        secretPayload: `${OAUTH_SECRET}-generation-2`,
      }),
    ).rejects.toThrow('injected_secure_storage_failure')
    const recoveredNew = await createBroker({
      platform: 'linux',
      backend: 'gnome_libsecret',
      rootDirectory: initial.rootDirectory,
    })
    await expect(recoveredNew.broker.get(SLOT)).resolves.toMatchObject({
      metadata: { generation: 2 },
      secretPayload: `${OAUTH_SECRET}-generation-2`,
    })

    const concurrent = await Promise.allSettled([
      recoveredNew.broker.rotate({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'oauth',
        expectedGeneration: 2,
        secretPayload: `${OAUTH_SECRET}-generation-3a`,
      }),
      recoveredNew.broker.rotate({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'oauth',
        expectedGeneration: 2,
        secretPayload: `${OAUTH_SECRET}-generation-3b`,
      }),
    ])
    expect(concurrent.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    await expect(recoveredNew.broker.get(SLOT)).resolves.toMatchObject({
      metadata: { generation: 3 },
    })
  })

  it('atomically re-encrypts on read and deletes only the expected generation', async () => {
    const created = await createBroker({ shouldReEncrypt: true })
    const generation1 = await created.broker.put({
      slot: SLOT,
      providerId: PROVIDER_ID,
      kind: 'oauth',
      expectedGeneration: 0,
      secretPayload: OAUTH_SECRET,
    })
    const oldBlob = `${generation1.credentialId}.bin`

    await expect(created.broker.get(SLOT)).resolves.toMatchObject({
      metadata: { generation: 2 },
      secretPayload: OAUTH_SECRET,
    })
    await expect(
      access(join(created.rootDirectory, 'state/secure-store/blobs', oldBlob)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(created.broker.delete(SLOT, 1)).rejects.toEqual(
      new SecureStorageBrokerError('credential_generation_conflict'),
    )
    await expect(created.broker.delete(SLOT, 2)).resolves.toEqual({
      slot: SLOT,
      generation: 2,
      status: 'deleted',
    })
    await expect(created.broker.get(SLOT)).resolves.toBeUndefined()
    await expect(created.broker.delete(SLOT, 0)).rejects.toEqual(
      new SecureStorageBrokerError('credential_generation_conflict'),
    )
    await expect(created.broker.status('model/missing/default')).resolves.toEqual({
      slot: 'model/missing/default',
      status: 'missing',
    })
  })

  it('fails closed on a corrupt index without overwriting or exposing its contents', async () => {
    const created = await createBroker({})
    const indexPath = join(created.rootDirectory, 'state/secure-store/index.json')
    await writeFile(indexPath, '{"secret":"index-canary"}\n')

    await expect(created.broker.status(SLOT)).rejects.toEqual(
      new SecureStorageBrokerError('credential_index_invalid'),
    )
    expect(await readFile(indexPath, 'utf8')).toBe('{"secret":"index-canary"}\n')

    await writeFile(indexPath, '{invalid-json\n')
    await expect(created.broker.status(SLOT)).rejects.toEqual(
      new SecureStorageBrokerError('credential_index_invalid'),
    )
  })

  it('maps encryption and decryption failures to stable errors without secret text', async () => {
    const encryption = await createBroker({ encryptFails: true })
    await expect(
      encryption.broker.put({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'api_key',
        expectedGeneration: 0,
        secretPayload: API_KEY_SECRET,
      }),
    ).rejects.toEqual(new SecureStorageBrokerError('credential_persist_failed'))

    const persisted = await createBroker({})
    await persisted.broker.put({
      slot: SLOT,
      providerId: PROVIDER_ID,
      kind: 'api_key',
      expectedGeneration: 0,
      secretPayload: API_KEY_SECRET,
    })
    const decryption = await createBroker({
      rootDirectory: persisted.rootDirectory,
      decryptFails: true,
    })
    await expect(decryption.broker.get(SLOT)).rejects.toEqual(
      new SecureStorageBrokerError('credential_decrypt_failed'),
    )
  })

  it('uses the host platform and cryptographic UUID defaults when omitted', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'secure-storage-broker-defaults-'))
    const storage = fakeSafeStorage({ backend: 'gnome_libsecret' })
    const broker = await SecureStorageBroker.create({
      rootDirectory,
      runtimeVersion: '1.0.0',
      safeStorage: storage.adapter,
    })
    await expect(
      broker.put({
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'api_key',
        expectedGeneration: 0,
        secretPayload: API_KEY_SECRET,
      }),
    ).resolves.toMatchObject({ generation: 1 })
  })
})
