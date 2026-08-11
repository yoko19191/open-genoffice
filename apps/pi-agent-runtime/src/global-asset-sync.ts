import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import {
  PackageLockSchema,
  PackageLockService,
  ResourceActivationStore,
  scanResourceCatalog,
  type PackageLock,
  type ResourceActivationDescriptor,
} from '@genoffice/agent-resource'
import {
  OpenGenOfficeMcpConfigResolver,
  readMcpServerDeclarations,
  type StoredMcpServer,
} from './mcp-config-resolver'

const MAX_PATHS = 10_000
const MAX_FILE_BYTES = 256 * 1024 * 1024
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export type GlobalAssetSyncKind =
  | 'global-asset'
  | 'global-skill'
  | 'global-extension'
  | 'global-prompt'
  | 'global-package-lock'
  | 'global-mcp-config'
  | 'credential-slot'

export type GlobalAssetSyncEntry = {
  canonicalPath: string
  kind: GlobalAssetSyncKind
  bytes?: Uint8Array
  executable?: boolean
  network?: boolean
  credentialSlot?: { slotId: string; providerId: string }
}

export type GlobalResourceState =
  | 'eligible'
  | 'activation_required'
  | 'disabled'
  | 'source_unavailable'
  | 'integrity_invalid'
  | 'invalid'

export type GlobalResourceProjection = {
  resourceId: string
  kind: 'skill' | 'extension' | 'prompt' | 'package' | 'mcp'
  source: string
  contentSha256: string
  capabilities: readonly ('executable' | 'network')[]
  state: GlobalResourceState
  activation?: ResourceActivationDescriptor
}

export type GlobalAssetStatus = {
  resources: GlobalResourceProjection[]
  missingCredentialSlots: string[]
}

export class GlobalAssetSyncError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'GlobalAssetSyncError'
  }
}

type CapturedFile = {
  canonicalPath: string
  bytes: Uint8Array
  kind: Exclude<GlobalAssetSyncKind, 'credential-slot'>
  executable: boolean
  network: boolean
}

function safeSegment(segment: string): boolean {
  return (
    segment === segment.normalize('NFC') &&
    !segment.includes('\\') &&
    !WINDOWS_DEVICE_NAME.test(segment)
  )
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'))
}

function credentialSlots(servers: StoredMcpServer[]): Array<{
  slotId: string
  providerId: string
}> {
  const slots = servers.flatMap((server) => {
    if (server.transport === 'stdio') {
      return server.environment.credentials.map(({ credentialRef }) => ({
        slotId: credentialRef.slot,
        providerId: `mcp-${credentialRef.kind.replace('_', '-')}`,
      }))
    }
    return server.credentialRef
      ? [
          {
            slotId: server.credentialRef.slot,
            providerId: `mcp-${server.credentialRef.kind.replace('_', '-')}`,
          },
        ]
      : []
  })
  return [...new Map(slots.map((slot) => [slot.slotId, slot])).values()].sort((left, right) =>
    left.slotId.localeCompare(right.slotId, 'en-US'),
  )
}

export class GlobalAssetSyncService {
  readonly #resourceHome: string
  readonly #deviceId: string
  readonly #activation: ResourceActivationStore
  readonly #maxPaths: number
  readonly #maxFileBytes: number
  readonly #faultInjector?: (stage: 'after-read', path: string) => void | Promise<void>

