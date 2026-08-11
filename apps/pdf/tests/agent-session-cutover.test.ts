import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = join(import.meta.dirname, '..')

async function source(path: string): Promise<string> {
  return readFile(join(appRoot, path), 'utf8')
}

describe('PDF Agent Session cutover', () => {
  it('uses only the shared Agent Session controller and narrow preload bridge', async () => {
    const [panel, preload, rendererTypes] = await Promise.all([
      source('src/renderer/ai/AiPanel.tsx'),
      source('src/preload/index.ts'),
      source('src/renderer/env.d.ts'),
    ])

    expect(panel).toContain('new AgentSessionController(window.agentSession)')
    expect(panel).toContain('controller.connect()')
    expect(panel).toContain('controller.prompt(instruction)')
    expect(panel).toContain('controller.abort()')
    expect(panel).toContain('data-testid="subagent-run-tree"')
    expect(panel).toContain('controller.resumeSubagent(runId)')
    expect(panel).toContain('data-testid="mutation-grant-list"')
    expect(panel).toContain('controller.grantMutation(id)')
    expect(panel).toContain('controller.denyMutation(id)')
    expect(panel).toContain('controller.revokeMutation(id)')
    expect(preload).toContain("contextBridge.exposeInMainWorld('agentSession'")
    expect(rendererTypes).toContain('agentSession: AgentSessionPreloadApi')
  })

  it('has no legacy model settings, stream transport, or branded provider path', async () => {
    const files = await Promise.all(
      [
        'package.json',
        'src/preload/index.ts',
        'src/shared/ipc.ts',
        'src/renderer/App.tsx',
        'src/renderer/ai/AiPanel.tsx',
        'src/renderer/i18n/strings.ts',
      ].map(source),
    )
    const production = files.join('\n')

    for (const forbidden of [
      'AgentLoop',
      'AgentTransport',
      'AiSettings',
      'ai:get-settings',
      'ai:stream',
      '@genoffice/agent-core',
      '@genoffice/ai-provider',
      'Genspark',
      'genspark',
    ]) {
      expect(production).not.toContain(forbidden)
    }
  })
})
