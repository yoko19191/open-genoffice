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

describe('Shell Pi Agent Platform cutover', () => {
  it('keeps provider, MinerU, and update settings after removing the product account surface', async () => {
    const home = await source('src/renderer/src/Home.tsx')

    expect(home).toContain('Model provider')
    expect(home).toContain('PDF to Word')
    expect(home).toContain('getUpdateChannel')
    expect(home).toContain('setUpdateChannel')
    expect(home).toContain('Settings')
  })

  it('has no retired account, cloud project, legacy AI, or branded production path', async () => {
    const files = await productionSources(join(appRoot, 'src'))
    files.push(await source('package.json'), await source('electron-builder.cjs'))
    const production = files.join('\n')

    for (const forbidden of [
      'Genspark',
      'genspark',
      'gsk',
      '@genspark/cli',
      '@genoffice/agent-core',
      '@genoffice/ai-provider',
      '@genoffice/ai-search',
      'accountLogin',
      'accountLogout',
      'openGenTeam',
      'CloudProjects',
      'cloudProjects',
      'registerLegacyAiIpc',
    ]) {
      expect(production, forbidden).not.toContain(forbidden)
    }

    await expect(access(join(appRoot, 'src/main/cloud-projects.ts'))).rejects.toThrow()
  })
})
