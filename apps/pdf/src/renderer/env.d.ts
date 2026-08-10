/// <reference types="vite/client" />

import type { PdfApi, PdfOfficeToolsApi } from '../shared/ipc'
import type { AgentSessionPreloadApi } from '@genoffice/electron-utils/agent-session-preload'

declare global {
  interface Window {
    pdfApi: PdfApi
    pdfOfficeTools: PdfOfficeToolsApi
    agentSession: AgentSessionPreloadApi
  }
}

export {}
