import { createHash } from 'node:crypto'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { atomicWriteFile, atomicWriteJson, type AtomicWriteOptions } from './atomic-file'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 16_384
const MAX_TEXT_BYTES = 10 * 1024 * 1024
const TEXT_PAGE_CHARACTERS = 24_000

export type ScopedArtifactStoreErrorCode =
  'artifact_invalid' | 'artifact_scope_invalid' | 'artifact_exists'

export class ScopedArtifactStoreError extends Error {
  readonly code: ScopedArtifactStoreErrorCode

  constructor(code: ScopedArtifactStoreErrorCode) {
    super(code)
    this.name = 'ScopedArtifactStoreError'
    this.code = code
  }
}

export type ScopedArtifactRef = {
  artifactId: string
  mediaType: 'image/png' | 'text/plain'
  byteLength: number
  sha256: string
  displayName?: string
}

export type OpenedScopedImage = {
  artifact: ScopedArtifactRef & { mediaType: 'image/png' }
  bytes: Buffer
  width: number
  height: number
}

export type ScopedTextPage = {
  artifact: ScopedArtifactRef & { mediaType: 'text/plain' }
  text: string
  offset: number
  nextOffset?: number
  totalCharacters: number
}

export type ScopedArtifactStoreOptions = {
  rootDirectory: string
  now?: () => string
  atomicWriteOptions?: AtomicWriteOptions
}

type RegisterImageInput = {
  artifactId: string
  documentId: string
  runId: string
  bytes: Uint8Array
  mediaType: 'image/png'
  width: number
  height: number
  displayName?: string
}

type OpenImageInput = Pick<RegisterImageInput, 'artifactId' | 'documentId' | 'runId'>

type RegisterTextBase = {
  artifactId: string
  documentId: string
  text: string
  mediaType: 'text/plain'
  displayName?: string
}

type RegisterTextInput = RegisterTextBase &
  ({ scope: 'document'; runId?: never } | { scope?: 'run'; runId: string })

type ReadTextInput = Pick<RegisterTextInput, 'artifactId' | 'documentId' | 'runId'> & {
  offset?: number
}

type ArtifactMetadata = Omit<ScopedArtifactRef, 'mediaType'> & {
  schemaVersion: 1
  mediaType: 'image/png'
  documentId: string
  runId: string
  width: number
  height: number
  createdAt: string
}

type TextArtifactMetadata = Omit<ScopedArtifactRef, 'mediaType'> & {
  schemaVersion: 1
  mediaType: 'text/plain'
  documentId: string
  scope: 'document' | 'run'
  runId?: string
  createdAt: string
}

function invalid(): ScopedArtifactStoreError {
  return new ScopedArtifactStoreError('artifact_invalid')
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function validateIdentity(artifactId: unknown): asserts artifactId is string {
  if (!isUuid(artifactId)) throw invalid()
}

function validateScope(documentId: unknown, runId: unknown): void {
  if (!isUuid(documentId) || !isUuid(runId)) {
    throw new ScopedArtifactStoreError('artifact_scope_invalid')
  }
}

function validateDisplayName(value: unknown): asserts value is string | undefined {
  if (value === undefined) return
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    basename(value) !== value ||
    value === '.' ||
    value === '..'
  ) {
    throw invalid()
  }
}

function inspectPng(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw invalid()
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw invalid()
  }
  return { width, height }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function metadataFrom(value: unknown): ArtifactMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  const expectedKeys = [
    'artifactId',
    'byteLength',
    'createdAt',
    'documentId',
    'height',
    'mediaType',
    'runId',
    'schemaVersion',
    'sha256',
    'width',
    ...(record.displayName === undefined ? [] : ['displayName']),
  ].sort()
  if (Object.keys(record).sort().join('\0') !== expectedKeys.join('\0')) throw invalid()
  validateIdentity(record.artifactId)
  validateScope(record.documentId, record.runId)
  validateDisplayName(record.displayName)
  if (
    record.schemaVersion !== 1 ||
    record.mediaType !== 'image/png' ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 1 ||
    typeof record.sha256 !== 'string' ||
    !SHA256_PATTERN.test(record.sha256) ||
    !Number.isSafeInteger(record.width) ||
    !Number.isSafeInteger(record.height) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw invalid()
  }
  return record as ArtifactMetadata
}

