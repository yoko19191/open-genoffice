/// <reference types="vite/client" />
import type { SlidesApi } from '../shared/ipc'
import type { AgentSessionPreloadApi } from '@genoffice/electron-utils/agent-session-preload'
import type { SlidesOfficeToolsApi } from '../shared/slides-office-tools'
import type { SlidesAgentMediaApi } from '../shared/agent-media-artifacts'

declare global {
  interface Window {
    slidesApi: SlidesApi
    agentSession: AgentSessionPreloadApi
    slidesOfficeTools: SlidesOfficeToolsApi
    agentMediaArtifacts: SlidesAgentMediaApi
  }
}

export {}
