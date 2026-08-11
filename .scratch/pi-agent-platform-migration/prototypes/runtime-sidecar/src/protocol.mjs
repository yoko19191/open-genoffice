import { timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = '1'
export const RUNTIME_VERSION = '0.1.0-spike04'

export function encodeMessage(value) {
  return `${JSON.stringify(value)}\n`
}

export function secureTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function validateBootstrap(value, actualParentPid = process.ppid) {
  if (!value || typeof value !== 'object') throw new Error('bootstrap must be an object')
  if (value.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`unsupported bootstrap protocol: ${value.protocolVersion}`)
  if (!Number.isSafeInteger(value.parentPid) || value.parentPid <= 0)
    throw new Error('bootstrap parentPid must be a positive integer')
  if (value.parentPid !== actualParentPid)
    throw new Error('bootstrap parentPid does not match ppid')
  if (typeof value.endpoint !== 'string' || value.endpoint.length === 0)
    throw new Error('bootstrap endpoint is required')
  if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.token))
    throw new Error('bootstrap token must be 256-bit lowercase hex')
  return value
}

export function createJsonLineDecoder(onMessage, onError) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          onMessage(JSON.parse(line))
        } catch (error) {
          onError(error)
        }
      }
    },
    end() {
      if (buffer.trim()) onError(new Error('unterminated JSON line'))
      buffer = ''
    },
  }
}

export function errorEnvelope(id, code, message) {
  return { id: id ?? null, error: { code, message } }
}