function textMetadataFrom(value: unknown): TextArtifactMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  const expectedKeys = [
    'artifactId',
    'byteLength',
    'createdAt',
    'documentId',
    'mediaType',
    'scope',
    'schemaVersion',
    'sha256',
    ...(record.scope === 'run' ? ['runId'] : []),
    ...(record.displayName === undefined ? [] : ['displayName']),
  ].sort()
  if (Object.keys(record).sort().join('\0') !== expectedKeys.join('\0')) throw invalid()
  validateIdentity(record.artifactId)
  if (!isUuid(record.documentId)) throw new ScopedArtifactStoreError('artifact_scope_invalid')
  if (record.scope !== 'document' && record.scope !== 'run') throw invalid()
  if (record.scope === 'run') validateScope(record.documentId, record.runId)
  validateDisplayName(record.displayName)
  if (
    record.schemaVersion !== 1 ||
    record.mediaType !== 'text/plain' ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 1 ||
    (record.byteLength as number) > MAX_TEXT_BYTES ||
    typeof record.sha256 !== 'string' ||
    !SHA256_PATTERN.test(record.sha256) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw invalid()
  }
  return record as TextArtifactMetadata
}

async function requireRegularFile(path: string): Promise<void> {
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink()) throw invalid()
}

export class ScopedArtifactStore {
  private readonly rootDirectory: string
  private readonly now: () => string
  private readonly atomicWriteOptions: AtomicWriteOptions | undefined

  constructor(options: ScopedArtifactStoreOptions) {
    if (!options.rootDirectory) throw invalid()
    this.rootDirectory = options.rootDirectory
    this.now = options.now ?? (() => new Date().toISOString())
    this.atomicWriteOptions = options.atomicWriteOptions
  }

  artifactPath(artifactId: string): string {
    validateIdentity(artifactId)
    return join(this.rootDirectory, `${artifactId}.png`)
  }

  private metadataPath(artifactId: string): string {
    return join(this.rootDirectory, `${artifactId}.json`)
  }

  private textPath(artifactId: string): string {
    return join(this.rootDirectory, `${artifactId}.txt`)
  }

