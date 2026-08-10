/// <reference types="vite/client" />
import type { SlidesApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'
import type { AgentSessionPreloadApi } from '@genoffice/electron-utils/agent-session-preload'
import type { SlidesOfficeToolsApi } from '../shared/slides-office-tools'

declare global {
  interface Window {
    slidesApi: SlidesApi
    projectApi: ProjectApi
    agentSession: AgentSessionPreloadApi
    slidesOfficeTools: SlidesOfficeToolsApi
  }
}

export {}
