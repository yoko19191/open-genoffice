import { join } from 'node:path'
import type { CredentialStore } from '@earendil-works/pi-ai'
import {
  PackageLockService,
  ProjectTrustStore,
  ResourceActivationStore,
  createCapabilitySnapshot,
  resolveProjectIdentity,
  scanResourceCatalog,
  verifyCapabilitySnapshot,
  type CapabilitySnapshot,
  type ResolvedPackage,
  type ResourceCatalog,
} from '@genoffice/agent-resource'
import type {
  McpCatalogProjection,
  PackageCatalogProjection,
  ResourceCatalogProjection,
} from '@genoffice/agent-runtime-protocol'
import {
  PackageInstallCoordinator,
  PackageSourceResolver,
  type PackageSourceRequest,
} from './package-source-resolver'
import { McpAuthorizationBroker } from './mcp-authorization-broker'
import {
  McpConnectionSupervisor,
  type ActiveMcpServer,
  type McpConnectionSupervisorOptions,
  type McpExecutionContext,
  type McpToolDescriptor,
} from './mcp-connection-supervisor'
import { OpenGenOfficeMcpConfigResolver, type McpConfigScope } from './mcp-config-resolver'

export type RunModelMetadata = {
  providerId: string
  modelId: string
  capabilities: readonly string[]
}

export type PrepareRunResourcesInput = {
  runId: string
  projectRoot?: string
  model: RunModelMetadata
  toolIds: readonly string[]
}

export type PreparedRunResources = {
  catalog: ResourceCatalog
  snapshot: CapabilitySnapshot
  skillPaths: readonly string[]
  promptPaths: readonly string[]
  extensionTools: readonly PreparedExtensionTool[]
  mcpTools: readonly PreparedMcpTool[]
  packageDiagnostics: readonly PackageDiagnostic[]
  mcpDiagnostics: readonly McpDiagnostic[]
}

export type PreparedExtensionTool = {
  namespace: 'global' | 'project'
  packageId: string
  contentSha256: string
  extensionPath: string
  name: string
  canonicalToolId: string
}

export type PreparedMcpTool = McpToolDescriptor & {
  namespace: 'global' | 'project'
  contentSha256: string
}

export type PackageDiagnostic = {
  packageId: string
  code: 'tool_alias_collision'
}

export type McpDiagnostic = {
  serverId: string
  code: 'connection_failed' | 'needs_credentials' | 'tool_alias_collision'
}

export type RunResourceServiceOptions = {
  resourceHome: string
  deviceId: string
  permissionVersion?: () => string
  isToolEnabled?: (toolId: string) => boolean
  packageSourceResolver?: Pick<PackageSourceResolver, 'resolve'>
  credentials?: Pick<CredentialStore, 'read'>
  environment?: Readonly<Record<string, string | undefined>>
  artifactBroker?: McpConnectionSupervisorOptions['artifactBroker']
  mcpResolver?: Pick<
    OpenGenOfficeMcpConfigResolver,
    'resolve' | 'activate' | 'setServerEnabled' | 'setToolEnabled'
  >
  createMcpSupervisor?: (
    server: ActiveMcpServer,
    authorize: ConstructorParameters<typeof McpConnectionSupervisor>[0]['authorize'],
  ) => McpConnectionSupervisor
}

export type PackageScope = {
  namespace: 'global' | 'project'
  projectRoot?: string
}

export type PackageMutation = PackageScope & {
  operationId: string
  packageId: string
}

export type PackageInstall = PackageMutation & {
  source: PackageSourceRequest
  expectedPreviousContentSha256?: string
}

export type RunResourceServiceErrorCode = 'package_scope_invalid' | 'package_project_untrusted'

export class RunResourceServiceError extends Error {
  constructor(readonly code: RunResourceServiceErrorCode) {
    super(code)
    this.name = 'RunResourceServiceError'
  }
}

