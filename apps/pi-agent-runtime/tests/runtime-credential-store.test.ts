import { describe, expect, it } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import {
  RuntimeCredentialStore,
  type CredentialBrokerClient,
  type CredentialBrokerMetadata,
  type CredentialBrokerWrite,
} from '../src'

const PROVIDER_ID = 'openai'
const API_KEY: Credential = { type: 'api_key', key: 'runtime-management-canary' }
const OAUTH: Credential = {
  type: 'oauth',
  access: 'oauth-access-canary',
  refresh: 'oauth-refresh-canary',
  expires: 1,
  accountId: 'redacted-account-canary',
}

function fakeBroker(options: { unavailable?: boolean } = {}) {
  const records = new Map<string, { metadata: CredentialBrokerMetadata; secretPayload: string }>()
  const writes: CredentialBrokerWrite[] = []
  let sequence = 0

  const write = async (input: CredentialBrokerWrite) => {
    const current = records.get(input.slot)
    if ((current?.metadata.generation ?? 0) !== input.expectedGeneration) {
      throw new Error('credential_generation_conflict')
    }
    writes.push(input)
    sequence += 1
    const metadata: CredentialBrokerMetadata = {
      credentialId: `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
      slot: input.slot,
      providerId: input.providerId,
      kind: input.kind,
      generation: input.expectedGeneration + 1,
      status: 'available',
    }
    records.set(input.slot, { metadata, secretPayload: input.secretPayload })
    return metadata
  }

  const client: CredentialBrokerClient = {
    put: write,
    rotate: write,
    async get(slot) {
      if (options.unavailable) throw new Error('secure_storage_unavailable')
      return records.get(slot)
    },
    async status(slot) {
      if (options.unavailable) return { slot, status: 'secure_storage_unavailable' }
      return records.get(slot)?.metadata ?? { slot, status: 'missing' }
    },
    async delete(slot, expectedGeneration) {
      if (options.unavailable) throw new Error('secure_storage_unavailable')
      const current = records.get(slot)
      if (current?.metadata.generation !== expectedGeneration) {
        throw new Error('credential_generation_conflict')
      }
      records.delete(slot)
    },
  }

  return { client, records, writes }
}

describe('RuntimeCredentialStore', () => {
  it('owns persistent API-key and OAuth lifecycle while exposing only redacted status', async () => {
    const broker = fakeBroker()
    const store = new RuntimeCredentialStore({ broker: broker.client })

    await expect(store.status(PROVIDER_ID)).resolves.toEqual({
      providerId: PROVIDER_ID,
      persistence: 'persistent',
      status: 'missing',
    })
    await expect(store.put(PROVIDER_ID, 'persistent', JSON.stringify(API_KEY))).resolves.toEqual({
      providerId: PROVIDER_ID,
      persistence: 'persistent',
      status: 'available',
      kind: 'api_key',
    })
    await expect(store.read(PROVIDER_ID)).resolves.toEqual(API_KEY)
    await expect(store.put(PROVIDER_ID, 'persistent', JSON.stringify(OAUTH))).resolves.toEqual({
      providerId: PROVIDER_ID,
      persistence: 'persistent',
      status: 'available',
      kind: 'oauth',
    })
    expect(broker.writes).toHaveLength(2)
    expect(broker.writes[1]?.expectedGeneration).toBe(1)
    expect(JSON.stringify(await store.status(PROVIDER_ID))).not.toContain('oauth-access-canary')
    expect(await store.list()).toEqual([{ providerId: PROVIDER_ID, type: 'oauth' }])

    await store.delete(PROVIDER_ID)
    await expect(store.read(PROVIDER_ID)).resolves.toBeUndefined()
  })

  it('hard-fails persistent storage but activates memory-only only after an explicit choice', async () => {
    const broker = fakeBroker({ unavailable: true })
    const store = new RuntimeCredentialStore({ broker: broker.client })

    await expect(
      store.put(PROVIDER_ID, 'persistent', JSON.stringify(API_KEY)),
    ).rejects.toMatchObject({ code: 'secure_storage_unavailable' })
    await expect(store.read(PROVIDER_ID)).rejects.toMatchObject({
      code: 'secure_storage_unavailable',
    })
    await expect(store.put(PROVIDER_ID, 'memory_only', JSON.stringify(API_KEY))).resolves.toEqual({
      providerId: PROVIDER_ID,
      persistence: 'memory_only',
      status: 'available',
      kind: 'api_key',
    })
    await expect(store.read(PROVIDER_ID)).resolves.toEqual(API_KEY)
    await expect(store.list()).resolves.toEqual([{ providerId: PROVIDER_ID, type: 'api_key' }])

    await store.delete(PROVIDER_ID)
    await expect(store.status(PROVIDER_ID)).resolves.toEqual({
      providerId: PROVIDER_ID,
      persistence: 'persistent',
      status: 'secure_storage_unavailable',
    })
  })

  it('serializes management writes and request-time refresh through one provider chain', async () => {
    const broker = fakeBroker()
    const store = new RuntimeCredentialStore({ broker: broker.client })
    await store.put(PROVIDER_ID, 'persistent', JSON.stringify(OAUTH))
    let refreshes = 0
    const refresh = async (current: Credential | undefined): Promise<Credential | undefined> => {
      if (current?.type !== 'oauth' || current.expires > Date.now()) return undefined
      refreshes += 1
      await Promise.resolve()
      return { ...current, access: 'rotated-access-canary', expires: Date.now() + 60_000 }
    }
    const [first, second] = await Promise.all([
      store.modify(PROVIDER_ID, refresh),
      store.modify(PROVIDER_ID, refresh),
    ])
    expect(first).toEqual(second)
    expect(refreshes).toBe(1)
    expect(broker.writes).toHaveLength(2)
  })

  it('rejects memory-only shadowing of an existing persistent credential', async () => {
    const broker = fakeBroker()
    const store = new RuntimeCredentialStore({ broker: broker.client })
    await store.put(PROVIDER_ID, 'persistent', JSON.stringify(API_KEY))
    await expect(
      store.put(PROVIDER_ID, 'memory_only', JSON.stringify(OAUTH)),
    ).rejects.toMatchObject({
      code: 'credential_persistence_conflict',
    })
    await expect(store.read(PROVIDER_ID)).resolves.toEqual(API_KEY)
  })
})
