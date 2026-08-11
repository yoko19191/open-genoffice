import type { ArtifactRef } from '@genoffice/agent-runtime-protocol'

export const SLIDES_AGENT_MEDIA_CHANNELS = {
  pick: 'slides:agent-media:pick',
  openModelSettings: 'slides:agent-media:open-model-settings',
} as const

export type SlidesMediaArtifact = ArtifactRef & {
  mediaType: 'audio/wav' | 'video/mp4'
  displayName: string
}

export interface SlidesAgentMediaApi {
  pick(): Promise<SlidesMediaArtifact | null>
  openModelSettings(): Promise<void>
}

export function isSlidesMediaArtifact(value: unknown): value is SlidesMediaArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  return (
    typeof artifact.artifactId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      artifact.artifactId,
    ) &&
    (artifact.mediaType === 'audio/wav' || artifact.mediaType === 'video/mp4') &&
    Number.isSafeInteger(artifact.byteLength) &&
    (artifact.byteLength as number) > 0 &&
    (artifact.byteLength as number) <= 100 * 1024 * 1024 &&
    typeof artifact.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(artifact.sha256) &&
    typeof artifact.displayName === 'string' &&
    artifact.displayName.length > 0 &&
    artifact.displayName.length <= 255 &&
    Object.keys(artifact).sort().join('\0') ===
      ['artifactId', 'byteLength', 'displayName', 'mediaType', 'sha256'].sort().join('\0')
  )
}
