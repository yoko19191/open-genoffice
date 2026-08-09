import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const rootUrl = new URL('../../../', import.meta.url)

async function readJson(relativePath: string): Promise<any> {
  return JSON.parse(await readFile(new URL(relativePath, rootUrl), 'utf8'))
}

describe('G0 dependency pins', () => {
  it('pins the approved platform dependencies exactly in workspace manifests', async () => {
    const runtime = await readJson('apps/pi-agent-runtime/package.json')
    const projectStore = await readJson('packages/project-store/package.json')

    expect(runtime.dependencies).toMatchObject({
      '@earendil-works/pi-ai': '0.84.0',
      '@earendil-works/pi-agent-core': '0.84.0',
      '@earendil-works/pi-coding-agent': '0.84.0',
      '@earendil-works/pi-tui': '0.84.0',
      '@modelcontextprotocol/client': '2.0.0',
      '@agwab/pi-subagent': '0.4.8',
      fflate: '0.8.2',
    })
    expect(projectStore.dependencies).toEqual({
      '@aws-sdk/client-s3': '3.1106.0',
      webdav: '5.10.0',
    })
  })

  it('resolves one approved version of every platform dependency in the root lockfile', async () => {
    const lock = await readJson('package-lock.json')
    const expected = {
      '@earendil-works/pi-ai': '0.84.0',
      '@earendil-works/pi-agent-core': '0.84.0',
      '@earendil-works/pi-coding-agent': '0.84.0',
      '@earendil-works/pi-tui': '0.84.0',
      '@modelcontextprotocol/client': '2.0.0',
      '@agwab/pi-subagent': '0.4.8',
      webdav: '5.10.0',
      '@aws-sdk/client-s3': '3.1106.0',
      fflate: '0.8.2',
    }

    for (const [name, version] of Object.entries(expected)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version)
    }
  })
})
