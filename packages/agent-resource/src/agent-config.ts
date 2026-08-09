import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { ProjectTrustStore, resolveProjectIdentity, type ProjectIdentity } from './project-security'

const IdPattern = '^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$'
const SlotPattern = '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'
const EndpointPattern = '^https?://[^\\s]+$'

const CapabilitySchema = Type.Partial(
  Type.Object(
    {
      models: Type.Boolean(),
      network: Type.Boolean(),
      execution: Type.Boolean(),
      mcp: Type.Boolean(),
      ocr: Type.Boolean(),
      subagentMutation: Type.Boolean(),
      sync: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
)

const ModelSelectionSchema = Type.Object(
  {
    providerId: Type.String({ pattern: IdPattern }),
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    endpoint: Type.Optional(Type.String({ pattern: EndpointPattern, maxLength: 2048 })),
    credentialSlot: Type.Optional(Type.String({ pattern: SlotPattern })),
  },
  { additionalProperties: false },
)

const ModelPatchSchema = Type.Partial(
  Type.Object(
    {
      providerId: Type.String({ pattern: IdPattern }),
      modelId: Type.String({ minLength: 1, maxLength: 256 }),
      endpoint: Type.String({ pattern: EndpointPattern, maxLength: 2048 }),
      credentialSlot: Type.String({ pattern: SlotPattern }),
      capabilities: Type.Array(
        Type.Union([
          Type.Literal('text-input'),
          Type.Literal('image-input'),
          Type.Literal('audio-input'),
          Type.Literal('video-input'),
          Type.Literal('tool-use'),
          Type.Literal('reasoning'),
        ]),
        { maxItems: 6, uniqueItems: true },
      ),
    },
    { additionalProperties: false },
  ),
)

export const AgentSettingsSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    capabilities: Type.Optional(CapabilitySchema),
    selectedModel: Type.Optional(ModelSelectionSchema),
    models: Type.Optional(
      Type.Record(Type.String({ pattern: IdPattern }), ModelPatchSchema, {
        maxProperties: 256,
      }),
    ),
    resourceOrder: Type.Optional(
      Type.Array(Type.String({ pattern: IdPattern }), { maxItems: 4096, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
)

export type AgentSettings = Static<typeof AgentSettingsSchema>
export type AgentCapability = keyof NonNullable<AgentSettings['capabilities']>
export type AgentConfigSource = 'defaults' | 'global' | 'project' | 'session'
export type AgentConfigErrorCode =
  | 'defaults_config_invalid'
  | 'global_config_invalid'
  | 'session_config_invalid'
  | 'session_override_unauthorized'
  | 'effective_config_invalid'

export class AgentConfigError extends Error {
  constructor(public readonly code: AgentConfigErrorCode) {
    super(code)
    this.name = 'AgentConfigError'
  }
}

export type EffectiveAgentConfig = {
  schemaVersion: 1
  capabilities: Record<AgentCapability, boolean>
  selectedModel?: Static<typeof ModelSelectionSchema>
  models: Record<string, Static<typeof ModelPatchSchema>>
  resourceOrder: string[]
}

export type EffectiveAgentConfigResult = {
  config: EffectiveAgentConfig
  configHash: string
  appliedSources: readonly AgentConfigSource[]
  diagnostics: readonly string[]
}

export type ResolveEffectiveAgentConfigOptions = {
  defaults: unknown
  global?: unknown
  project?: unknown
  session?: unknown
  projectTrusted?: boolean
  sessionOverrideAuthorized?: boolean
  productPolicy?: Partial<Record<AgentCapability, boolean>>
  actorCapabilities?: Partial<Record<AgentCapability, boolean>>
}

export type LoadEffectiveAgentConfigOptions = Omit<
  ResolveEffectiveAgentConfigOptions,
  'global' | 'project'
> & {
  globalPath?: string
  projectPath?: string
  readTextFile?: (path: string) => Promise<string>
}

export type AgentConfigurationServiceOptions = {
  rootDirectory: string
  deviceId: string
  defaults: unknown
  platform?: NodeJS.Platform
  productPolicy?: Partial<Record<AgentCapability, boolean>>
  readTextFile?: (path: string) => Promise<string>
}

export type ResolveProjectAgentConfigOptions = {
  projectRoot?: string
  session?: unknown
  sessionOverrideAuthorized?: boolean
  actorCapabilities?: Partial<Record<AgentCapability, boolean>>
}

export type ProjectAgentConfigResult = EffectiveAgentConfigResult & {
  project?: { identity: ProjectIdentity; trusted: boolean }
}

const capabilityKeys: AgentCapability[] = [
  'models',
  'network',
  'execution',
  'mcp',
  'ocr',
  'subagentMutation',
  'sync',
]

function containsInterpolation(value: unknown): boolean {
  if (typeof value === 'string') return /\$\{|\$\(|`|^!|^env:/i.test(value)
  if (Array.isArray(value)) return value.some(containsInterpolation)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsInterpolation)
  }
  return false
}

function validateSource(value: unknown, code: AgentConfigErrorCode): AgentSettings {
  if (!Value.Check(AgentSettingsSchema, value) || containsInterpolation(value)) {
    throw new AgentConfigError(code)
  }
  return value as AgentSettings
}

function mergeValues(target: EffectiveAgentConfig, source: AgentSettings): void {
  if (source.selectedModel) target.selectedModel = { ...source.selectedModel }
  if (source.resourceOrder) target.resourceOrder = [...source.resourceOrder]
  for (const [id, patch] of Object.entries(source.models ?? {})) {
    target.models[id] = {
      ...target.models[id],
      ...patch,
      ...(patch.capabilities ? { capabilities: [...patch.capabilities].sort() } : {}),
    }
  }
}

function applyCapabilityGate(
  current: Record<AgentCapability, boolean>,
  gate?: Partial<Record<AgentCapability, boolean>>,
): void {
  if (!gate) return
  for (const key of capabilityKeys) {
    if (gate[key] === false) current[key] = false
  }
}

function canonicalConfig(config: EffectiveAgentConfig): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      )
    }
    return value
  }
  return JSON.stringify(canonicalize(config))
}

function assertEffective(config: EffectiveAgentConfig): void {
  for (const model of Object.values(config.models)) {
    if (typeof model.providerId !== 'string' || typeof model.modelId !== 'string') {
      throw new AgentConfigError('effective_config_invalid')
    }
  }
}

export function resolveEffectiveAgentConfig(
  options: ResolveEffectiveAgentConfigOptions,
): EffectiveAgentConfigResult {
  const defaults = validateSource(options.defaults, 'defaults_config_invalid')
  if (
    !defaults.capabilities ||
    capabilityKeys.some((key) => defaults.capabilities?.[key] === undefined)
  ) {
    throw new AgentConfigError('defaults_config_invalid')
  }
  const global =
    options.global !== undefined
      ? validateSource(options.global, 'global_config_invalid')
      : undefined
  const appliedSources: AgentConfigSource[] = ['defaults']
  const diagnostics: string[] = []
  let project: AgentSettings | undefined
  if (options.projectTrusted && options.project !== undefined) {
    try {
      project = validateSource(options.project, 'global_config_invalid')
    } catch {
      diagnostics.push('project_config_invalid')
    }
  }
  let session: AgentSettings | undefined
  if (options.session !== undefined) {
    if (!options.sessionOverrideAuthorized) {
      throw new AgentConfigError('session_override_unauthorized')
    }
    session = validateSource(options.session, 'session_config_invalid')
  }

  const capabilities = Object.fromEntries(
    capabilityKeys.map((key) => [key, defaults.capabilities![key]!]),
  ) as Record<AgentCapability, boolean>
  const config: EffectiveAgentConfig = {
    schemaVersion: 1,
    capabilities,
    ...(defaults.selectedModel ? { selectedModel: { ...defaults.selectedModel } } : {}),
    models: {},
    resourceOrder: [],
  }
  mergeValues(config, defaults)
  for (const [name, source] of [
    ['global', global],
    ['project', project],
    ['session', session],
  ] as const) {
    if (!source) continue
    mergeValues(config, source)
    applyCapabilityGate(capabilities, source.capabilities)
    appliedSources.push(name)
  }
  applyCapabilityGate(capabilities, options.productPolicy)
  applyCapabilityGate(capabilities, options.actorCapabilities)
  assertEffective(config)
  const serialized = canonicalConfig(config)
  return Object.freeze({
    config: Object.freeze(config),
    configHash: createHash('sha256').update(serialized).digest('hex'),
    appliedSources: Object.freeze(appliedSources),
    diagnostics: Object.freeze(diagnostics),
  })
}

async function readOptional(
  path: string | undefined,
  readTextFile: (path: string) => Promise<string>,
  code: AgentConfigErrorCode,
): Promise<unknown | undefined> {
  if (!path) return undefined
  try {
    return JSON.parse(await readTextFile(path)) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new AgentConfigError(code)
  }
}

export async function loadEffectiveAgentConfig(
  options: LoadEffectiveAgentConfigOptions,
): Promise<EffectiveAgentConfigResult> {
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, 'utf8'))
  const global = await readOptional(options.globalPath, readTextFile, 'global_config_invalid')
  let project: unknown
  if (options.projectTrusted) {
    try {
      project = await readOptional(options.projectPath, readTextFile, 'global_config_invalid')
    } catch {
      project = Object.freeze({})
    }
  }
  return resolveEffectiveAgentConfig({ ...options, global, project })
}

export class AgentConfigurationService {
  readonly trust: ProjectTrustStore

  constructor(private readonly options: AgentConfigurationServiceOptions) {
    this.trust = new ProjectTrustStore(options)
  }

  async resolve(options: ResolveProjectAgentConfigOptions = {}): Promise<ProjectAgentConfigResult> {
    const identity = options.projectRoot
      ? await resolveProjectIdentity(options.projectRoot, this.options.deviceId)
      : undefined
    const trusted = identity ? await this.trust.isTrusted(identity) : false
    const result = await loadEffectiveAgentConfig({
      defaults: this.options.defaults,
      globalPath: join(this.options.rootDirectory, 'agent', 'settings.json'),
      ...(identity
        ? {
            projectPath: join(identity.canonicalRoot, '.open-genoffice', 'agent', 'settings.json'),
          }
        : {}),
      projectTrusted: trusted,
      session: options.session,
      sessionOverrideAuthorized: options.sessionOverrideAuthorized,
      productPolicy: this.options.productPolicy,
      actorCapabilities: options.actorCapabilities,
      readTextFile: this.options.readTextFile,
    })
    return Object.freeze({
      ...result,
      ...(identity ? { project: Object.freeze({ identity, trusted }) } : {}),
    })
  }

  async grantProject(rootDirectory: string): Promise<ProjectIdentity> {
    const identity = await resolveProjectIdentity(rootDirectory, this.options.deviceId)
    await this.trust.grant(identity)
    return identity
  }

  async revokeProject(rootDirectory: string): Promise<ProjectIdentity> {
    const identity = await resolveProjectIdentity(rootDirectory, this.options.deviceId)
    await this.trust.revoke(identity)
    return identity
  }
}
