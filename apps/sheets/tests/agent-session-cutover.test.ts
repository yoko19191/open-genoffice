import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = join(import.meta.dirname, '..')

async function source(path: string): Promise<string> {
  return readFile(join(appRoot, path), 'utf8')
}

async function productionSources(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolute = join(path, entry.name)
    if (entry.isDirectory()) files.push(...(await productionSources(absolute)))
    else if (/\.(?:ts|tsx|css)$/.test(entry.name)) files.push(await readFile(absolute, 'utf8'))
  }
  return files
}

describe('Sheets Agent Session cutover', () => {
  it('uses the shared Session controller, built-in Skill, and narrow Office Tool bridge', async () => {
    const [panel, preload, rendererTypes, app, host, runtime] = await Promise.all([
      source('src/renderer/ai/AiPanel.tsx'),
      source('src/preload/index.ts'),
      source('src/renderer/env.d.ts'),
      source('src/renderer/App.tsx'),
      source('src/main/agent-tools/sheets-office-tool-host.ts'),
      readFile(join(appRoot, '../pi-agent-runtime/src/authenticated-server.ts'), 'utf8'),
    ])
    expect(panel).toContain('new AgentSessionController(window.agentSession)')
    expect(panel).toContain('controller.rollbackLastRun()')
    expect(preload).toContain("contextBridge.exposeInMainWorld('agentSession'")
    expect(preload).toContain("contextBridge.exposeInMainWorld('sheetsOfficeTools'")
    expect(rendererTypes).toContain('agentSession: AgentSessionPreloadApi')
    expect(rendererTypes).toContain('sheetsOfficeTools: SheetsOfficeToolsApi')
    expect(app).toContain('createSheetsOfficeToolRendererHandler')
    expect(host).toContain('openImage')
    expect(host).not.toMatch(/https?:\/\/|filePath|base64/i)
    expect(runtime).toContain("resourceId: 'open-genoffice/sheets-workbook'")
  })

  it('has no legacy Agent, provider, duplicate files/search IPC, guide executor, or brand path', async () => {
    const files = await productionSources(join(appRoot, 'src'))
    files.push(await source('package.json'))
    const production = files.join('\n')
    for (const forbidden of [
      'AgentLoop',
      'AgentTransport',
      'AiSettings',
      'ai:get-settings',
      'ai:stream',
      'ai:gsk',
      '@genoffice/agent-core',
      '@genoffice/ai-provider',
      '@genoffice/ai-search',
      '@genoffice/file-parse',
      'load_guide',
      'sheets:files-',
      'Genspark',
      'genspark',
    ]) {
      expect(production, forbidden).not.toContain(forbidden)
    }
    for (const retired of [
      'src/renderer/ai/workbook-skill.ts',
      'src/renderer/ai/files-skill.ts',
      'src/renderer/ai/search-skill.ts',
      'src/renderer/ai/transport.ts',
      'src/renderer/ai/guides.ts',
      'src/renderer/ai/AiChatPanel.tsx',
    ]) {
      await expect(access(join(appRoot, retired))).rejects.toThrow()
    }
  })
})
