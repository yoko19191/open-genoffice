import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runRuntimeProbes } from '../src/runtime-probes.mjs'

test('loads Pi ESM, an unpacked Extension, a native addon, and MCP over stdio', async () => {
  const result = await runRuntimeProbes({
    extensionPath: new URL('../fixture/extension.mjs', import.meta.url).pathname,
    workDir: process.cwd(),
  })

  assert.equal(result.node, 'v22.19.0')
  assert.equal(result.piVersion, '0.84.0')
  assert.deepEqual(result.extension, {
    extensionCount: 1,
    errors: [],
    tools: ['spike_extension_ping'],
    executionText: 'extension-pong',
  })
  assert.equal(result.nativeAddon.module, '@mariozechner/clipboard')
  assert.ok(result.nativeAddon.exports.includes('getText'))
  assert.deepEqual(result.mcp.tools, ['sidecar_ping'])
  assert.equal(result.mcp.text, 'mcp-pong')
  assert.ok(Number.isSafeInteger(result.mcp.childPid))
})
