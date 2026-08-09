import { join } from 'node:path'
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
  PackageCatalogProjection,
  ResourceCatalogProjection,
} from '@genoffice/agent-runtime-protocol'
import {
  PackageInstallCoordinator,
  PackageSourceResolver,
  type PackageSourceRequest,
} from './package-source-resolver'

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
  packageDiagnostics: readonly PackageDiagnostic[]
}

export type PreparedExtensionTool = {
  namespace: 'global' | 'project'
  packageId: string
  contentSha256: string
  extensionPath: string
  name: string
  canonicalToolId: string
}

export type PackageDiagnostic = {
  packageId: string
  code: 'tool_alias_collision'
}

export type RunResourceServiceOptions = {
  resourceHome: string
  deviceId: string
  permissionVersion?: () => string
  isToolEnabled?: (toolId: string) => boolean
  packageSourceResolver?: Pick<PackageSourceResolver, 'resolve'>
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
    const toolIds = [
      ...input.toolIds.filter((toolId) => toolId !== 'platform:resource:read' || hasActiveSkill),
      ...packageSelection.extensionTools.map((tool) => tool.canonicalToolId),
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
      ],
      toolIds,
      permissionVersion: this.permissionVersion(),
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
      extensionTools: Object.freeze(packageSelection.extensionTools),
      packageDiagnostics: Object.freeze(packageSelection.diagnostics),
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
    await verifyCapabilitySnapshot(snapshot, {
      permissionVersion: this.permissionVersion(),
      isResourceAuthorized: async (resourceKey, contentSha256) =>
        authorized.get(resourceKey) === contentSha256,
      isToolEnabled: this.isToolEnabled,
    })
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
}