  constructor(options: {
    resourceHome: string
    deviceId: string
    maxPaths?: number
    maxFileBytes?: number
    faultInjector?: (stage: 'after-read', path: string) => void | Promise<void>
  }) {
    this.#resourceHome = options.resourceHome
    this.#deviceId = options.deviceId
    this.#activation = new ResourceActivationStore({
      rootDirectory: options.resourceHome,
      deviceId: options.deviceId,
    })
    this.#maxPaths = options.maxPaths ?? MAX_PATHS
    this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES
    this.#faultInjector = options.faultInjector
  }

  async capture(): Promise<{ entries: GlobalAssetSyncEntry[] }> {
    const catalog = await scanResourceCatalog({ resourceHome: this.#resourceHome })
    if (
      catalog.resources.some(
        (resource) => resource.namespace === 'global' && resource.state === 'invalid',
      )
    ) {
      throw new GlobalAssetSyncError('global_asset_invalid')
    }
    const files = (
      await Promise.all([
        this.#captureDirectory('assets', 'global-asset'),
        this.#captureDirectory('agent/skills', 'global-skill'),
        this.#captureDirectory('agent/extensions', 'global-extension', true),
        this.#captureDirectory('agent/prompts', 'global-prompt'),
      ])
    ).flat()
    const packageLock = await this.#captureOptionalFile(
      'agent/packages.lock.json',
      'global-package-lock',
    )
    if (packageLock) {
      let value: unknown
      try {
        value = JSON.parse(Buffer.from(packageLock.bytes).toString('utf8'))
      } catch {
        throw new GlobalAssetSyncError('global_package_lock_invalid')
      }
      if (!Value.Check(PackageLockSchema, value)) {
        throw new GlobalAssetSyncError('global_package_lock_invalid')
      }
      const lock = value as PackageLock
      packageLock.executable = lock.packages.some((entry) =>
        entry.activatedCapabilities.includes('executable'),
      )
      packageLock.network = lock.packages.some((entry) =>
        entry.activatedCapabilities.includes('network'),
      )
      files.push(packageLock)
    }

    const declarations = await readMcpServerDeclarations(
      join(this.#resourceHome, 'mcp', 'servers.json'),
    ).catch(() => {
      throw new GlobalAssetSyncError('global_mcp_config_invalid')
    })
    const mcp = await this.#captureOptionalFile('mcp/servers.json', 'global-mcp-config')
    if (mcp) {
      mcp.executable = declarations.some((server) => server.transport === 'stdio')
      mcp.network = declarations.some((server) => server.transport !== 'stdio')
      files.push(mcp)
    }
    const slots: GlobalAssetSyncEntry[] = credentialSlots(declarations).map((credentialSlot) => ({
      canonicalPath: `.open-genoffice/credential-slots/${sha256(credentialSlot.slotId)}.json`,
      kind: 'credential-slot',
      credentialSlot,
    }))
    const entries: GlobalAssetSyncEntry[] = [...files, ...slots].sort((left, right) =>
      left.canonicalPath.localeCompare(right.canonicalPath, 'en-US'),
    )
    if (entries.length > this.#maxPaths) throw new GlobalAssetSyncError('global_asset_limit')
    return { entries }
  }

  async inspect(options: { availableCredentialSlots?: string[] } = {}): Promise<GlobalAssetStatus> {
    const catalog = await scanResourceCatalog({
      resourceHome: this.#resourceHome,
      isActivated: (descriptor) => this.#activation.isActive(descriptor),
    })
    const resources: GlobalResourceProjection[] = catalog.resources
      .filter((resource) => resource.namespace === 'global')
      .map((resource) => {
        const capabilities = resource.activatedCapabilities
        const activation =
          capabilities.length > 0 && resource.contentSha256
            ? {
                namespace: 'global' as const,
                resourceId: `${resource.kind}/${resource.resourceId}`,
                source: resource.source,
                contentSha256: resource.contentSha256,
                capabilities,
              }
            : undefined
        return {
          resourceId: `${resource.kind}/${resource.resourceId}`,
          kind: resource.kind,
          source: resource.source,
          contentSha256: resource.contentSha256 ?? '',
          capabilities,
          state:
            resource.reason === 'activation_required'
              ? ('activation_required' as const)
              : resource.state === 'eligible'
                ? ('eligible' as const)
                : ('invalid' as const),
          ...(activation ? { activation } : {}),
        }
      })

    const packages = await new PackageLockService({
      resourceHome: this.#resourceHome,
      deviceId: this.#deviceId,
      namespace: 'global',
    }).catalog()
    for (const item of packages.packages) {
      const activation: ResourceActivationDescriptor = {
        namespace: 'global',
        resourceId: `package/${item.packageId}`,
        source: `package:global/${item.packageId}`,
        contentSha256: item.contentSha256,
        capabilities: item.capabilities,
      }
      resources.push({
        resourceId: activation.resourceId,
        kind: 'package',
        source: activation.source,
        contentSha256: item.contentSha256,
        capabilities: item.capabilities,
        state: item.status,
        ...(item.capabilities.length > 0 ? { activation } : {}),
      })
    }

    const mcp = await new OpenGenOfficeMcpConfigResolver({
      resourceHome: this.#resourceHome,
      deviceId: this.#deviceId,
    }).resolve()
    for (const server of mcp) {
      resources.push({
        resourceId: server.activation.resourceId,
        kind: 'mcp',
        source: server.activation.source,
        contentSha256: server.contentSha256,
        capabilities: server.activation.capabilities,
        state:
          server.state === 'eligible'
            ? 'eligible'
            : server.state === 'activation_required'
              ? 'activation_required'
              : 'disabled',
        activation: server.activation,
      })
    }
    const available = new Set(options.availableCredentialSlots ?? [])
    return {
      resources: resources.sort((left, right) =>
        left.resourceId.localeCompare(right.resourceId, 'en-US'),
      ),
      missingCredentialSlots: uniqueSorted(
        credentialSlots(
          await readMcpServerDeclarations(join(this.#resourceHome, 'mcp', 'servers.json')),
        )
          .filter((slot) => !available.has(slot.slotId))
          .map((slot) => slot.slotId),
      ),
    }
  }

  async #captureDirectory(
    relativeRoot: string,
    kind: CapturedFile['kind'],
    executable = false,
  ): Promise<CapturedFile[]> {
    const absoluteRoot = join(this.#resourceHome, ...relativeRoot.split('/'))
    const root = await lstat(absoluteRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!root) return []
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new GlobalAssetSyncError('global_asset_invalid')
    }
    const files: CapturedFile[] = []
    const visit = async (directory: string, segments: string[]): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!safeSegment(entry.name) || entry.isSymbolicLink()) {
          throw new GlobalAssetSyncError('global_asset_invalid')
        }
        const nextSegments = [...segments, entry.name]
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(path, nextSegments)
          continue
        }
        if (!entry.isFile()) throw new GlobalAssetSyncError('global_asset_invalid')
        files.push(
          await this.#readStable(
            path,
            `${relativeRoot}/${nextSegments.join('/')}`,
            kind,
            executable,
            false,
          ),
        )
        if (files.length > this.#maxPaths) throw new GlobalAssetSyncError('global_asset_limit')
      }
    }
    await visit(absoluteRoot, [])
    return files
  }

  async #captureOptionalFile(
    canonicalPath: string,
    kind: CapturedFile['kind'],
  ): Promise<CapturedFile | undefined> {
    const path = join(this.#resourceHome, ...canonicalPath.split('/'))
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!metadata) return undefined
    return this.#readStable(path, canonicalPath, kind, false, false)
  }

  async #readStable(
    path: string,
    canonicalPath: string,
    kind: CapturedFile['kind'],
    executable: boolean,
    network: boolean,
  ): Promise<CapturedFile> {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > this.#maxFileBytes) {
      throw new GlobalAssetSyncError('global_asset_invalid')
    }
    const bytes = new Uint8Array(await readFile(path))
    await this.#faultInjector?.('after-read', path)
    const after = await lstat(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new GlobalAssetSyncError('global_asset_changed')
    }
    return { canonicalPath, bytes, kind, executable, network }
  }
}
