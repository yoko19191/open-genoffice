import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { ControlledResourceLoader } from '../src/controlled-resource-loader'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

describe('ControlledResourceLoader', () => {
  it('replaces the exact Skill and Prompt set instead of retaining paths from an earlier run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-loader-'))
    roots.push(root)
    const firstSkill = join(root, 'first', 'SKILL.md')
    const secondSkill = join(root, 'second', 'SKILL.md')
    const prompt = join(root, 'prompt.md')
    await write(firstSkill, '---\nname: first\ndescription: first skill\n---\nFirst instructions\n')
    await write(
      secondSkill,
      '---\nname: second\ndescription: second skill\n---\nSecond instructions\n',
    )
    await write(prompt, '---\ndescription: prompt\n---\nPrompt body\n')
    const loader = new ControlledResourceLoader({
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      systemPrompt: 'Controlled system prompt',
    })

    loader.configure({ skillPaths: [dirname(firstSkill)], promptPaths: [prompt] })
    await loader.reload()
    expect(loader.getSkills().skills.map(({ name }) => name)).toEqual(['first'])
    expect(loader.getPrompts().prompts.map(({ name }) => name)).toEqual(['prompt'])
    expect(loader.getSystemPrompt()).toBe('Controlled system prompt')

    loader.configure({ skillPaths: [dirname(secondSkill)], promptPaths: [] })
    await loader.reload()
    expect(loader.getSkills().skills.map(({ name }) => name)).toEqual(['second'])
    expect(loader.getPrompts().prompts).toEqual([])
    expect(JSON.stringify(loader.getSkills())).not.toContain('First instructions')
    expect(loader.getThemes().themes).toEqual([])
    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
    expect(loader.getSystemPromptSource()).toBeUndefined()
    expect(loader.getAppendSystemPrompt()).toEqual([])
    expect(loader.getAppendSystemPromptSources()).toEqual([])
  })

  it('rejects resource extension outside the frozen run set and keeps the last good delegate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-loader-'))
    roots.push(root)
    const skill = join(root, 'skill', 'SKILL.md')
    await write(skill, '---\nname: stable\ndescription: stable\n---\nStable\n')
    const loader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
    })
    loader.configure({ skillPaths: [dirname(skill)], promptPaths: [] })
    await loader.reload()
    loader.configure({ skillPaths: [join(root, 'missing')], promptPaths: [] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    expect(loader.getSkills().skills.map(({ name }) => name)).toEqual(['stable'])
    expect(() =>
      loader.extendResources({
        skillPaths: [{ path: dirname(skill), metadata: { source: 'extension' } as never }],
      }),
    ).toThrowError('resource_extension_not_authorized')
    expect(() =>
      loader.extendResources({
        promptPaths: [{ path: skill, metadata: { source: 'extension' } as never }],
      }),
    ).toThrowError('resource_extension_not_authorized')
    expect(() =>
      loader.extendResources({
        themePaths: [{ path: skill, metadata: { source: 'extension' } as never }],
      }),
    ).toThrowError('resource_extension_not_authorized')
    expect(() => loader.extendResources({})).not.toThrow()
    expect(loader.getExtensions().extensions).toEqual([])
  })

  it('fails closed when an exact path changes shape or Pi reports invalid content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-loader-'))
    roots.push(root)
    const skillFile = join(root, 'skill-file')
    const promptDirectory = join(root, 'prompt-directory')
    const malformedSkill = join(root, 'malformed-skill')
    await write(skillFile, 'not a directory\n')
    await mkdir(promptDirectory, { recursive: true })
    await write(join(malformedSkill, 'SKILL.md'), '---\n: invalid yaml\n---\nBody\n')
    const loader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
    })

    loader.configure({ skillPaths: [skillFile], promptPaths: [] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    loader.configure({ skillPaths: [], promptPaths: [promptDirectory] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    loader.configure({ skillPaths: [malformedSkill], promptPaths: [] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
  })
})
