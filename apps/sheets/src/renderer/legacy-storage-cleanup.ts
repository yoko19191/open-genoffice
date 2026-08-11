const LEGACY_AGENT_STORAGE_KEYS = Object.freeze(['ai-excel-chat-history'] as const)

type StorageRemoval = Pick<Storage, 'removeItem'>

export function removeLegacyAgentStorage(storage: StorageRemoval = localStorage): void {
  for (const key of LEGACY_AGENT_STORAGE_KEYS) storage.removeItem(key)
}
