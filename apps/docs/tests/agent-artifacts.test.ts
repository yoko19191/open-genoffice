import { describe, expect, it } from 'vitest'
import { isDocsTextArtifact } from '../src/shared/agent-artifacts'

const valid = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  mediaType: 'text/plain',
  byteLength: 12,
  sha256: 'a'.repeat(64),
  displayName: 'notes.txt',
}

describe('Docs Agent Artifact bridge', () => {
  it('accepts only opaque text refs with exact renderer-safe fields', () => {
    expect(isDocsTextArtifact(valid)).toBe(true)
    for (const invalid of [
      null,
      [],
      { ...valid, artifactId: 'bad' },
      { ...valid, mediaType: 'image/png' },
      { ...valid, byteLength: 0 },
      { ...valid, sha256: 'bad' },
      { ...valid, displayName: '' },
      { ...valid, path: '/private/notes.txt' },
      { ...valid, text: 'private content' },
      { ...valid, url: 'https://example.test/notes.txt' },
    ]) {
      expect(isDocsTextArtifact(invalid)).toBe(false)
    }
  })
})
