import { lstat, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ScopedArtifactStore } from '@genoffice/agent-resource'
import type { SlidesMediaArtifact } from '../../../slides/src/shared/agent-media-artifacts'

const MAX_MEDIA_BYTES = 100 * 1024 * 1024
const DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export class MediaArtifactImportError extends Error {
  readonly code = 'artifact_invalid'

  constructor() {
    super('artifact_invalid')
    this.name = 'MediaArtifactImportError'
  }
}

export async function importMediaArtifact(input: {
  path: string
  documentId: string
  artifactStore: Pick<ScopedArtifactStore, 'registerMedia'>
  randomUUID: () => string
}): Promise<SlidesMediaArtifact> {
  try {
    if (!DOCUMENT_ID_PATTERN.test(input.documentId)) throw new Error('invalid_document')
    const extension = extname(input.path).toLowerCase()
    const mediaType =
      extension === '.wav' ? 'audio/wav' : extension === '.mp4' ? 'video/mp4' : undefined
    if (!mediaType) throw new Error('invalid_extension')
    const info = await lstat(input.path)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_MEDIA_BYTES) {
      throw new Error('invalid_file')
    }
    const bytes = await readFile(input.path)
    return (await input.artifactStore.registerMedia({
      artifactId: input.randomUUID(),
      documentId: input.documentId,
      scope: 'document',
      bytes,
      mediaType,
      displayName: basename(input.path),
    })) as SlidesMediaArtifact
  } catch (error) {
    if (error instanceof MediaArtifactImportError) throw error
    throw new MediaArtifactImportError()
  }
}