export class RunResourceService {
  private readonly trust: ProjectTrustStore
  private readonly activation: ResourceActivationStore
  private readonly permissionVersion: () => string
  private readonly isToolEnabled: (toolId: string) => boolean
  private readonly packageSourceResolver: Pick<PackageSourceResolver, 'resolve'>
  private readonly mcpResolver: Pick<
    OpenGenOfficeMcpConfigResolver,
    'resolve' | 'activate' | 'setServerEnabled' | 'setToolEnabled'
  >
  private readonly mcpAuthorization: McpAuthorizationBroker
  private readonly supervisors = new Map<string, McpConnectionSupervisor>()
  private readonly preparedMcpRuns = new Map<
    string,
    {
      snapshot: CapabilitySnapshot
      projectRoot?: string
      tools: Map<string, { supervisor: McpConnectionSupervisor; toolName: string }>
    }
  >()

  constructor(private readonly options: RunResourceServiceOptions) {
    this.trust = new ProjectTrustStore({
      rootDirectory: options.resourceHome,
      deviceId: options.deviceId,
    })
    this.activation = new ResourceActivationStore({
      rootDirectory: options.resourceHome,
      deviceId: options.deviceId,
    })
    this.permissionVersion = options.permissionVersion ?? (() => 'agent-permission-v1')
    this.isToolEnabled = options.isToolEnabled ?? (() => true)
    this.packageSourceResolver =
      options.packageSourceResolver ??
      new PackageSourceResolver({ resourceHome: options.resourceHome })
    this.mcpResolver =
      options.mcpResolver ??
      new OpenGenOfficeMcpConfigResolver({
        resourceHome: options.resourceHome,
        deviceId: options.deviceId,
      })
    this.mcpAuthorization = new McpAuthorizationBroker({
      authorizeRun: (input) => this.authorizeMcpCall(input.runId, input.canonicalToolId),
    })
  }

  async prepare(input: PrepareRunResourcesInput): Promise<PreparedRunResources> {
    const catalog = await this.scan(input.projectRoot)
    const activeResources = catalog.resources.filter(
      (resource) =>
        resource.state === 'eligible' &&
        (resource.kind === 'skill' || resource.kind === 'prompt') &&
        resource.path &&
        resource.contentSha256,
    ) as Array<(typeof catalog.resources)[number] & { path: string; contentSha256: string }>
    const hasActiveSkill = activeResources.some((resource) => resource.kind === 'skill')
    const packageSelection = await this.selectPackageTools(input.projectRoot)
    const mcpSelection = await this.selectMcpTools(input.projectRoot)
    const aliasOwners = new Map<string, string[]>()
    const addAlias = (alias: string, owner: string) => {
      const owners = aliasOwners.get(alias) ?? []
      owners.push(owner)
      aliasOwners.set(alias, owners)
    }
    addAlias('read', 'platform/resource-read')
    for (const tool of packageSelection.extensionTools) {
      addAlias(tool.name, `package:${tool.namespace}/${tool.packageId}`)
    }
    for (const tool of mcpSelection.tools) {
      addAlias(tool.modelAlias, `mcp:${tool.namespace}/${tool.serverId}`)
    }
    const collidedAliases = new Set(
      [...aliasOwners.entries()].filter(([, owners]) => owners.length > 1).map(([alias]) => alias),
    )
    const extensionTools = packageSelection.extensionTools.filter(
      (tool) => !collidedAliases.has(tool.name),
    )
    const mcpTools = mcpSelection.tools.filter((tool) => !collidedAliases.has(tool.modelAlias))
    const collidedPackageIds = new Set(
      packageSelection.extensionTools
        .filter((tool) => collidedAliases.has(tool.name))
        .map((tool) => tool.packageId),
    )
    const collidedMcpIds = new Set(
      mcpSelection.tools
        .filter((tool) => collidedAliases.has(tool.modelAlias))
        .map((tool) => tool.serverId),
    )
    const toolIds = [
      ...input.toolIds.filter((toolId) => toolId !== 'platform:resource:read' || hasActiveSkill),
      ...extensionTools.map((tool) => tool.canonicalToolId),
      ...mcpTools.map((tool) => tool.canonicalToolId),
    ]
    const snapshot = createCapabilitySnapshot({
      createdForRunId: input.runId,
      model: input.model,
      resources: [
        ...activeResources.map((resource) => ({
          resourceKey: resource.resourceKey,
          contentSha256: resource.contentSha256,
        })),
        ...packageSelection.packages.map(({ namespace, resolved }) => ({
          resourceKey: this.packageResourceKey(namespace, resolved.entry.packageId),
          contentSha256: resolved.entry.contentSha256,
        })),
        ...mcpTools.map((tool) => ({
          resourceKey: this.mcpResourceKey(tool.namespace, tool.serverId),
          contentSha256: tool.contentSha256,
        })),
      ],
      toolIds,
      permissionVersion: this.permissionVersion(),
    })
    this.preparedMcpRuns.set(input.runId, {
      snapshot,
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      tools: new Map(
        mcpTools.map((tool) => [
          tool.canonicalToolId,
          {
            supervisor: mcpSelection.supervisors.get(
              this.mcpSupervisorKey(tool.namespace, tool.serverId, tool.contentSha256),
            )!,
            toolName: tool.toolName,
          },
        ]),
      ),
    })
    return Object.freeze({
      catalog,
      snapshot,
      skillPaths: Object.freeze(
        activeResources
          .filter((resource) => resource.kind === 'skill')
          .map((resource) => resource.path),
      ),
      promptPaths: Object.freeze(
        activeResources
          .filter((resource) => resource.kind === 'prompt')
          .map((resource) => resource.path),
      ),
      extensionTools: Object.freeze(extensionTools),
      mcpTools: Object.freeze(mcpTools),
      packageDiagnostics: Object.freeze([
        ...packageSelection.diagnostics,
        ...[...collidedPackageIds].map((packageId) => ({
          packageId,
          code: 'tool_alias_collision' as const,
        })),
      ]),
      mcpDiagnostics: Object.freeze([
        ...mcpSelection.diagnostics,
        ...[...collidedMcpIds].map((serverId) => ({
          serverId,
          code: 'tool_alias_collision' as const,
        })),
      ]),
    })
  }

