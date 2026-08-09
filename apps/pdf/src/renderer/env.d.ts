/// <reference types="vite/client" />

import type { PdfApi } from '../shared/ipc'
import type { AgentSessionPreloadApi } from '@genoffice/electron-utils/agent-session-preload'

declare global {
  interface Window {
    pdfApi: PdfApi
    agentSession: AgentSessionPreloadApi
  }
}

export {}
