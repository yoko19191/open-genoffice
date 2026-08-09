import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  parseRuntimeHealthProjection,
  type RuntimeHealthProjection,
} from '@genoffice/agent-runtime-protocol'

export const PI_RUNTIME_CHANNELS = {
  health: 'pi-runtime:health',
} as const

const UNAVAILABLE_HEALTH: RuntimeHealthProjection = Object.freeze({
  state: 'unavailable',
  protocolVersion: PROTOCOL_VERSION,
  runtimeVersion: RUNTIME_VERSION,
  schemaVersion: SCHEMA_VERSION,
  diagnosticCode: 'runtime_bundle_unavailable',
})

export function asPiRuntimeHealth(value: unknown): RuntimeHealthProjection {
  try {
    return Object.freeze(parseRuntimeHealthProjection(value))
  } catch {
    return UNAVAILABLE_HEALTH
  }
}

export interface PiRuntimeApi {
  health(): Promise<RuntimeHealthProjection>
}
