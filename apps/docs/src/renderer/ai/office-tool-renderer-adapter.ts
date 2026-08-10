import { DOCS_OFFICE_TOOL_DEFINITIONS } from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import type {
  DocsOfficeContextSnapshot,
  DocsOfficeEditSnapshot,
  DocsOfficeImagePayload,
  DocsOfficeToolRequest,
  DocsOfficeToolResponse,
} from '../../shared/docs-office-tools'
import type { ToolExecution } from './tools'

export interface DocsOfficeToolRendererDependencies {
  contextVersion(): string
  advanceContextVersion(): string
  contextContent(): string
  contextDetails(): DocsOfficeContextSnapshot['details']
  captureSnapshot(): DocsOfficeEditSnapshot
  restoreSnapshot(snapshot: DocsOfficeEditSnapshot): void
  execute(
    modelAlias: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    image?: DocsOfficeImagePayload,
  ): Promise<ToolExecution>
}

export function createDocsOfficeToolRendererHandler(
  dependencies: DocsOfficeToolRendererDependencies,
): (request: DocsOfficeToolRequest) => Promise<DocsOfficeToolResponse> {
  const active = new Map<string, AbortController>()
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
      return {
        requestId: request.requestId,
        ok: true,
        result: { kind: 'snapshot', snapshot: dependencies.captureSnapshot() },
      }
    }
    if (request.kind === 'restore_snapshot') {
      dependencies.restoreSnapshot(request.snapshot)
      return {
        requestId: request.requestId,
        ok: true,
        result: { kind: 'restored', contextVersion: dependencies.advanceContextVersion() },
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

    const definition = DOCS_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === request.toolId)
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
    if (definition.modelAlias === 'insert_image' && !request.image) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'artifact_invalid',
        mutationOutcome: 'not_started',
      }
    }

    try {
      const controller = new AbortController()
      active.set(request.operationId, controller)
      const aborted = new Promise<ToolExecution>((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () =>
            resolve({
              output: 'Operation aborted',
              summary: definition.modelAlias,
              isError: true,
              mutated: false,
            }),
          { once: true },
        )
      })
      const executed = await Promise.race([
        dependencies.execute(
          definition.modelAlias,
          request.input as Record<string, unknown>,
          controller.signal,
          request.image,
        ),
        aborted,
      ])
      active.delete(request.operationId)
      if (executed.isError) {
        return {
          requestId: request.requestId,
          ok: false,
          errorCode: 'tool_failed',
          ...(definition.effect === 'mutation' ? { mutationOutcome: 'not_started' as const } : {}),
        }
      }
      const contextVersionAfter = executed.mutated
        ? dependencies.advanceContextVersion()
        : dependencies.contextVersion()
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          kind: 'executed',
          output: executed.output,
          details: { summary: executed.summary },
          contextVersionAfter,
          ...(executed.mutated ? { mutationOutcome: 'committed' as const } : {}),
        },
      }
    } catch {
      active.delete(request.operationId)
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'tool_failed',
        ...(definition.effect === 'mutation' ? { mutationOutcome: 'unknown' as const } : {}),
      }
    }
  }
}
