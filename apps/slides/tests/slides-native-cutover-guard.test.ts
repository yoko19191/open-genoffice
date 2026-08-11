import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(process.cwd(), '..', '..')

describe('Slides native executor pre-cutover boundary', () => {
  it('wires the dormant host without exposing the Pi catalog to the production Panel yet', async () => {
    const shell = await readFile(resolve(repoRoot, 'apps/shell/src/main/index.ts'), 'utf8')
    const resolver = shell.slice(
      shell.indexOf('resolveOfficeToolCatalog:'),
      shell.indexOf('resolveProjectRoot:'),
    )
    expect(shell).toContain('slidesOfficeToolHost.current.invoke(request)')
    expect(shell).toContain('slidesOfficeToolRendererClient(contents.id)')
    expect(resolver).not.toContain('SLIDES_OFFICE_TOOL_CATALOG_BINDING')

    const app = await readFile(resolve(repoRoot, 'apps/slides/src/renderer/App.tsx'), 'utf8')
    expect(app).toContain('<AiPanel')
    expect(app).toContain('createSlidesOfficeToolRendererHandler')
  })
})
