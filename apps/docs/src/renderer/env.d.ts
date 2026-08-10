/// <reference types="vite/client" />

import type { DesktopApi } from '../shared/ipc'
import type { DocsOfficeToolsApi } from '../shared/docs-office-tools'
import type { ProjectApi } from '@genoffice/project-store'
import type { AgentSessionPreloadApi } from '@genoffice/electron-utils'

declare global {
  interface Window {
    desktop: DesktopApi
    docsOfficeTools: DocsOfficeToolsApi
    agentSession: AgentSessionPreloadApi
    projectApi: ProjectApi
  }
}

export {}