  async verify(snapshot: CapabilitySnapshot, projectRoot?: string): Promise<void> {
    const catalog = await this.scan(projectRoot)
    const authorized = new Map(
      catalog.resources
        .filter((resource) => resource.state === 'eligible' && resource.contentSha256 !== undefined)
        .map((resource) => [resource.resourceKey, resource.contentSha256!]),
    )
    const packageSelection = await this.selectPackageTools(projectRoot)
    for (const { namespace, resolved } of packageSelection.packages) {
      authorized.set(
        this.packageResourceKey(namespace, resolved.entry.packageId),
        resolved.entry.contentSha256,
      )
    }
    const mcpServers = await this.mcpResolver.resolve(projectRoot)
    for (const server of mcpServers) {
      if (server.state === 'eligible') {
        authorized.set(this.mcpResourceKey(server.namespace, server.serverId), server.contentSha256)
      }
    }
    await verifyCapabilitySnapshot(snapshot, {
      permissionVersion: this.permissionVersion(),
      isResourceAuthorized: async (resourceKey, contentSha256) =>
        authorized.get(resourceKey) === contentSha256,
      isToolEnabled: (toolId) => {
        if (!this.isToolEnabled(toolId)) return false
        if (!toolId.startsWith('mcp:')) return true
        return mcpServers.some(
          (server) =>
            server.state === 'eligible' &&
            toolId.startsWith(`mcp:${server.serverId}:`) &&
            server.enabledToolIds.includes(toolId.slice(`mcp:${server.serverId}:`.length)),
        )
      },
    })
  }

  async callMcpTool(canonicalToolId: string, params: unknown, context: McpExecutionContext) {
    const prepared = this.preparedMcpRuns.get(context.runId)
    const tool = prepared?.tools.get(canonicalToolId)
    if (!prepared || !tool) throw new Error('tool_not_in_snapshot')
    return tool.supervisor.callTool(tool.toolName, params, context)
  }

