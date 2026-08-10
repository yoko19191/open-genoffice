import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { DesktopApi, MenuCommand } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'
import { createAgentSessionPreloadApi } from '@genoffice/electron-utils/agent-session-preload'
import {
  DOCS_OFFICE_TOOL_CHANNELS,
  isDocsOfficeToolRequest,
  isDocsOfficeToolResponse,
  type DocsOfficeToolsApi,
} from '../shared/docs-office-tools'

const api: DesktopApi = {
  getLanguage: () => ipcRenderer.invoke('app:get-language'),
  onLanguageChanged: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      lang: 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar',
    ) => handler(lang)
    ipcRenderer.on('app:language-changed', listener)
    return () => ipcRenderer.removeListener('app:language-changed', listener)
  },
  openDocx: () => ipcRenderer.invoke('docs:open'),
  openDocxPath: (path: string) => ipcRenderer.invoke('docs:open-path', path),
  consumePendingOpenDocx: () => ipcRenderer.invoke('docs:consume-pending-open'),
  consumeNewBlankDoc: () => ipcRenderer.invoke('docs:consume-new-blank'),
  onOpenDocx: (handler) => {
    const listener = (_event: IpcRendererEvent, result: Parameters<typeof handler>[0]) =>
      handler(result)
    ipcRenderer.on('docs:opened', listener)
    return () => ipcRenderer.removeListener('docs:opened', listener)
  },
  onRenamedDocx: (handler) => {
    const listener = (_event: IpcRendererEvent, paths: Parameters<typeof handler>[0]) =>
      handler(paths)
    ipcRenderer.on('docs:renamed', listener)
    return () => ipcRenderer.removeListener('docs:renamed', listener)
  },
  saveDocx: (path: string, data: ArrayBuffer, auto?: boolean) =>
    ipcRenderer.invoke('docs:save', path, data, auto === true),
  writeRecoveryCopy: (path: string, data: ArrayBuffer) =>
    ipcRenderer.invoke('docs:write-recovery', path, data),
  onTeardown: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('docs:teardown', listener)
    return () => ipcRenderer.removeListener('docs:teardown', listener)
  },
  saveDocxAs: (defaultName: string, data: ArrayBuffer) =>
    ipcRenderer.invoke('docs:save-as', defaultName, data),
  saveDocxNew: (defaultName: string, data: ArrayBuffer) =>
    ipcRenderer.invoke('docs:save-new', defaultName, data),
  getRecentFiles: () => ipcRenderer.invoke('docs:recent'),
  pickImage: () => ipcRenderer.invoke('docs:pick-image'),
  print: () => ipcRenderer.invoke('docs:print'),
  exportPdf: (
    defaultName: string,
    pageWidthTwips: number,
    pageHeightTwips: number,
    outPath?: string,
  ) => ipcRenderer.invoke('docs:export-pdf', defaultName, pageWidthTwips, pageHeightTwips, outPath),
  printPdfBuffer: (pageWidthTwips: number, pageHeightTwips: number) =>
    ipcRenderer.invoke('docs:print-pdf-buffer', pageWidthTwips, pageHeightTwips),
  saveMergedPdf: (defaultName: string, base64Parts: string[], outPath?: string) =>
    ipcRenderer.invoke('docs:save-merged-pdf', defaultName, base64Parts, outPath),
  openNewTab: (openPath?: string | null) => ipcRenderer.invoke('win:new', openPath ?? null),
  listDocsTabs: () => ipcRenderer.invoke('win:list'),
  focusDocsTab: (id: string) => ipcRenderer.invoke('win:focus', id),
  onMenuCommand: (handler: (command: MenuCommand, payload?: string) => void) => {
    const listener = (_event: IpcRendererEvent, command: MenuCommand, payload?: string) =>
      handler(command, payload)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  },
  onCloseCheck: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('docs:close-check', listener)
    return () => ipcRenderer.removeListener('docs:close-check', listener)
  },
  reportCloseCheck: (state: { dirty: boolean; autoSave: boolean; filePath?: string | null }) =>
    ipcRenderer.send('docs:close-check-result', {
      dirty: state?.dirty === true,
      autoSave: state?.autoSave === true,
      filePath: typeof state?.filePath === 'string' ? state.filePath : null,
    }),
  onCloseSaveRequest: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('docs:close-save-request', listener)
    return () => ipcRenderer.removeListener('docs:close-save-request', listener)
  },
  reportCloseSaveResult: (ok: boolean) => ipcRenderer.send('docs:close-save-result', ok === true),
}

const projectApi: ProjectApi = {
  resolveChat: (args) => ipcRenderer.invoke('project:resolveChat', args),
  appendChat: (args) => ipcRenderer.invoke('project:appendChat', args),
  loadChat: (args) => ipcRenderer.invoke('project:loadChat', args),
  rebindChat: (args) => ipcRenderer.invoke('project:rebindChat', args),
  // P1 extensions
  listProjects: () => ipcRenderer.invoke('project:list'),
  createProject: (args) => ipcRenderer.invoke('project:create', args),
  renameProject: (args) => ipcRenderer.invoke('project:rename', args),
  deleteProject: (args) => ipcRenderer.invoke('project:delete', args),
  moveFile: (args) => ipcRenderer.invoke('project:moveFile', args),
  getTimeline: (args) => ipcRenderer.invoke('project:timeline', args),
}

const officeTools: DocsOfficeToolsApi = {
  onRequest: (handler) => {
    const listener = (_event: IpcRendererEvent, request: unknown) => {
      if (!isDocsOfficeToolRequest(request)) return
      void Promise.resolve(handler(request))
        .then((response) => {
          ipcRenderer.send(
            DOCS_OFFICE_TOOL_CHANNELS.response,
            isDocsOfficeToolResponse(response)
              ? response
              : { requestId: request.requestId, ok: false, errorCode: 'tool_failed' },
          )
        })
        .catch(() => {
          ipcRenderer.send(DOCS_OFFICE_TOOL_CHANNELS.response, {
            requestId: request.requestId,
            ok: false,
            errorCode: 'tool_failed',
          })
        })
    }
    ipcRenderer.on(DOCS_OFFICE_TOOL_CHANNELS.request, listener)
    return () => ipcRenderer.removeListener(DOCS_OFFICE_TOOL_CHANNELS.request, listener)
  },
}

contextBridge.exposeInMainWorld('desktop', api)
contextBridge.exposeInMainWorld('projectApi', projectApi)
contextBridge.exposeInMainWorld('docsOfficeTools', officeTools)
contextBridge.exposeInMainWorld('agentSession', createAgentSessionPreloadApi(ipcRenderer))
