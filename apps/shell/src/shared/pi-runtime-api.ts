import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  parseCredentialProviderId,
  parseModelCatalogProjection,
  parseMcpCatalogProjection,
  parseOpenAICompatibleProviderConfiguration,
  parseOAuthOperationProjection,
  parsePackageCatalogProjection,
  parseResourceCatalogProjection,
  parseProviderCredentialStatus as parseProtocolProviderCredentialStatus,
  parseRuntimeHealthProjection,
  type ProviderCredentialStatus,
  type RuntimeHealthProjection,
  type ModelCatalogProjection,
  type McpCatalogProjection,
  type ModelSelectionRole,
  type OAuthOperationProjection,
  type OpenAICompatibleProviderConfiguration,
  type PackageCatalogProjection,
  type ResourceCatalogProjection,
} from '@genoffice/agent-runtime-protocol/renderer'

export const PI_RUNTIME_CHANNELS = {
  health: 'pi-runtime:health',
  saveProviderApiKey: 'pi-runtime:provider-credential-save',
  providerCredentialStatus: 'pi-runtime:provider-credential-status',
  logoutProvider: 'pi-runtime:provider-credential-logout',
  modelCatalog: 'pi-runtime:model-catalog',
  selectModel: 'pi-runtime:model-select',
  configureModelProvider: 'pi-runtime:model-provider-configure',
  startModelOAuth: 'pi-runtime:model-oauth-start',
  modelOAuthStatus: 'pi-runtime:model-oauth-status',
  respondModelOAuth: 'pi-runtime:model-oauth-respond',
  cancelModelOAuth: 'pi-runtime:model-oauth-cancel',
  logoutModel: 'pi-runtime:model-logout',
  resourceCatalog: 'pi-runtime:resource-catalog',
  selectResourceProject: 'pi-runtime:resource-project-select',
  grantProjectTrust: 'pi-runtime:project-trust-grant',
  revokeProjectTrust: 'pi-runtime:project-trust-revoke',
  packageCatalog: 'pi-runtime:package-catalog',
  installLocalPackage: 'pi-runtime:package-install-local',
  installNpmPackage: 'pi-runtime:package-install-npm',
  installGitPackage: 'pi-runtime:package-install-git',
  activatePackage: 'pi-runtime:package-activate',
  enablePackage: 'pi-runtime:package-enable',
  disablePackage: 'pi-runtime:package-disable',
  uninstallPackage: 'pi-runtime:package-uninstall',
  mcpCatalog: 'pi-runtime:mcp-catalog',
  activateMcp: 'pi-runtime:mcp-activate',
  enableMcp: 'pi-runtime:mcp-enable',
  disableMcp: 'pi-runtime:mcp-disable',
  retryMcp: 'pi-runtime:mcp-retry',
  enableMcpTool: 'pi-runtime:mcp-tool-enable',
  disableMcpTool: 'pi-runtime:mcp-tool-disable',
} as const

export type ProviderCredentialInput = {
  providerId: string
  persistence: 'persistent' | 'memory_only'
  apiKey: string
}

export type ModelSelectInput = {
  role: ModelSelectionRole
  providerId: string
  modelId: string
}
export type ModelOAuthStartInput = { operationId: string; providerId: string }
export type ModelOAuthOperationInput = { operationId: string }
export type ModelOAuthResponseInput = ModelOAuthOperationInput & { value: string }
export type ModelProviderConfigurationInput = OpenAICompatibleProviderConfiguration
export type PackageNamespace = 'global' | 'project'
export type PackageMutationInput = {
  namespace: PackageNamespace
  packageId: string
}
export type PackageLocalInstallInput = PackageMutationInput & {
  expectedPreviousContentSha256?: string
}
export type PackageNpmInstallInput = PackageLocalInstallInput & {
  name: string
  version: string
  integrity?: string
}
export type PackageGitInstallInput = PackageLocalInstallInput & {
  url: string
  commit: string
}
export type McpMutationInput = {
  namespace: PackageNamespace
  serverId: string
}
export type McpToolMutationInput = McpMutationInput & {
  toolName: string
}