  async mcpCatalog(projectRoot?: string): Promise<McpCatalogProjection> {
    let projectState: McpCatalogProjection['projectState'] = 'none'
    if (projectRoot) {
      try {
        const identity = await resolveProjectIdentity(projectRoot, this.options.deviceId)
        projectState = (await this.trust.isTrusted(identity)) ? 'trusted' : 'untrusted'
      } catch {
        projectState = 'invalid'
      }
    }
    const configured = await this.mcpResolver.resolve(projectRoot)
    const selection = await this.selectMcpTools(projectRoot)
    const packageSelection = await this.selectPackageTools(projectRoot)
    const aliasOwners = new Map<string, string[]>()
    const addAlias = (alias: string, owner: string) => {
      const owners = aliasOwners.get(alias) ?? []
      owners.push(owner)
      aliasOwners.set(alias, owners)
    }
    addAlias('read', 'platform/resource-read')
    for (const tool of packageSelection.extensionTools) {
      addAlias(tool.name, `package:${tool.namespace}/${tool.packageId}`)
    }
    for (const tool of selection.tools) {
      addAlias(tool.modelAlias, `mcp:${tool.namespace}/${tool.serverId}`)
    }
    const collidingMcpServers = new Set(
      [...aliasOwners.values()]
        .filter((owners) => owners.length > 1)
        .flatMap((owners) => owners)
        .filter((owner) => owner.startsWith('mcp:'))
        .map((owner) => owner.slice(owner.lastIndexOf('/') + 1)),
    )
    const diagnostics = new Map(
      selection.diagnostics.map((diagnostic) => [diagnostic.serverId, diagnostic.code]),
    )
    return {
      projectState,
      servers: configured.map((server) => {
        const supervisor = selection.supervisors.get(
          this.mcpSupervisorKey(server.namespace, server.serverId, server.contentSha256),
        )
        const diagnostic = diagnostics.get(server.serverId)
        const state: McpCatalogProjection['servers'][number]['state'] = collidingMcpServers.has(
          server.serverId,
        )
          ? 'tool_alias_collision'
          : server.state === 'eligible'
            ? diagnostic === 'needs_credentials'
              ? 'needs_credentials'
              : diagnostic
                ? 'failed'
                : 'ready'
            : server.state
        return {
          namespace: server.namespace,
          serverId: server.serverId,
          contentSha256: server.contentSha256,
          state,
          tools:
            supervisor?.catalogTools().map((tool) => ({
              canonicalToolId: tool.canonicalToolId,
              toolName: tool.toolName,
              modelAlias: tool.modelAlias,
              enabled: server.enabledToolIds.includes(tool.toolName),
            })) ?? [],
          action:
            state === 'activation_required'
              ? 'activate'
              : state === 'disabled'
                ? 'enable'
                : state === 'needs_credentials'
                  ? 'configure_credentials'
                  : state === 'failed'
                    ? 'retry'
                    : state === 'server_id_collision' || state === 'tool_alias_collision'
                      ? 'fix_collision'
                      : 'disable',
        }
      }),
    }
  }

  async activateMcp(scope: McpConfigScope, serverId: string): Promise<McpCatalogProjection> {
    await this.mcpResolver.activate(scope, serverId)
    return this.mcpCatalog(scope.namespace === 'project' ? scope.projectRoot : undefined)
  }

  async setMcpServerEnabled(
    scope: McpConfigScope,
    serverId: string,
    enabled: boolean,
  ): Promise<McpCatalogProjection> {
    await this.mcpResolver.setServerEnabled(scope, serverId, enabled)
    await this.closeMcpServer(scope.namespace, serverId)
    return this.mcpCatalog(scope.namespace === 'project' ? scope.projectRoot : undefined)
  }

