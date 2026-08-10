import {
  buildSlidesNativeContext,
  executeSlidesNativeTool,
  type DeckAccess,
  type SlidesNativeToolCall,
  type SlidesNativeToolResult,
} from '../../src/renderer/ai/slides-native-tools'

export type { DeckAccess }

export function createSlidesSkill(access: DeckAccess): {
  buildContext(): string
  executeTool(call: SlidesNativeToolCall): Promise<SlidesNativeToolResult>
} {
  return {
    buildContext: () => buildSlidesNativeContext(access),
    executeTool: (call) => executeSlidesNativeTool(access, call, new AbortController().signal),
  }
}
