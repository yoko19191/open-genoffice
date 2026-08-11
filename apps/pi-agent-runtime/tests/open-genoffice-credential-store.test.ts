import { describe, expect, it } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import {
  OpenGenOfficeCredentialStore,
  OpenGenOfficeCredentialStoreError,
  type CredentialBrokerClient,
  type CredentialBrokerMetadata,
  type CredentialBrokerWrite,
} from '../src/open-genoffice-credential-store'

const PROVIDER_ID = 'openai'
const SLOT = 'model/openai/default'
const API_KEY: Credential = { type: 'api_key', key: 'sk-runtime-canary' }
const OAUTH: Credential = {
  type: 'oauth',
  access: 'oauth-access-canary',
  refresh: 'oauth-refresh-canary',
  expires: 1,
}

function fakeBroker(
  options: { persistFails?: boolean; unavailable?: boolean; statusFails?: boolean } = {},
) {
  const records = new Map<string, { metadata: CredentialBrokerMetadata; secretPayload: string }>()
  const calls: Array<{ method: string; slot: string; secretPayload?: string }> = []
  let sequence = 0
  let persistFails = options.persistFails ?? false

  const write = async (input: CredentialBrokerWrite) => {
    calls.push({ method: input.expectedGeneration === 0 ? 'put' : 'rotate', ...input })
    if (persistFails) throw new Error('credential_persist_failed')
    const current = records.get(input.slot)
    if ((current?.metadata.generation ?? 0) !== input.expectedGeneration) {
      throw new Error('credential_generation_conflict')
    }
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
    async put(input) {
      return write(input)
    },
    async rotate(input) {
      return write(input)
    },
    async get(slot) {
      calls.push({ method: 'get', slot })
      if (options.unavailable) throw new Error('secure_storage_unavailable')
      return records.get(slot)
    },
    async status(slot) {
      calls.push({ method: 'status', slot })
      if (options.statusFails) throw new Error('fake_status_failure')
      if (options.unavailable) return { slot, status: 'secure_storage_unavailable' }
      return records.get(slot)?.metadata ?? { slot, status: 'missing' }
    },
    async delete(slot, expectedGeneration) {
      calls.push({ method: 'delete', slot })
      const current = records.get(slot)
      if (current?.metadata.generation !== expectedGeneration) {
        throw new Error('credential_generation_conflict')
      }
      records.delete(slot)
    },
  }
  return {
    client,
    calls,
    records,
    setPersistFails(value: boolean) {
      persistFails = value
    },
  }
}

