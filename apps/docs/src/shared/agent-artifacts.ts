import type { ArtifactRef } from '@genoffice/agent-runtime-protocol'

export const DOCS_AGENT_ARTIFACT_CHANNELS = {
  pickText: 'docs:agent-artifact:pick-text',
} as const

export type DocsTextArtifact = ArtifactRef & { mediaType: 'text/plain' }

export interface DocsAgentArtifactsApi {
  pickText(): Promise<DocsTextArtifact | null>
}

export function isDocsTextArtifact(value: unknown): value is DocsTextArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  return (
    typeof artifact.artifactId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      artifact.artifactId,
    ) &&
    artifact.mediaType === 'text/plain' &&
    Number.isSafeInteger(artifact.byteLength) &&
    (artifact.byteLength as number) > 0 &&
    typeof artifact.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(artifact.sha256) &&
    typeof artifact.displayName === 'string' &&
    artifact.displayName.length > 0 &&
    artifact.displayName.length <= 255 &&
    Object.keys(artifact).sort().join('\0') ===
      ['artifactId', 'byteLength', 'displayName', 'mediaType', 'sha256'].sort().join('\0')
  )
}
