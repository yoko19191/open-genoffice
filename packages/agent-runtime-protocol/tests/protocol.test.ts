import { describe, expect, it } from 'vitest'
import {
  NODE_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  parseBootstrapLine,
  parseRuntimeBundleManifest,
} from '../src'

const token = 'a'.repeat(64)

describe('runtime bootstrap contract', () => {
  it('accepts the frozen inherited-stdin bootstrap record', () => {
    expect(
      parseBootstrapLine(
        JSON.stringify({
          kind: 'bootstrap',
          protocolVersion: PROTOCOL_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          schemaVersion: SCHEMA_VERSION,
          parentPid: 4242,
          endpoint: '/tmp/open-genoffice/runtime.sock',
          token,
        }),
      ),
    ).toEqual({
      kind: 'bootstrap',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      schemaVersion: '1',
      parentPid: 4242,
      endpoint: '/tmp/open-genoffice/runtime.sock',
      token,
    })
  })

  it.each([
    ['unknown field', { extra: true }],
    ['wrong protocol', { protocolVersion: '0' }],
    ['short token', { token: 'secret' }],
    ['invalid parent pid', { parentPid: 0 }],
  ])('rejects %s without echoing the bootstrap token', (_label, override) => {
    const record = {
      kind: 'bootstrap',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: SCHEMA_VERSION,
      parentPid: 4242,
      endpoint: '/tmp/open-genoffice/runtime.sock',
      token,
      ...override,
    }
    expect(() => parseBootstrapLine(JSON.stringify(record))).toThrowError('invalid_bootstrap')
    try {
      parseBootstrapLine(JSON.stringify(record))
    } catch (error) {
      expect(String(error)).not.toContain(token)
    }
  })

  it('rejects malformed JSON with the same redacted error', () => {
    expect(() => parseBootstrapLine('{"token":"top-secret"')).toThrowError('invalid_bootstrap')
  })
})

describe('runtime bundle manifest contract', () => {
  const manifest = {
    manifestVersion: 1,
    runtimeName: RUNTIME_NAME,
    runtimeVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    nodeVersion: NODE_VERSION,
    piVersion: PI_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    executable: 'node/open-genoffice-pi-agent-runtime',
    entry: 'app/main.mjs',
    treeSha256: 'b'.repeat(64),
    files: [
      {
        path: 'app/main.mjs',
        sha256: 'c'.repeat(64),
        size: 128,
        mode: '0644',
      },
    ],
    noticesSha256: 'd'.repeat(64),
    generatedFromLockSha256: 'e'.repeat(64),
  }

  it('accepts the frozen current-platform manifest shape', () => {
    expect(parseRuntimeBundleManifest(manifest)).toEqual(manifest)
  })

  it.each([
    ['runtime name', { runtimeName: 'node' }],
    ['Node version', { nodeVersion: '22.20.0' }],
    ['Pi version', { piVersion: '0.84.1' }],
    ['unknown field', { unexpected: true }],
  ])('rejects a mismatched %s', (_label, override) => {
    expect(() => parseRuntimeBundleManifest({ ...manifest, ...override })).toThrowError(
      'runtime_bundle_invalid',
    )
  })
})