const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const packageIdPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,127}$/
const exactVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const sha256Pattern = /^[0-9a-f]{64}$/
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const commitPattern = /^[0-9a-f]{40}$/
const mcpServerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const mcpToolNamePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function isPackageRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function isPackageMutation(value: Record<string, unknown>): boolean {
  return (
    (value.namespace === 'global' || value.namespace === 'project') &&
    typeof value.packageId === 'string' &&
    packageIdPattern.test(value.packageId)
  )
}

function hasValidPreviousHash(value: Record<string, unknown>): boolean {
  return (
    value.expectedPreviousContentSha256 === undefined ||
    (typeof value.expectedPreviousContentSha256 === 'string' &&
      sha256Pattern.test(value.expectedPreviousContentSha256))
  )
}

function isProviderId(value: unknown): value is string {
  try {
    parseCredentialProviderId(value)
    return true
  } catch {
    return false
  }
}

export function asProviderId(value: unknown): string {
  return parseCredentialProviderId(value)
}

export function asProviderCredentialInput(value: unknown): Readonly<ProviderCredentialInput> {
  if (
    !isExactRecord(value, ['providerId', 'persistence', 'apiKey']) ||
    !isProviderId(value.providerId) ||
    (value.persistence !== 'persistent' && value.persistence !== 'memory_only') ||
    typeof value.apiKey !== 'string' ||
    value.apiKey.length === 0 ||
    value.apiKey.length > 262_144
  ) {
    throw new Error('provider_credential_input_invalid')
  }
  return Object.freeze({
    providerId: value.providerId,
    persistence: value.persistence,
    apiKey: value.apiKey,
  })
}

export function asProviderCredentialStatus(value: unknown): Readonly<ProviderCredentialStatus> {
  return Object.freeze(parseProtocolProviderCredentialStatus(value))
}

export function asModelCatalog(value: unknown): Readonly<ModelCatalogProjection> {
  return Object.freeze(parseModelCatalogProjection(value))
}

export function asOAuthOperation(value: unknown): Readonly<OAuthOperationProjection> {
  return Object.freeze(parseOAuthOperationProjection(value))
}

export function asResourceCatalog(value: unknown): Readonly<ResourceCatalogProjection> {
  return Object.freeze(parseResourceCatalogProjection(value))
}

export function asPackageCatalog(value: unknown): Readonly<PackageCatalogProjection> {
  return Object.freeze(parsePackageCatalogProjection(value))
}

export function asMcpCatalog(value: unknown): Readonly<McpCatalogProjection> {
  return Object.freeze(parseMcpCatalogProjection(value))
}

export function asPackageNamespace(value: unknown): PackageNamespace {
  if (value !== 'global' && value !== 'project') throw new Error('package_namespace_invalid')
  return value
}

export function asPackageMutationInput(value: unknown): Readonly<PackageMutationInput> {
  if (!isPackageRecord(value, ['namespace', 'packageId'], []) || !isPackageMutation(value)) {
    throw new Error('package_mutation_input_invalid')
  }
  return Object.freeze({
    namespace: value.namespace as PackageNamespace,
    packageId: value.packageId as string,
  })
}

export function asMcpMutationInput(value: unknown): Readonly<McpMutationInput> {
  if (
    !isExactRecord(value, ['namespace', 'serverId']) ||
    (value.namespace !== 'global' && value.namespace !== 'project') ||
    typeof value.serverId !== 'string' ||
    !mcpServerIdPattern.test(value.serverId)
  ) {
    throw new Error('mcp_mutation_input_invalid')
  }
  return Object.freeze({ namespace: value.namespace, serverId: value.serverId })
}

