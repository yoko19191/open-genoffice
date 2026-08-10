import { SLIDES_OFFICE_TOOL_DEFINITIONS } from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import type {
  SlidesOfficeContextSnapshot,
  SlidesOfficeImagePayload,
  SlidesOfficeToolRequest,
  SlidesOfficeToolResponse,
} from '../../shared/slides-office-tools'
import type { SlidesNativeArtifactImage, SlidesNativeToolResult } from './slides-skill'

export interface SlidesOfficeToolRendererDependencies {
  contextVersion(): string
  advanceContextVersion(): string
  contextContent(): string
  contextDetails(): SlidesOfficeContextSnapshot['details']
  beginHistoryBatch(): Promise<boolean>
  endHistoryBatch(): Promise<number | null>
  restoreHistorySnapshot(snapshotId: number): Promise<boolean>
  execute(
    modelAlias: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    artifacts: ReadonlyMap<string, SlidesNativeArtifactImage>,
  ): Promise<SlidesNativeToolResult>
  randomUUID?(): string
}

type SnapshotState = {
  expectedContextVersion: string
  firstCommittedSnapshotId?: number
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function artifactImages(
  images: readonly SlidesOfficeImagePayload[] | undefined,
): ReadonlyMap<string, SlidesNativeArtifactImage> {
  return new Map(
    (images ?? []).map((image) => [
      image.artifactId,
      {
        base64: base64(image.bytes),
        ext: 'png' as const,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
      },
    ]),
  )
}

export function createSlidesOfficeToolRendererHandler(
  dependencies: SlidesOfficeToolRendererDependencies,
): (request: SlidesOfficeToolRequest) => Promise<SlidesOfficeToolResponse> {
  const active = new Map<string, AbortController>()
  const snapshots = new Map<string, SnapshotState>()
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID())

  return async (request) => {
    if (request.kind === 'context') {
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId: request.documentId,
            contextVersion: dependencies.contextVersion(),
            modelContent: dependencies.contextContent(),
            details: dependencies.contextDetails(),
          },
        },
      }
    }
    if (request.kind === 'capture_snapshot') {
      const token = randomUUID()
      snapshots.set(token, { expectedContextVersion: dependencies.contextVersion() })
      return {
        requestId: request.requestId,
        ok: true,
        result: { kind: 'snapshot', snapshot: { token } },
      }
    }
    if (request.kind === 'restore_snapshot') {
      const snapshot = snapshots.get(request.snapshot.token)
      if (!snapshot || snapshot.firstCommittedSnapshotId === undefined) {
        return { requestId: request.requestId, ok: false, errorCode: 'executor_unavailable' }
      }
      if (snapshot.expectedContextVersion !== dependencies.contextVersion()) {
        return { requestId: request.requestId, ok: false, errorCode: 'stale_context' }
      }
      try {
        if (!(await dependencies.restoreHistorySnapshot(snapshot.firstCommittedSnapshotId))) {
          return { requestId: request.requestId, ok: false, errorCode: 'tool_failed' }
        }
        snapshots.delete(request.snapshot.token)
        return {
          requestId: request.requestId,
          ok: true,
          result: { kind: 'restored', contextVersion: dependencies.advanceContextVersion() },
        }
      } catch {
        return { requestId: request.requestId, ok: false, errorCode: 'tool_failed' }
      }
    }
    if (request.kind === 'abort') {
      const controller = active.get(request.operationId)
      controller?.abort()
      return {
        requestId: request.requestId,
        ok: true,
        result: { kind: 'aborted', aborted: controller !== undefined },
      }
    }

    const definition = SLIDES_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === request.toolId)
    if (!definition) {
      return { requestId: request.requestId, ok: false, errorCode: 'unsupported_office_feature' }
    }
    if (
      definition.effect === 'mutation' &&
      (!request.contextVersion || request.contextVersion !== dependencies.contextVersion())
    ) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      }
    }
    const snapshot = request.snapshot ? snapshots.get(request.snapshot.token) : undefined
    if (definition.effect === 'mutation' && !snapshot) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'executor_unavailable',
        mutationOutcome: 'not_started',
      }
    }
    if (snapshot && snapshot.expectedContextVersion !== dependencies.contextVersion()) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      }
    }

    const controller = new AbortController()
    active.set(request.operationId, controller)
    let batchOpened = false
    let mutationStarted = false
    try {
      if (definition.effect === 'mutation') {
        batchOpened = await dependencies.beginHistoryBatch()
        if (!batchOpened) throw new Error('executor_unavailable')
        mutationStarted = true
      }
      const executed = await dependencies.execute(
        definition.modelAlias,
        request.input as Record<string, unknown>,
        controller.signal,
        artifactImages(request.images),
      )
      const historySnapshotId = batchOpened ? await dependencies.endHistoryBatch() : null
      batchOpened = false
      if (executed.isError) {
        if (historySnapshotId !== null && snapshot) {
          snapshot.firstCommittedSnapshotId ??= historySnapshotId
          snapshot.expectedContextVersion = dependencies.contextVersion()
        }
        return {
          requestId: request.requestId,
          ok: false,
          errorCode: 'tool_failed',
          ...(definition.effect === 'mutation'
            ? {
                mutationOutcome:
                  historySnapshotId === null ? ('not_started' as const) : ('unknown' as const),
              }
            : {}),
        }
      }
      const contextVersionAfter = executed.mutated
        ? dependencies.advanceContextVersion()
        : dependencies.contextVersion()
      if (executed.mutated && snapshot) {
        if (historySnapshotId === null) throw new Error('executor_unavailable')
        snapshot.firstCommittedSnapshotId ??= historySnapshotId
        snapshot.expectedContextVersion = contextVersionAfter
      }
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          kind: 'executed',
          output: executed.output,
          details: {
            summary: executed.summary,
            ...(executed.auditIssues ? { auditIssues: executed.auditIssues } : {}),
          },
          contextVersionAfter,
          ...(executed.mutated ? { mutationOutcome: 'committed' as const } : {}),
        },
      }
    } catch {
      let failedSnapshotId: number | null = null
      if (batchOpened) {
        try {
          failedSnapshotId = await dependencies.endHistoryBatch()
        } catch {
          // The main process settles any stale nested batch before the next history action.
        }
      }
      if (failedSnapshotId !== null && snapshot) {
        snapshot.firstCommittedSnapshotId ??= failedSnapshotId
        snapshot.expectedContextVersion = dependencies.contextVersion()
      }
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'tool_failed',
        ...(definition.effect === 'mutation'
          ? {
              mutationOutcome:
                mutationStarted || failedSnapshotId !== null
                  ? ('unknown' as const)
                  : ('not_started' as const),
            }
          : {}),
      }
    } finally {
      active.delete(request.operationId)
    }
  }
}
