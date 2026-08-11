import { describe, expect, it, vi } from 'vitest'
import { removeLegacyAgentStorage } from '../src/renderer/legacy-storage-cleanup'

describe('legacy renderer storage cleanup', () => {
  it('removes only the reviewed chat key and is idempotent', () => {
    const storage = {
      removeItem: vi.fn(),
    }

    removeLegacyAgentStorage(storage)
    removeLegacyAgentStorage(storage)

    expect(storage.removeItem).toHaveBeenCalledTimes(2)
    expect(storage.removeItem).toHaveBeenNthCalledWith(1, 'ai-excel-chat-history')
    expect(storage.removeItem).toHaveBeenNthCalledWith(2, 'ai-excel-chat-history')
  })
})
