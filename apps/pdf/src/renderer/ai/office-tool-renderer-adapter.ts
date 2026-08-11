import { PDF_OFFICE_TOOL_DEFINITIONS } from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import type {
  PdfOfficeContextSnapshot,
  PdfOfficeEditSnapshot,
  PdfOfficeToolRequest,
  PdfOfficeToolResponse,
} from '../../shared/ipc'
import type { ToolExecution } from './tools'

type PdfOfficeContextDetails = PdfOfficeContextSnapshot['details']

export interface PdfOfficeToolRendererDependencies {
  contextVersion(): string
  advanceContextVersion(): string
  contextDetails(): PdfOfficeContextDetails
  captureSnapshot(): PdfOfficeEditSnapshot
  restoreSnapshot(snapshot: PdfOfficeEditSnapshot): void
  execute(
    modelAlias: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecution>
}

function contextSnapshot(
  documentId: string,
  version: string,
  details: PdfOfficeContextDetails,
): PdfOfficeContextSnapshot {
  return {
    documentId,
    contextVersion: version,
    modelContent: [
      `PDF: ${details.fileName}`,
      `Original pages: ${details.originalPageCount}`,
      `Current original page: ${details.currentOriginalPage}`,
      `Read only: ${details.readOnly ? 'yes' : 'no'}`,
      `Outline: ${details.hasOutline ? 'available' : 'none'}`,
    ].join('\n'),
    details,
  }
}

export function createPdfOfficeToolRendererHandler(
  dependencies: PdfOfficeToolRendererDependencies,
): (request: PdfOfficeToolRequest) => Promise<PdfOfficeToolResponse> {
  const active = new Map<string, AbortController>()
  return async (request) => {
    if (request.kind === 'context') {
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          kind: 'context',
          snapshot: contextSnapshot(
            request.documentId,
            dependencies.contextVersion(),
            dependencies.contextDetails(),
          ),
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

    const definition = PDF_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === request.toolId)
    if (!definition) {
      return { requestId: request.requestId, ok: false, errorCode: 'unsupported_office_feature' }
    }
    const freshnessRequired = definition.effect !== 'read'
    if (
      freshnessRequired &&
      (!request.contextVersion || request.contextVersion !== dependencies.contextVersion())
    ) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'stale_context',
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
              errorCode: 'tool_failed',
            }),
          { once: true },
        )
      })
      const executed = await Promise.race([
        dependencies.execute(
          definition.modelAlias,
          request.input as Record<string, unknown>,
          controller.signal,
        ),
        aborted,
      ])
      active.delete(request.operationId)
      if (executed.isError) {
        return {
          requestId: request.requestId,
          ok: false,
          errorCode: executed.errorCode ?? 'tool_failed',
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