export function asMcpToolMutationInput(value: unknown): Readonly<McpToolMutationInput> {
  if (
    !isExactRecord(value, ['namespace', 'serverId', 'toolName']) ||
    (value.namespace !== 'global' && value.namespace !== 'project') ||
    typeof value.serverId !== 'string' ||
    !mcpServerIdPattern.test(value.serverId) ||
    typeof value.toolName !== 'string' ||
    !mcpToolNamePattern.test(value.toolName)
  ) {
    throw new Error('mcp_tool_mutation_input_invalid')
  }
  return Object.freeze({
    namespace: value.namespace,
    serverId: value.serverId,
    toolName: value.toolName,
  })
}

export function asPackageLocalInstallInput(value: unknown): Readonly<PackageLocalInstallInput> {
  if (
    !isPackageRecord(value, ['namespace', 'packageId'], ['expectedPreviousContentSha256']) ||
    !isPackageMutation(value) ||
    !hasValidPreviousHash(value)
  ) {
    throw new Error('package_local_install_input_invalid')
  }
  return Object.freeze({
    namespace: value.namespace as PackageNamespace,
    packageId: value.packageId as string,
    ...(value.expectedPreviousContentSha256
      ? { expectedPreviousContentSha256: value.expectedPreviousContentSha256 as string }
      : {}),
  })
}

export function asPackageNpmInstallInput(value: unknown): Readonly<PackageNpmInstallInput> {
  if (
    !isPackageRecord(
      value,
      ['namespace', 'packageId', 'name', 'version'],
      ['integrity', 'expectedPreviousContentSha256'],
    ) ||
    !isPackageMutation(value) ||
    typeof value.name !== 'string' ||
    !packageIdPattern.test(value.name) ||
    typeof value.version !== 'string' ||
    !exactVersionPattern.test(value.version) ||
    (value.integrity !== undefined &&
      (typeof value.integrity !== 'string' || !integrityPattern.test(value.integrity))) ||
    !hasValidPreviousHash(value)
  ) {
    throw new Error('package_npm_install_input_invalid')
  }
  return Object.freeze({ ...value }) as Readonly<PackageNpmInstallInput>
}

export function asPackageGitInstallInput(value: unknown): Readonly<PackageGitInstallInput> {
  if (
    !isPackageRecord(
      value,
      ['namespace', 'packageId', 'url', 'commit'],
      ['expectedPreviousContentSha256'],
    ) ||
    !isPackageMutation(value) ||
    typeof value.url !== 'string' ||
    value.url.length > 2048 ||
    !/^(?:https|ssh):\/\//.test(value.url) ||
    typeof value.commit !== 'string' ||
    !commitPattern.test(value.commit) ||
    !hasValidPreviousHash(value)
  ) {
    throw new Error('package_git_install_input_invalid')
  }
  return Object.freeze({ ...value }) as Readonly<PackageGitInstallInput>
}

export function asModelSelectInput(value: unknown): Readonly<ModelSelectInput> {
  if (
    !isExactRecord(value, ['role', 'providerId', 'modelId']) ||
    (value.role !== 'conversation' && value.role !== 'image' && value.role !== 'ocr') ||
    !isProviderId(value.providerId) ||
    typeof value.modelId !== 'string' ||
    value.modelId.length === 0 ||
    value.modelId.length > 256
  ) {
    throw new Error('model_select_input_invalid')
  }
  return Object.freeze({
    role: value.role,
    providerId: value.providerId,
    modelId: value.modelId,
  })
}

export function asModelProviderConfigurationInput(
  value: unknown,
): Readonly<ModelProviderConfigurationInput> {
  return Object.freeze(parseOpenAICompatibleProviderConfiguration(value))
}

export function asModelOAuthStartInput(value: unknown): Readonly<ModelOAuthStartInput> {
  if (
    !isExactRecord(value, ['operationId', 'providerId']) ||
    typeof value.operationId !== 'string' ||
    !operationIdPattern.test(value.operationId) ||
    !isProviderId(value.providerId)
  ) {
    throw new Error('model_oauth_start_input_invalid')
  }
  return Object.freeze({ operationId: value.operationId, providerId: value.providerId })
}

