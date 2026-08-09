import { describe, expect, it } from 'vitest'
import { PI_RUNTIME_CHANNELS, asPiRuntimeHealth } from '../src/shared/pi-runtime-api'

describe('typed Pi Runtime preload health contract', () => {
  it('accepts the narrow projection and fails closed on leaked or malformed fields', () => {
    const ready = {
      state: 'ready',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      schemaVersion: '1',
    }
    expect(asPiRuntimeHealth(ready)).toEqual(ready)
    expect(asPiRuntimeHealth({ ...ready, endpoint: '/private/runtime.sock' })).toMatchObject({
      state: 'unavailable',
      diagnosticCode: 'runtime_bundle_unavailable',
    })
    expect(asPiRuntimeHealth(null)).toMatchObject({ state: 'unavailable' })
    expect(Object.isFrozen(asPiRuntimeHealth(null))).toBe(true)
    expect(PI_RUNTIME_CHANNELS.health).toBe('pi-runtime:health')
  })
})
