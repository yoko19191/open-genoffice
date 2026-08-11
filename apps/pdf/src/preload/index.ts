import { contextBridge, ipcRenderer } from 'electron'
import { createAgentSessionPreloadApi } from '@genoffice/electron-utils/agent-session-preload'
import type { Lang } from '@genoffice/i18n'
import { PDF_CHANNELS } from '../shared/ipc'
import {
  isPdfOfficeToolRequest,
  isPdfOfficeToolResponse,
  type PdfApi,
  type PdfOfficeToolsApi,
} from '../shared/ipc'

const api: PdfApi = {
  consumePending: () => ipcRenderer.invoke(PDF_CHANNELS.consumePending),
  readFile: (path) => ipcRenderer.invoke(PDF_CHANNELS.readFile, path),
  save: (request) => ipcRenderer.invoke(PDF_CHANNELS.save, request),
  extractPages: (request) => ipcRenderer.invoke(PDF_CHANNELS.extractPages, request),
  insertPdf: (request) => ipcRenderer.invoke(PDF_CHANNELS.insertPdf, request),
  exportImages: (request) => ipcRenderer.invoke(PDF_CHANNELS.exportImages, request),
  setDirty: (dirty) => ipcRenderer.send(PDF_CHANNELS.dirtyChanged, dirty),
  onCloseSaveRequest: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(PDF_CHANNELS.closeSaveRequest, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.closeSaveRequest, listener)
  },
  sendCloseSaveResult: (ok) => ipcRenderer.send(PDF_CHANNELS.closeSaveResult, ok),
  onSaveAsRequest: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, targetPath: string) => handler(targetPath)
    ipcRenderer.on(PDF_CHANNELS.saveAsRequest, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.saveAsRequest, listener)
  },
  sendSaveAsResult: (ok) => ipcRenderer.send(PDF_CHANNELS.saveAsResult, ok),
  onSaveAsFlow: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, inFlight: boolean) => handler(inFlight)
    ipcRenderer.on(PDF_CHANNELS.saveAsFlow, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.saveAsFlow, listener)
  },
  getLanguage: () => ipcRenderer.invoke(PDF_CHANNELS.getLanguage),
  onLanguageChanged: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, lang: Lang) => handler(lang)
    ipcRenderer.on(PDF_CHANNELS.languageChanged, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.languageChanged, listener)
  },
}

const officeTools: PdfOfficeToolsApi = {
  onRequest: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (!isPdfOfficeToolRequest(request)) return
      void Promise.resolve(handler(request))
        .then((response) => {
          ipcRenderer.send(
            PDF_CHANNELS.officeToolResponse,
            isPdfOfficeToolResponse(response)
              ? response
              : { requestId: request.requestId, ok: false, errorCode: 'tool_failed' },
          )
        })
        .catch(() => {
          ipcRenderer.send(PDF_CHANNELS.officeToolResponse, {
            requestId: request.requestId,
            ok: false,
            errorCode: 'tool_failed',
          })
        })
    }
    ipcRenderer.on(PDF_CHANNELS.officeToolRequest, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.officeToolRequest, listener)
  },
}

contextBridge.exposeInMainWorld('pdfApi', api)
contextBridge.exposeInMainWorld('pdfOfficeTools', officeTools)
contextBridge.exposeInMainWorld('agentSession', createAgentSessionPreloadApi(ipcRenderer))