  async setMcpToolEnabled(
    scope: McpConfigScope,
    serverId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<McpCatalogProjection> {
    await this.mcpResolver.setToolEnabled(scope, serverId, toolName, enabled)
    await this.closeMcpServer(scope.namespace, serverId)
    return this.mcpCatalog(scope.namespace === 'project' ? scope.projectRoot : undefined)
  }

  async retryMcp(scope: McpConfigScope, serverId: string): Promise<McpCatalogProjection> {
    await this.closeMcpServer(scope.namespace, serverId)
    return this.mcpCatalog(scope.namespace === 'project' ? scope.projectRoot : undefined)
  }

  releaseRun(runId: string): void {
    this.preparedMcpRuns.delete(runId)
  }

  async shutdown(): Promise<void> {
    this.preparedMcpRuns.clear()
    await Promise.allSettled([...this.supervisors.values()].map((supervisor) => supervisor.close()))
    this.supervisors.clear()
  }

  async catalog(projectRoot?: string): Promise<ResourceCatalogProjection> {
    let projectState: ResourceCatalogProjection['projectState'] = 'none'
    if (projectRoot) {
      try {
        const identity = await resolveProjectIdentity(projectRoot, this.options.deviceId)
        projectState = (await this.trust.isTrusted(identity)) ? 'trusted' : 'untrusted'
      } catch {
        projectState = 'invalid'
      }
    }
    const catalog = await this.scan(projectRoot)
    return {
      catalogId: catalog.catalogId,
      projectState,
      resources: catalog.resources.map((resource) => ({
        resourceKey: resource.resourceKey,
        resourceId: resource.resourceId,
        namespace: resource.namespace,
        kind: resource.kind,
        source: resource.source,
        state: resource.state,
        ...(resource.reason ? { reason: resource.reason } : {}),
        ...(resource.contentSha256 ? { contentSha256: resource.contentSha256 } : {}),
        action:
          resource.reason === 'project_untrusted'
            ? 'trust_project'
            : resource.reason === 'activation_required'
              ? 'activate_resource'
              : resource.reason === 'resource_collision'
                ? 'rename_resource'
                : resource.state === 'invalid'
                  ? 'fix_resource'
                  : 'none',
      })),
    }
  }

  async grantProjectTrust(projectRoot: string): Promise<ResourceCatalogProjection> {
    await this.trust.grant(await resolveProjectIdentity(projectRoot, this.options.deviceId))
    return this.catalog(projectRoot)
  }

  async revokeProjectTrust(projectRoot: string): Promise<ResourceCatalogProjection> {
    await this.trust.revoke(await resolveProjectIdentity(projectRoot, this.options.deviceId))
    return this.catalog(projectRoot)
  }

  async packageCatalog(scope: PackageScope): Promise<PackageCatalogProjection> {
    const scopedStore = await this.packageStore(scope)
    const global = await (
      scope.namespace === 'global' ? scopedStore : await this.packageStore({ namespace: 'global' })
    ).catalog()
    const project = scope.namespace === 'project' ? await scopedStore.catalog() : undefined
    const diagnostics = new Set(
      (
        await this.selectPackageTools(scope.namespace === 'project' ? scope.projectRoot : undefined)
      ).diagnostics.map((diagnostic) => diagnostic.packageId),
    )
    const packages = [
      ...global.packages.map((entry) => ({ namespace: 'global' as const, ...entry })),
      ...(project?.packages.map((entry) => ({ namespace: 'project' as const, ...entry })) ?? []),
    ].map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities],
      status: diagnostics.has(entry.packageId) ? ('tool_alias_collision' as const) : entry.status,
    }))
    return {
      globalGeneration: global.generation,
      ...(project ? { projectGeneration: project.generation } : {}),
      packages,
    }
  }

  async installPackage(input: PackageInstall): Promise<PackageCatalogProjection> {
    const packages = await this.packageStore(input)
    await new PackageInstallCoordinator({
      resolver: this.packageSourceResolver,
      packages,
    }).install({
      operationId: input.operationId,
      packageId: input.packageId,
      source: input.source,
      ...(input.expectedPreviousContentSha256
        ? { expectedPreviousContentSha256: input.expectedPreviousContentSha256 }
        : {}),
    })
    return this.packageCatalog(input)
  }

  async activatePackage(input: PackageMutation): Promise<PackageCatalogProjection> {
    await (await this.packageStore(input)).activate(input.packageId)
    return this.packageCatalog(input)
  }

  async enablePackage(input: PackageMutation): Promise<PackageCatalogProjection> {
    await (await this.packageStore(input)).enable(input.packageId)
    return this.packageCatalog(input)
  }

  async disablePackage(input: PackageMutation): Promise<PackageCatalogProjection> {
    await (await this.packageStore(input)).disable(input.packageId)
    return this.packageCatalog(input)
  }

  async uninstallPackage(input: PackageMutation): Promise<PackageCatalogProjection> {
    await (await this.packageStore(input)).uninstall(input.packageId)
    return this.packageCatalog(input)
  }

  private async scan(projectRoot?: string): Promise<ResourceCatalog> {
    let projectTrusted = false
    if (projectRoot) {
      try {
        const identity = await resolveProjectIdentity(projectRoot, this.options.deviceId)
        projectTrusted = await this.trust.isTrusted(identity)
      } catch {
        projectTrusted = false
      }
    }
    return scanResourceCatalog({
      resourceHome: this.options.resourceHome,
      ...(projectRoot ? { projectRoot, projectTrusted } : {}),
      isActivated: (descriptor) => this.activation.isActive(descriptor),
    })
  }

  private async packageStore(scope: PackageScope): Promise<PackageLockService> {
    if (scope.namespace === 'global') {
      if (scope.projectRoot !== undefined) {
        throw new RunResourceServiceError('package_scope_invalid')
      }
      return new PackageLockService({
        resourceHome: this.options.resourceHome,
        deviceId: this.options.deviceId,
        namespace: 'global',
      })
    }
    if (!scope.projectRoot) throw new RunResourceServiceError('package_scope_invalid')
    const identity = await resolveProjectIdentity(scope.projectRoot, this.options.deviceId)
    if (!(await this.trust.isTrusted(identity))) {
      throw new RunResourceServiceError('package_project_untrusted')
    }
    return new PackageLockService({
      resourceHome: this.options.resourceHome,
      deviceId: this.options.deviceId,
      namespace: 'project',
      projectRoot: scope.projectRoot,
    })
  }

  private async selectPackageTools(projectRoot?: string): Promise<{
    packages: Array<{ namespace: 'global' | 'project'; resolved: ResolvedPackage }>
    extensionTools: PreparedExtensionTool[]
    diagnostics: PackageDiagnostic[]
  }> {
    const packages: Array<{ namespace: 'global' | 'project'; resolved: ResolvedPackage }> = (
      await new PackageLockService({
        resourceHome: this.options.resourceHome,
        deviceId: this.options.deviceId,
        namespace: 'global',
      }).resolveEligible()
    ).map((resolved) => ({ namespace: 'global' as const, resolved }))
    if (projectRoot) {
      try {
        const identity = await resolveProjectIdentity(projectRoot, this.options.deviceId)
        if (await this.trust.isTrusted(identity)) {
          packages.push(
            ...(
              await new PackageLockService({
                resourceHome: this.options.resourceHome,
                deviceId: this.options.deviceId,
                namespace: 'project',
                projectRoot,
              }).resolveEligible()
            ).map((resolved) => ({ namespace: 'project' as const, resolved })),
          )
        }
      } catch {
        // Invalid or unavailable projects never contribute executable resources.
      }
    }

    const aliases = new Map<string, string[]>()
    for (const { namespace, resolved } of packages) {
      const packageKey = `${namespace}/${resolved.entry.packageId}`
      for (const tool of resolved.tools) {
        const owners = aliases.get(tool.name) ?? []
        owners.push(packageKey)
        aliases.set(tool.name, owners)
      }
    }
    aliases.set('read', ['platform/resource-read', ...(aliases.get('read') ?? [])])
    const collisions = new Set(
      [...aliases.values()].filter((owners) => owners.length > 1).flatMap((owners) => owners),
    )
    const selectedPackages = packages.filter(
      ({ namespace, resolved }) => !collisions.has(`${namespace}/${resolved.entry.packageId}`),
    )
    const extensionTools = selectedPackages.flatMap(({ namespace, resolved }) =>
      resolved.tools.map((tool) => ({
        namespace,
        packageId: resolved.entry.packageId,
        contentSha256: resolved.entry.contentSha256,
        extensionPath: join(resolved.directory, tool.extension),
        name: tool.name,
        canonicalToolId: `platform:extension:${namespace}/${resolved.entry.packageId}/${tool.name}`,
      })),
    )
    const diagnostics = packages
      .filter(({ namespace, resolved }) =>
        collisions.has(`${namespace}/${resolved.entry.packageId}`),
      )
      .map(({ resolved }) => ({
        packageId: resolved.entry.packageId,
        code: 'tool_alias_collision' as const,
      }))
      .sort((left, right) => left.packageId.localeCompare(right.packageId))
    return { packages: selectedPackages, extensionTools, diagnostics }
  }

  private packageResourceKey(namespace: 'global' | 'project', packageId: string): string {
    return `package:${namespace}/${packageId}`
  }

  private async selectMcpTools(projectRoot?: string): Promise<{
    tools: PreparedMcpTool[]
    diagnostics: McpDiagnostic[]
    supervisors: Map<string, McpConnectionSupervisor>
  }> {
    const servers = (await this.mcpResolver.resolve(projectRoot)).filter(
      (server) => server.state === 'eligible',
    )
    const tools: PreparedMcpTool[] = []
    const diagnostics: McpDiagnostic[] = []
    const selected = new Map<string, McpConnectionSupervisor>()
    for (const server of servers) {
      const key = this.mcpSupervisorKey(server.namespace, server.serverId, server.contentSha256)
      let supervisor = this.supervisors.get(key)
      if (!supervisor) {
        const active: ActiveMcpServer = {
          namespace: server.namespace,
          serverId: server.serverId,
          command: server.command,
          args: server.args,
          inheritedEnv: server.inheritedEnv,
          credentialEnvironment: server.credentialEnvironment,
          enabledToolIds: server.enabledToolIds,
          timeoutMs: server.timeoutMs,
          contentSha256: server.contentSha256,
        }
        supervisor = this.options.createMcpSupervisor
          ? this.options.createMcpSupervisor(active, (input) =>
              this.mcpAuthorization.authorize(input),
            )
          : new McpConnectionSupervisor({
              server: active,
              credentials: this.options.credentials ?? { read: async () => undefined },
              environment: this.options.environment,
              artifactBroker: this.options.artifactBroker,
              authorize: (input) => this.mcpAuthorization.authorize(input),
            })
        this.supervisors.set(key, supervisor)
      }
      try {
        const listed = await supervisor.connect()
        selected.set(key, supervisor)
        tools.push(
          ...listed.map((tool) => ({
            ...tool,
            namespace: server.namespace,
            contentSha256: server.contentSha256,
          })),
        )
      } catch (error) {
        diagnostics.push({
          serverId: server.serverId,
          code:
            error instanceof Error && error.message === 'mcp_credential_missing'
              ? 'needs_credentials'
              : 'connection_failed',
        })
      }
    }
    return { tools, diagnostics, supervisors: selected }
  }

  private async authorizeMcpCall(runId: string, canonicalToolId: string): Promise<boolean> {
    const run = this.preparedMcpRuns.get(runId)
    if (!run || !run.tools.has(canonicalToolId)) return false
    try {
      await this.verify(run.snapshot, run.projectRoot)
      return run.snapshot.toolIds.includes(canonicalToolId)
    } catch {
      return false
    }
  }

  private mcpResourceKey(namespace: 'global' | 'project', serverId: string): string {
    return `mcp:${namespace}/${serverId}`
  }

  private mcpSupervisorKey(
    namespace: 'global' | 'project',
    serverId: string,
    contentSha256: string,
  ): string {
    return `${namespace}/${serverId}/${contentSha256}`
  }

  private async closeMcpServer(namespace: 'global' | 'project', serverId: string): Promise<void> {
    const prefix = `${namespace}/${serverId}/`
    const matches = [...this.supervisors.entries()].filter(([key]) => key.startsWith(prefix))
    await Promise.allSettled(matches.map(([, supervisor]) => supervisor.close()))
    for (const [key] of matches) this.supervisors.delete(key)
  }
}