describe('OpenGenOfficeCredentialStore', () => {
  it('implements Pi read/modify/list/delete with non-secret broker metadata', async () => {
    const broker = fakeBroker()
    const store = new OpenGenOfficeCredentialStore({
      mode: 'persistent',
      broker: broker.client,
      providerIds: [PROVIDER_ID],
    })

    await expect(store.read(PROVIDER_ID)).resolves.toBeUndefined()
    await expect(store.modify(PROVIDER_ID, async () => API_KEY)).resolves.toEqual(API_KEY)
    await expect(store.read(PROVIDER_ID)).resolves.toEqual(API_KEY)
    await expect(store.list()).resolves.toEqual([{ providerId: PROVIDER_ID, type: 'api_key' }])
    expect(broker.records.get(SLOT)?.metadata).not.toHaveProperty('secretPayload')
    expect(JSON.stringify(broker.records.get(SLOT)?.metadata)).not.toContain('sk-runtime-canary')

    await store.delete(PROVIDER_ID)
    await store.delete(PROVIDER_ID)
    await expect(store.read(PROVIDER_ID)).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })

  it('serializes OAuth refresh per provider and persists exactly one rotated generation', async () => {
    const broker = fakeBroker()
    const store = new OpenGenOfficeCredentialStore({ mode: 'persistent', broker: broker.client })
    await store.modify(PROVIDER_ID, async () => OAUTH)
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
    expect(broker.calls.filter((call) => call.method === 'rotate')).toHaveLength(1)
  })

  it('preserves the old generation when persistence fails and never returns the candidate', async () => {
    const broker = fakeBroker()
    const store = new OpenGenOfficeCredentialStore({ mode: 'persistent', broker: broker.client })
    await store.modify(PROVIDER_ID, async () => API_KEY)
    const oldRecord = broker.records.get(SLOT)
    broker.setPersistFails(true)

    await expect(store.modify(PROVIDER_ID, async () => OAUTH)).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('credential_persist_failed'),
    )
    expect(broker.records.get(SLOT)).toEqual(oldRecord)
  })

  it('offers only explicit process-memory fallback when secure storage is unavailable', async () => {
    const unavailable = fakeBroker({ unavailable: true })
    const persistent = new OpenGenOfficeCredentialStore({
      mode: 'persistent',
      broker: unavailable.client,
    })
    await expect(persistent.read(PROVIDER_ID)).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('secure_storage_unavailable'),
    )
    await expect(persistent.list()).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('secure_storage_unavailable'),
    )
    await expect(persistent.delete(PROVIDER_ID)).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('secure_storage_unavailable'),
    )

    const beforeMemoryCalls = unavailable.calls.length
    const memory = new OpenGenOfficeCredentialStore({ mode: 'memory_only' })
    await memory.modify(PROVIDER_ID, async () => API_KEY)
    await expect(memory.read(PROVIDER_ID)).resolves.toEqual(API_KEY)
    await expect(memory.list()).resolves.toEqual([{ providerId: PROVIDER_ID, type: 'api_key' }])
    await memory.delete(PROVIDER_ID)
    await expect(memory.read(PROVIDER_ID)).resolves.toBeUndefined()
    expect(unavailable.calls).toHaveLength(beforeMemoryCalls)
  })

  it('fails closed for malformed payloads, unsafe provider ids, and cancellation', async () => {
    const broker = fakeBroker()
    broker.records.set(SLOT, {
      metadata: {
        credentialId: '00000000-0000-4000-8000-000000000001',
        slot: SLOT,
        providerId: PROVIDER_ID,
        kind: 'api_key',
        generation: 1,
        status: 'available',
      },
      secretPayload: '{"type":"api_key","key":42}',
    })
    const store = new OpenGenOfficeCredentialStore({ mode: 'persistent', broker: broker.client })
    await expect(store.read(PROVIDER_ID)).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('credential_payload_invalid'),
    )

    const malformedPayloads = [
      '{invalid-json',
      'null',
      JSON.stringify({ type: 'api_key', key: 'key', extra: true }),
      JSON.stringify({ type: 'api_key', env: 42 }),
      JSON.stringify({ type: 'api_key', env: { VALID: 42 } }),
      JSON.stringify({ type: 'oauth', access: 42, refresh: 'r', expires: 1 }),
      JSON.stringify({ type: 'oauth', access: 'a', refresh: 42, expires: 1 }),
      JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 'soon' }),
      JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: null }),
      JSON.stringify({ type: 'other' }),
    ]
    for (const secretPayload of malformedPayloads) {
      broker.records.set(SLOT, { ...broker.records.get(SLOT)!, secretPayload })
      await expect(store.read(PROVIDER_ID)).rejects.toEqual(
        new OpenGenOfficeCredentialStoreError('credential_payload_invalid'),
      )
    }

    const validPayload = JSON.stringify({ type: 'api_key', key: 'key', env: { ACCOUNT: 'value' } })
    const baseMetadata = broker.records.get(SLOT)!.metadata
    for (const metadata of [
      { ...baseMetadata, providerId: 'anthropic' },
      { ...baseMetadata, slot: 'model/openai/other' },
      { ...baseMetadata, kind: 'oauth' as const },
    ]) {
      broker.records.set(SLOT, { metadata, secretPayload: validPayload })
      await expect(store.read(PROVIDER_ID)).rejects.toEqual(
        new OpenGenOfficeCredentialStoreError('credential_payload_invalid'),
      )
    }
    await expect(store.read('../escape')).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('credential_provider_id_invalid'),
    )

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(store.list({ signal: controller.signal })).rejects.toThrow('cancelled')
  })

  it('normalizes status failures without including broker details', async () => {
    const broker = fakeBroker({ statusFails: true })
    const store = new OpenGenOfficeCredentialStore({
      mode: 'persistent',
      broker: broker.client,
      providerIds: [PROVIDER_ID],
    })
    await expect(store.list()).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('credential_status_failed'),
    )
    await expect(store.delete(PROVIDER_ID)).rejects.toEqual(
      new OpenGenOfficeCredentialStoreError('credential_delete_failed'),
    )
  })
})
