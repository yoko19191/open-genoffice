import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MutationGrantRegistry,
  MutationGrantRegistryError,
  type MutationGrantRun,
} from '../src/mutation-grant-registry'

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const documentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const runId = 'subagent-run-1'
const parentRunId = 'parent-run-1'
const writeTool = 'office:docs:insert_content'
const otherWriteTool = 'office:docs:replace_blocks'

describe('MutationGrantRegistry', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function harness() {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'genoffice-mutation-grant-'))
    roots.push(rootDirectory)
    let now = new Date('2026-08-10T00:00:00.000Z')
    let run: MutationGrantRun = {
      runId,
      parentRunId,
      parentSessionId: sessionId,
      documentId,
      role: 'Reviewer',
      status: 'running',
      grantableToolIds: [writeTool, otherWriteTool],
    }
    let uuid = 0
    const registry = new MutationGrantRegistry({
      rootDirectory,
      now: () => now,
      randomUUID: vi.fn(() => `request-${++uuid}`),
      inspectRun: (candidate) => (candidate === run.runId ? structuredClone(run) : undefined),
      resolveEffect: (toolId) =>
        toolId === writeTool || toolId === otherWriteTool ? 'mutation' : undefined,
    })
    await registry.initialize()
    return {
      registry,
      rootDirectory,
      advance(milliseconds: number) {
        now = new Date(now.getTime() + milliseconds)
      },
      updateRun(next: Partial<MutationGrantRun>) {
        run = { ...run, ...next }
      },
    }
  }

  function activeReceipt(toolId = writeTool) {
    return {
      grantId: 'grant-1',
      subagentRunId: runId,
      documentId,
      exactToolIds: [toolId],
      issuedByUserActionId: 'user-action-1',
      issuedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'active' as const,
    }
  }

  it('requires an active bound Subagent and exact grantable Office mutation tools', async () => {
    const fixture = await harness()
    await expect(
      fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: [writeTool],
      }),
    ).resolves.toMatchObject({
      requestId: 'request-1',
      subagentRunId: runId,
      role: 'Reviewer',
      exactToolIds: [writeTool],
      status: 'pending',
    })

    await expect(
      fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: ['office:docs:*'],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_tool_invalid'))
    await expect(
      fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        exactToolIds: [writeTool],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_binding_invalid'))
    fixture.updateRun({ status: 'completed' })
    await expect(
      fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: [writeTool],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_run_terminal'))
  })

  it('consumes an exact Electron-main receipt and rejects scope expansion or forged timing', async () => {
    const fixture = await harness()
    const request = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
    })
    const receipt = activeReceipt()
    await expect(fixture.registry.issue(request.requestId, receipt)).resolves.toMatchObject({
      grantId: 'grant-1',
      status: 'active',
    })
    await expect(fixture.registry.issue(request.requestId, receipt)).resolves.toMatchObject({
      grantId: 'grant-1',
    })

    const second = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
    })
    await expect(
      fixture.registry.issue(second.requestId, {
        ...receipt,
        grantId: 'grant-expanded',
        exactToolIds: [writeTool, otherWriteTool],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_receipt_invalid'))
    await expect(
      fixture.registry.issue(second.requestId, {
        ...receipt,
        grantId: 'grant-too-long',
        expiresAt: '2026-08-10T01:00:00.000Z',
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_receipt_invalid'))
  })

  it('fails closed for uninitialized, malformed, non-file and duplicate persisted state', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'genoffice-mutation-invalid-'))
    roots.push(rootDirectory)
    const options = {
      rootDirectory,
      inspectRun: () => undefined,
      resolveEffect: () => undefined,
    }
    const uninitialized = new MutationGrantRegistry(options)
    await expect(
      uninitialized.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: [writeTool],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_state_invalid'))

    const statePath = join(rootDirectory, 'state', 'mutation-grants.json')
    await mkdir(join(rootDirectory, 'state'), { recursive: true })
    await writeFile(statePath, '{bad json')
    await expect(new MutationGrantRegistry(options).initialize()).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_state_invalid'),
    )
    await writeFile(statePath, '{}')
    await expect(new MutationGrantRegistry(options).initialize()).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_state_invalid'),
    )
    await rm(statePath)
    await mkdir(statePath)
    await expect(new MutationGrantRegistry(options).initialize()).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_state_invalid'),
    )

    const fixture = await harness()
    const requested = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
    })
    await fixture.registry.initialize()
    const persistedPath = join(fixture.rootDirectory, 'state', 'mutation-grants.json')
    const persisted = JSON.parse(await readFile(persistedPath, 'utf8'))
    persisted.records.push(structuredClone(persisted.records[0]))
    await writeFile(persistedPath, JSON.stringify(persisted))
    const duplicate = new MutationGrantRegistry({
      ...options,
      rootDirectory: fixture.rootDirectory,
      inspectRun: () => ({
        runId,
        parentRunId,
        parentSessionId: sessionId,
        documentId,
        role: 'Reviewer',
        status: 'running',
        grantableToolIds: [writeTool],
      }),
    })
    await expect(duplicate.initialize()).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_state_invalid'),
    )
    expect(requested.requestId).toBe('request-1')
  })

  it('denies requests, expires pending requests, emits safely and rejects duplicate or unsafe tools', async () => {
    const fixture = await harness()
    const events: unknown[] = []
    const stop = fixture.registry.onEvent((event) => events.push(event))
    await expect(
      fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: [],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_tool_invalid'))
    await expect(
      fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: [writeTool, writeTool],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_tool_invalid'))
    await expect(
      fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: ['office:docs:read_blocks'],
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_tool_invalid'))

    const denied = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
    })
    await expect(
      fixture.registry.deny(denied.requestId, 'user-action-deny'),
    ).resolves.toMatchObject({
      status: 'denied',
    })
    await expect(fixture.registry.issue(denied.requestId, activeReceipt())).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_receipt_invalid'),
    )
    await expect(fixture.registry.deny(denied.requestId, 'again')).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_denied'),
    )
    const expiring = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [otherWriteTool],
    })
    fixture.advance(5 * 60 * 1_000 + 1)
    expect(fixture.registry.listForSession(sessionId)).toContainEqual(
      expect.objectContaining({ requestId: expiring.requestId, status: 'expired' }),
    )
    stop()
    await fixture.registry.revokeForDocument(documentId, 'no-active-records')
    expect(events).toHaveLength(4)
  })

  it('rejects every forged receipt field and revokes an active grant when the run terminates', async () => {
    const invalidReceipts = [
      { grantId: '' },
      { issuedByUserActionId: '' },
      { subagentRunId: 'other-run' },
      { documentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      { exactToolIds: [otherWriteTool] },
      { issuedAt: 'invalid' },
      { expiresAt: 'invalid' },
      { issuedAt: '2026-08-09T23:59:59.000Z' },
      { issuedAt: '2026-08-10T00:00:06.000Z' },
      { expiresAt: '2026-08-09T23:59:59.000Z' },
      { expiresAt: '2026-08-10T00:11:00.000Z' },
    ]
    for (const [index, override] of invalidReceipts.entries()) {
      const fixture = await harness()
      const request = await fixture.registry.request({
        parentSessionId: sessionId,
        subagentRunId: runId,
        documentId,
        exactToolIds: [writeTool],
      })
      await expect(
        fixture.registry.issue(request.requestId, { ...activeReceipt(), ...override }),
      ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_receipt_invalid'))
      expect(index).toBeGreaterThanOrEqual(0)
    }

    const fixture = await harness()
    await expect(fixture.registry.issue('missing', activeReceipt())).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_not_found'),
    )
    const request = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
    })
    await fixture.registry.issue(request.requestId, activeReceipt())
    fixture.updateRun({ status: 'completed' })
    await expect(
      fixture.registry.authorize({
        grantId: 'grant-1',
        subagentRunId: runId,
        documentId,
        toolId: writeTool,
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_denied'))
    expect(fixture.registry.listForSession(sessionId)).toContainEqual(
      expect.objectContaining({ grantId: 'grant-1', status: 'revoked' }),
    )
    await expect(fixture.registry.revoke('grant-1', 'user-action-2')).rejects.toEqual(
      new MutationGrantRegistryError('mutation_grant_denied'),
    )
  })

  it('authorizes only the exact run, document and tool then expires and revokes immediately', async () => {
    const fixture = await harness()
    const request = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
    })
    await fixture.registry.issue(request.requestId, {
      grantId: 'grant-1',
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
      issuedByUserActionId: 'user-action-1',
      issuedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'active',
    })

    await expect(
      fixture.registry.authorize({
        grantId: 'grant-1',
        subagentRunId: runId,
        documentId,
        toolId: writeTool,
      }),
    ).resolves.toMatchObject({ issuedByUserActionId: 'user-action-1' })
    await expect(
      fixture.registry.authorize({
        grantId: 'grant-1',
        subagentRunId: 'other-run',
        documentId,
        toolId: writeTool,
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_denied'))
    await expect(
      fixture.registry.authorize({
        grantId: 'grant-1',
        subagentRunId: runId,
        documentId,
        toolId: otherWriteTool,
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_denied'))

    await fixture.registry.revoke('grant-1', 'user-action-2')
    await expect(
      fixture.registry.authorize({
        grantId: 'grant-1',
        subagentRunId: runId,
        documentId,
        toolId: writeTool,
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_denied'))

    const expiring = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [otherWriteTool],
    })
    await fixture.registry.issue(expiring.requestId, {
      grantId: 'grant-expiring',
      subagentRunId: runId,
      documentId,
      exactToolIds: [otherWriteTool],
      issuedByUserActionId: 'user-action-3',
      issuedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:00:01.000Z',
      status: 'active',
    })
    fixture.advance(1_001)
    await expect(
      fixture.registry.authorize({
        grantId: 'grant-expiring',
        subagentRunId: runId,
        documentId,
        toolId: otherWriteTool,
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_denied'))
    expect(
      fixture.registry.listForSession(sessionId).find((item) => item.grantId === 'grant-expiring'),
    ).toMatchObject({ status: 'expired' })
  })

  it('revokes grants on child, parent or document terminal and persists the narrowed state', async () => {
    const fixture = await harness()
    const request = await fixture.registry.request({
      parentSessionId: sessionId,
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
    })
    await fixture.registry.issue(request.requestId, {
      grantId: 'grant-1',
      subagentRunId: runId,
      documentId,
      exactToolIds: [writeTool],
      issuedByUserActionId: 'user-action-1',
      issuedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'active',
    })
    await fixture.registry.revokeForParentRun(parentRunId, 'parent_terminal')
    expect(fixture.registry.listForSession(sessionId)).toContainEqual(
      expect.objectContaining({ grantId: 'grant-1', status: 'revoked' }),
    )

    const reopened = new MutationGrantRegistry({
      rootDirectory: fixture.rootDirectory,
      now: () => new Date('2026-08-10T00:00:02.000Z'),
      inspectRun: (candidate) =>
        candidate === runId
          ? {
              runId,
              parentRunId,
              parentSessionId: sessionId,
              documentId,
              role: 'Reviewer',
              status: 'running',
              grantableToolIds: [writeTool],
            }
          : undefined,
      resolveEffect: () => 'mutation',
    })
    await reopened.initialize()
    await expect(
      reopened.authorize({
        grantId: 'grant-1',
        subagentRunId: runId,
        documentId,
        toolId: writeTool,
      }),
    ).rejects.toEqual(new MutationGrantRegistryError('mutation_grant_denied'))
    await reopened.revokeForDocument(documentId, 'document_closed')
    await reopened.revokeForRun(runId, 'subagent_terminal')
  })
})
