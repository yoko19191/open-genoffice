import { lstat, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ScopedArtifactStore } from '@genoffice/agent-resource'
import type { DocsTextArtifact } from '../../../docs/src/shared/agent-artifacts'

const MAX_TEXT_BYTES = 10 * 1024 * 1024
const DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const TEXT_EXTENSIONS = new Set(['.csv', '.htm', '.html', '.json', '.markdown', '.md', '.txt'])

export class DocsTextArtifactImportError extends Error {
  readonly code = 'artifact_invalid'

  constructor(code: 'artifact_invalid') {
    super(code)
    this.name = 'DocsTextArtifactImportError'
  }
}

export async function importDocsTextArtifact(input: {
  path: string
  documentId: string
  artifactStore: Pick<ScopedArtifactStore, 'registerText'>
  randomUUID: () => string
}): Promise<DocsTextArtifact> {
  try {
    if (
      !DOCUMENT_ID_PATTERN.test(input.documentId) ||
      !TEXT_EXTENSIONS.has(extname(input.path).toLowerCase())
    ) {
      throw new Error('invalid_input')
    }
    const info = await lstat(input.path)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_TEXT_BYTES) {
      throw new Error('invalid_file')
    }
    const bytes = await readFile(input.path)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('invalid_text')
    return (await input.artifactStore.registerText({
      artifactId: input.randomUUID(),
      documentId: input.documentId,
      scope: 'document',
      text,
      mediaType: 'text/plain',
      displayName: basename(input.path),
    })) as DocsTextArtifact
  } catch (error) {
    if (error instanceof DocsTextArtifactImportError) throw error
    throw new DocsTextArtifactImportError('artifact_invalid')
  }
}
