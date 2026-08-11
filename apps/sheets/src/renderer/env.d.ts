declare module '*.md?raw' {
  const content: string
  export default content
}

import type { DesktopApi } from '../shared/desktop-api'
import type { AgentSessionPreloadApi } from '@genoffice/electron-utils/agent-session-preload'
import type { SheetsOfficeToolsApi } from '../shared/sheets-office-tools'

declare global {
  interface Window {
    readonly desktopApi: DesktopApi
    readonly agentSession: AgentSessionPreloadApi
    readonly sheetsOfficeTools: SheetsOfficeToolsApi
  }
}

export {}