export function asModelOAuthOperationInput(value: unknown): Readonly<ModelOAuthOperationInput> {
  if (
    !isExactRecord(value, ['operationId']) ||
    typeof value.operationId !== 'string' ||
    !operationIdPattern.test(value.operationId)
  ) {
    throw new Error('model_oauth_operation_input_invalid')
  }
  return Object.freeze({ operationId: value.operationId })
}

export function asModelOAuthResponseInput(value: unknown): Readonly<ModelOAuthResponseInput> {
  if (
    !isExactRecord(value, ['operationId', 'value']) ||
    typeof value.operationId !== 'string' ||
    !operationIdPattern.test(value.operationId) ||
    typeof value.value !== 'string' ||
    value.value.length === 0 ||
    value.value.length > 16_384
  ) {
    throw new Error('model_oauth_response_input_invalid')
  }
  return Object.freeze({ operationId: value.operationId, value: value.value })
}

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
  saveProviderApiKey(input: ProviderCredentialInput): Promise<Readonly<ProviderCredentialStatus>>
  providerCredentialStatus(providerId: string): Promise<Readonly<ProviderCredentialStatus>>
  logoutProvider(providerId: string): Promise<Readonly<ProviderCredentialStatus>>
  modelCatalog(): Promise<Readonly<ModelCatalogProjection>>
  selectModel(input: ModelSelectInput): Promise<Readonly<ModelCatalogProjection>>
  configureModelProvider(
    input: ModelProviderConfigurationInput,
  ): Promise<Readonly<ModelCatalogProjection>>
  startModelOAuth(input: ModelOAuthStartInput): Promise<Readonly<OAuthOperationProjection>>
  modelOAuthStatus(input: ModelOAuthOperationInput): Promise<Readonly<OAuthOperationProjection>>
  respondModelOAuth(input: ModelOAuthResponseInput): Promise<Readonly<OAuthOperationProjection>>
  cancelModelOAuth(input: ModelOAuthOperationInput): Promise<Readonly<OAuthOperationProjection>>
  logoutModel(providerId: string): Promise<Readonly<ModelCatalogProjection>>
  resourceCatalog(): Promise<Readonly<ResourceCatalogProjection>>
  selectResourceProject(): Promise<Readonly<ResourceCatalogProjection>>
  grantProjectTrust(): Promise<Readonly<ResourceCatalogProjection>>
  revokeProjectTrust(): Promise<Readonly<ResourceCatalogProjection>>
  packageCatalog(namespace: PackageNamespace): Promise<Readonly<PackageCatalogProjection>>
  installLocalPackage(input: PackageLocalInstallInput): Promise<Readonly<PackageCatalogProjection>>
  installNpmPackage(input: PackageNpmInstallInput): Promise<Readonly<PackageCatalogProjection>>
  installGitPackage(input: PackageGitInstallInput): Promise<Readonly<PackageCatalogProjection>>
  activatePackage(input: PackageMutationInput): Promise<Readonly<PackageCatalogProjection>>
  enablePackage(input: PackageMutationInput): Promise<Readonly<PackageCatalogProjection>>
  disablePackage(input: PackageMutationInput): Promise<Readonly<PackageCatalogProjection>>
  uninstallPackage(input: PackageMutationInput): Promise<Readonly<PackageCatalogProjection>>
  mcpCatalog(): Promise<Readonly<McpCatalogProjection>>
  activateMcp(input: McpMutationInput): Promise<Readonly<McpCatalogProjection>>
  enableMcp(input: McpMutationInput): Promise<Readonly<McpCatalogProjection>>
  disableMcp(input: McpMutationInput): Promise<Readonly<McpCatalogProjection>>
  retryMcp(input: McpMutationInput): Promise<Readonly<McpCatalogProjection>>
  enableMcpTool(input: McpToolMutationInput): Promise<Readonly<McpCatalogProjection>>
  disableMcpTool(input: McpToolMutationInput): Promise<Readonly<McpCatalogProjection>>
}
