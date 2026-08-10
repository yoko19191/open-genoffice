import { createHash } from 'node:crypto'

export const MAX_SYNC_PATHS = 10_000
export const MAX_SYNC_PATH_BYTES = 4_096
export const MAX_SYNC_SEGMENT_BYTES = 255

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function canonicalizeSyncPath(input: string): string {
  if (
    input.length === 0 ||
    input.startsWith('/') ||
    /^[A-Za-z]:\//.test(input) ||
    input.includes('\\') ||
    input.includes('\0')
  ) {
    throw new Error('sync_path_invalid')
  }
  const normalized = input.normalize('NFC')
  const encodedLength = Buffer.byteLength(normalized, 'utf8')
  const segments = normalized.split('/')
  if (
    encodedLength > MAX_SYNC_PATH_BYTES ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf8') > MAX_SYNC_SEGMENT_BYTES ||
        WINDOWS_DEVICE_NAME.test(segment),
    )
  ) {
    throw new Error('sync_path_invalid')
  }
  return normalized
}

export function assertCanonicalPathSet(paths: string[]): string[] {
  if (paths.length > MAX_SYNC_PATHS) throw new Error('sync_limit_exceeded')
  const normalized = paths.map(canonicalizeSyncPath)
  const identities = new Set<string>()
  for (const path of normalized) {
    const identity = path.toLocaleLowerCase('en-US')
    if (identities.has(identity)) throw new Error('sync_path_collision')
    identities.add(identity)
  }
  return normalized
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('sync_canonical_json_invalid')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) throw new Error('sync_canonical_json_invalid')
      result[key] = canonicalValue(item)
    }
    return result
  }
  throw new Error('sync_canonical_json_invalid')
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8')
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