  async registerText(
    input: RegisterTextInput,
  ): Promise<ScopedArtifactRef & { mediaType: 'text/plain' }> {
    validateIdentity(input.artifactId)
    const scope = input.scope ?? 'run'
    if (!isUuid(input.documentId)) throw new ScopedArtifactStoreError('artifact_scope_invalid')
    if (scope === 'run') validateScope(input.documentId, input.runId)
    validateDisplayName(input.displayName)
    if (
      input.mediaType !== 'text/plain' ||
      typeof input.text !== 'string' ||
      input.text.includes('\0')
    ) {
      throw invalid()
    }
    const bytes = Buffer.from(input.text, 'utf8')
    if (bytes.length < 1 || bytes.length > MAX_TEXT_BYTES) throw invalid()

    const textPath = this.textPath(input.artifactId)
    const metadataPath = this.metadataPath(input.artifactId)
    for (const path of [textPath, metadataPath]) {
      try {
        await lstat(path)
        throw new ScopedArtifactStoreError('artifact_exists')
      } catch (error) {
        if (error instanceof ScopedArtifactStoreError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid()
      }
    }

    const artifact = {
      artifactId: input.artifactId,
      mediaType: 'text/plain' as const,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    }
    const metadata: TextArtifactMetadata = {
      schemaVersion: 1,
      ...artifact,
      documentId: input.documentId,
      scope,
      ...(scope === 'run' ? { runId: input.runId } : {}),
      createdAt: this.now(),
    }
    try {
      await atomicWriteFile(textPath, bytes, this.atomicWriteOptions)
      await atomicWriteJson(metadataPath, metadata, this.atomicWriteOptions)
      return artifact
    } catch {
      await Promise.allSettled([unlink(textPath), unlink(metadataPath)])
      throw invalid()
    }
  }

  async readText(input: ReadTextInput): Promise<ScopedTextPage> {
    validateIdentity(input.artifactId)
    validateScope(input.documentId, input.runId)
    const offset = input.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw invalid()
    try {
      const textPath = this.textPath(input.artifactId)
      const metadataPath = this.metadataPath(input.artifactId)
      await Promise.all([requireRegularFile(textPath), requireRegularFile(metadataPath)])
      const [bytes, rawMetadata] = await Promise.all([
        readFile(textPath),
        readFile(metadataPath, 'utf8'),
      ])
      const metadata = textMetadataFrom(JSON.parse(rawMetadata) as unknown)
      if (
        metadata.artifactId !== input.artifactId ||
        metadata.documentId !== input.documentId ||
        (metadata.scope === 'run' && metadata.runId !== input.runId)
      ) {
        throw new ScopedArtifactStoreError('artifact_scope_invalid')
      }
      if (metadata.byteLength !== bytes.length || metadata.sha256 !== sha256(bytes)) throw invalid()
      const whole = bytes.toString('utf8')
      if (Buffer.byteLength(whole, 'utf8') !== bytes.length || whole.includes('\0')) throw invalid()
      const text = whole.slice(offset, offset + TEXT_PAGE_CHARACTERS)
      const nextOffset = offset + text.length < whole.length ? offset + text.length : undefined
      return {
        artifact: {
          artifactId: metadata.artifactId,
          mediaType: metadata.mediaType,
          byteLength: metadata.byteLength,
          sha256: metadata.sha256,
          ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
        },
        text,
        offset,
        ...(nextOffset === undefined ? {} : { nextOffset }),
        totalCharacters: whole.length,
      }
    } catch (error) {
      if (error instanceof ScopedArtifactStoreError) throw error
      throw invalid()
    }
  }

  async registerImage(
    input: RegisterImageInput,
  ): Promise<ScopedArtifactRef & { mediaType: 'image/png' }> {
    validateIdentity(input.artifactId)
    validateScope(input.documentId, input.runId)
    validateDisplayName(input.displayName)
    if (input.mediaType !== 'image/png') throw invalid()

    const bytes = Buffer.from(input.bytes)
    const dimensions = inspectPng(bytes)
    if (input.width !== dimensions.width || input.height !== dimensions.height) throw invalid()

    const imagePath = this.artifactPath(input.artifactId)
    const metadataPath = this.metadataPath(input.artifactId)
    for (const path of [imagePath, metadataPath]) {
      try {
        await lstat(path)
        throw new ScopedArtifactStoreError('artifact_exists')
      } catch (error) {
        if (error instanceof ScopedArtifactStoreError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid()
      }
    }

    const artifact: ScopedArtifactRef & { mediaType: 'image/png' } = {
      artifactId: input.artifactId,
      mediaType: 'image/png',
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    }
    const metadata: ArtifactMetadata = {
      schemaVersion: 1,
      ...artifact,
      documentId: input.documentId,
      runId: input.runId,
      width: dimensions.width,
      height: dimensions.height,
      createdAt: this.now(),
    }

    try {
      await atomicWriteFile(imagePath, bytes, this.atomicWriteOptions)
      await atomicWriteJson(metadataPath, metadata, this.atomicWriteOptions)
      return artifact
    } catch {
      await Promise.allSettled([unlink(imagePath), unlink(metadataPath)])
      throw invalid()
    }
  }

  async openImage(input: OpenImageInput): Promise<OpenedScopedImage> {
    validateIdentity(input.artifactId)
    validateScope(input.documentId, input.runId)
    try {
      const imagePath = this.artifactPath(input.artifactId)
      const metadataPath = this.metadataPath(input.artifactId)
      await Promise.all([requireRegularFile(imagePath), requireRegularFile(metadataPath)])
      const [bytes, rawMetadata] = await Promise.all([
        readFile(imagePath),
        readFile(metadataPath, 'utf8'),
      ])
      const metadata = metadataFrom(JSON.parse(rawMetadata) as unknown)
      if (
        metadata.artifactId !== input.artifactId ||
        metadata.documentId !== input.documentId ||
        metadata.runId !== input.runId
      ) {
        throw new ScopedArtifactStoreError('artifact_scope_invalid')
      }
      const dimensions = inspectPng(bytes)
      if (
        metadata.byteLength !== bytes.byteLength ||
        metadata.sha256 !== sha256(bytes) ||
        metadata.width !== dimensions.width ||
        metadata.height !== dimensions.height
      ) {
        throw invalid()
      }
      const artifact: ScopedArtifactRef & { mediaType: 'image/png' } = {
        artifactId: metadata.artifactId,
        mediaType: metadata.mediaType,
        byteLength: metadata.byteLength,
        sha256: metadata.sha256,
        ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
      }
      return { artifact, bytes, ...dimensions }
    } catch (error) {
      if (error instanceof ScopedArtifactStoreError) throw error
      throw invalid()
    }
  }
}
