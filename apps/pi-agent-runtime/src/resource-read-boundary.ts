import { lstat, readFile, realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { CapabilitySnapshotError, type CapabilitySnapshot } from '@genoffice/agent-resource'

export type ResourceReadBoundaryOptions = {
  verify: (snapshot: CapabilitySnapshot, projectRoot?: string) => Promise<void>
}

export type ResourceReadConfiguration = {
  snapshot: CapabilitySnapshot
  skillRoots: readonly string[]
  projectRoot?: string
}

export class ResourceReadBoundary {
  private configuration: ResourceReadConfiguration | undefined

  constructor(private readonly options: ResourceReadBoundaryOptions) {}

  configure(configuration: ResourceReadConfiguration): void {
    this.configuration = {
      snapshot: configuration.snapshot,
      skillRoots: [...configuration.skillRoots],
      ...(configuration.projectRoot ? { projectRoot: configuration.projectRoot } : {}),
    }
  }

  async access(path: string): Promise<void> {
    await this.authorize(path)
  }

  async readFile(path: string): Promise<Buffer> {
    return readFile(await this.authorize(path))
  }

  private async authorize(path: string): Promise<string> {
    const configuration = this.configuration
    if (!configuration) throw new CapabilitySnapshotError('capability_revoked')
    try {
      await this.options.verify(configuration.snapshot, configuration.projectRoot)
      const canonicalPath = await realpath(path)
      const metadata = await lstat(canonicalPath)
      if (!metadata.isFile()) throw new Error('not_file')
      const allowed = await Promise.all(configuration.skillRoots.map((root) => realpath(root)))
      if (!allowed.some((root) => canonicalPath.startsWith(`${root}${sep}`))) {
        throw new Error('outside_snapshot')
      }
      return canonicalPath
    } catch {
      throw new CapabilitySnapshotError('capability_revoked')
    }
  }
}
