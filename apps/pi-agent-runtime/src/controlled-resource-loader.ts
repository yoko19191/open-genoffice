import { lstat } from 'node:fs/promises'
import { DefaultResourceLoader, type ResourceLoader } from '@earendil-works/pi-coding-agent'

type DefaultOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

export type ControlledResourceLoaderOptions = Pick<
  DefaultOptions,
  'cwd' | 'agentDir' | 'settingsManager' | 'eventBus' | 'systemPrompt' | 'appendSystemPrompt'
>

export type ControlledResourcePaths = {
  skillPaths: readonly string[]
  promptPaths: readonly string[]
}

export class ControlledResourceLoader implements ResourceLoader {
  private delegate: DefaultResourceLoader
  private paths: ControlledResourcePaths = { skillPaths: [], promptPaths: [] }

  constructor(private readonly options: ControlledResourceLoaderOptions) {
    this.delegate = this.createDelegate()
  }

  configure(paths: ControlledResourcePaths): void {
    this.paths = {
      skillPaths: [...paths.skillPaths],
      promptPaths: [...paths.promptPaths],
    }
  }

  getExtensions(): ReturnType<ResourceLoader['getExtensions']> {
    return this.delegate.getExtensions()
  }

  getSkills(): ReturnType<ResourceLoader['getSkills']> {
    return this.delegate.getSkills()
  }

  getPrompts(): ReturnType<ResourceLoader['getPrompts']> {
    return this.delegate.getPrompts()
  }

  getThemes(): ReturnType<ResourceLoader['getThemes']> {
    return this.delegate.getThemes()
  }

  getAgentsFiles(): ReturnType<ResourceLoader['getAgentsFiles']> {
    return this.delegate.getAgentsFiles()
  }

  getSystemPrompt(): ReturnType<ResourceLoader['getSystemPrompt']> {
    return this.delegate.getSystemPrompt()
  }

  getSystemPromptSource(): ReturnType<ResourceLoader['getSystemPromptSource']> {
    return this.delegate.getSystemPromptSource()
  }

  getAppendSystemPrompt(): ReturnType<ResourceLoader['getAppendSystemPrompt']> {
    return this.delegate.getAppendSystemPrompt()
  }

  getAppendSystemPromptSources(): ReturnType<ResourceLoader['getAppendSystemPromptSources']> {
    return this.delegate.getAppendSystemPromptSources()
  }

  extendResources(paths: Parameters<ResourceLoader['extendResources']>[0]): void {
    if (
      (paths.skillPaths?.length ?? 0) > 0 ||
      (paths.promptPaths?.length ?? 0) > 0 ||
      (paths.themePaths?.length ?? 0) > 0
    ) {
      throw new Error('resource_extension_not_authorized')
    }
  }

  async reload(options?: Parameters<ResourceLoader['reload']>[0]): Promise<void> {
    await this.assertPaths()
    const candidate = this.createDelegate()
    await candidate.reload(options)
    if (
      candidate.getSkills().diagnostics.length > 0 ||
      candidate.getPrompts().diagnostics.length > 0
    ) {
      throw new Error('resource_loader_diagnostics')
    }
    this.delegate = candidate
  }

  private async assertPaths(): Promise<void> {
    try {
      await Promise.all([
        ...this.paths.skillPaths.map(async (path) => {
          const metadata = await lstat(path)
          if (!metadata.isDirectory()) throw new Error('invalid')
        }),
        ...this.paths.promptPaths.map(async (path) => {
          const metadata = await lstat(path)
          if (!metadata.isFile()) throw new Error('invalid')
        }),
      ])
    } catch {
      throw new Error('resource_loader_diagnostics')
    }
  }

  private createDelegate(): DefaultResourceLoader {
    return new DefaultResourceLoader({
      ...this.options,
      additionalSkillPaths: [...this.paths.skillPaths],
      additionalPromptTemplatePaths: [...this.paths.promptPaths],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
  }
}
