import type { ProjectSyncEntry } from '../../src/sync/types.js'

export const PROVIDER_CONTRACT_SCOPE = 'provider-contract'

export const EXPECTED_PROVIDER_HEADS = {
  initial: {
    schemaVersion: 1,
    scopeId: PROVIDER_CONTRACT_SCOPE,
    revisionId: '84a8875be90f5b10577743dce284a74562da22a6e44c36ac146394ebcb599b6c',
    manifestHash: 'ff073b2007ea6df41ef00dc37edd97e2120aaf3bad9dd981052914e2a9291196',
  },
  updated: {
    schemaVersion: 1,
    scopeId: PROVIDER_CONTRACT_SCOPE,
    revisionId: '55abf78f21d3b89291a017c90b534d331a862021895def03cdd35952a79fa015',
    manifestHash: '9cd1bddde013d56851f94ffd1318b148dd9a2ff6091d623d78c1b0b9931b32e3',
  },
  deleted: {
    schemaVersion: 1,
    scopeId: PROVIDER_CONTRACT_SCOPE,
    revisionId: '14c653138a445aebce950d80aaf5767138ad1b24e96e2308f013ae71b0ec2340',
    manifestHash: '329064cb30d21055cfaace51af4b0de31015bb294c33d8524e8685c3f3fa606a',
  },
} as const

export function projectSyncFixture(
  projectId: string,
  officeContent = 'office-content',
): ProjectSyncEntry[] {
  return [
    {
      canonicalPath: 'documents/report.docx',
      kind: 'office-document',
      bytes: new TextEncoder().encode(officeContent),
    },
    {
      canonicalPath: '.open-genoffice/project.json',
      kind: 'project-metadata',
      bytes: new TextEncoder().encode(JSON.stringify({ projectId })),
    },
    {
      canonicalPath: '.open-genoffice/resources/skill.md',
      kind: 'project-resource',
      bytes: new TextEncoder().encode('# Project Skill'),
      executable: true,
    },
    {
      canonicalPath: '.open-genoffice/sessions/document-a/session-a.jsonl',
      kind: 'pi-session-snapshot',
      bytes: new TextEncoder().encode('{"type":"session"}\n'),
    },
    {
      canonicalPath: '.open-genoffice/credentials/model-a.json',
      kind: 'credential-slot',
      credentialSlot: { slotId: 'model-a', providerId: 'openai-compatible' },
    },
  ]
}

export function tombstoneDocument(entries: ProjectSyncEntry[]): ProjectSyncEntry[] {
  return entries.map((entry) =>
    entry.canonicalPath === 'documents/report.docx'
      ? { canonicalPath: entry.canonicalPath, kind: entry.kind, tombstone: true }
      : entry,
  )
}
