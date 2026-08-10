import { basename } from 'node:path'
import { BrowserWindow } from 'electron'
import type { Rectangle, WebContents, WebContentsView } from 'electron'

import {
  createDocsView,
  docsQueryDirty,
  markDocsNewBlank,
  requestDocsClose,
  setActiveDocsResolver,
  teardownDocsRenderer,
} from '../../../docs/src/main/docs-main'
import { createPdfView, pdfIsDirty, requestPdfClose } from '../../../pdf/src/main/pdf-main'
import {
  createSheetsView,
  requestSheetsClose,
  setActiveSheetsWebContents,
  setSheetsNewBlank,
  sheetsPendingEditCount,
} from '../../../sheets/src/main/sheets-main'
import {
  createSlidesView,
  requestSlidesClose,
  setActiveSlidesWebContents,
  slidesIsDirty,
} from '../../../slides/src/main/slides-main'
import type { TabKind, TabSummary } from '../shared/tabs-api'

interface TabRecord {
  id: string
  kind: TabKind
  /** null for the Home tab — it's rendered by the shell window's own webContents */
  view: WebContentsView | null
  title: string
  filePath?: string
  agentDocument?: Promise<AgentDocumentBinding>
}

type AgentDocumentBinding = { documentId: string }

export type TabDocumentBindingService = {
  open(kind: Exclude<TabKind, 'home'>, filePath?: string): Promise<AgentDocumentBinding>
  bindPath(documentId: string, filePath: string): Promise<AgentDocumentBinding>
}

/** must match the tab strip's rendered height (apps/shell/src/renderer/src/TabBar.tsx) */
const TAB_STRIP_HEIGHT = 40
const HOME_ID = 'home'

/**
 * Owns every open tab (Home + docs + sheets) inside the shell's single
 * BrowserWindow. Docs/sheets tabs are WebContentsView children of that
 * window; only the active one is visible at a time. Home has no view of its
 * own — hiding every other tab reveals the shell window's own content.
 */
export class TabManager {
  private readonly tabs: TabRecord[] = [
    { id: HOME_ID, kind: 'home', view: null, title: 'GenOffice' },
  ]
  private activeId: string = HOME_ID
  private nextId = 1
  /** tab whose page entered HTML fullscreen (e.g. slides slideshow) — its view covers the tab strip */
  private htmlFullScreenId: string | null = null
  private comparison: { leftId: string; rightId: string } | undefined
  /** tabs mid unsaved-changes prompt, so a second close click doesn't stack dialogs */
  private readonly closingIds = new Set<string>()
  private readonly agentDocumentOwners = new Map<string, number>()

  constructor(
    private readonly shellWindow: BrowserWindow,
    private readonly onChanged: () => void,
    private readonly applyMenuFor: (kind: TabKind) => void,
    /** localized placeholder title for a tab that has no file yet */
    private readonly untitledTitleFor?: (kind: TabKind) => string,
    private readonly onRendererClosed?: (webContentsId: number) => void,
    private readonly agentDocuments?: TabDocumentBindingService,
  ) {
    // Layout once synchronously for macOS/Windows (bounds are already correct),
    // then once more on the next tick. On Linux/X11, `resize` fires before the
    // window manager applies the new size, so getContentBounds() is still the
    // pre-maximize size inside the handler and a follow-up layout is required.
    // See https://github.com/genspark-ai/genoffice/issues/15
    shellWindow.on('resize', () => {
      this.layout()
      setImmediate(() => this.layout())
    })
  }

  private untitled(kind: TabKind, fallback: string): string {
    return this.untitledTitleFor?.(kind) ?? fallback
  }

  private contentBounds(): Rectangle {
    const { width, height } = this.shellWindow.getContentBounds()
    if (this.htmlFullScreenId !== null && this.htmlFullScreenId === this.activeId) {
      return { x: 0, y: 0, width, height }
    }
    return { x: 0, y: TAB_STRIP_HEIGHT, width, height: Math.max(0, height - TAB_STRIP_HEIGHT) }
  }

  /**
   * When a tab's page enters HTML fullscreen (the slides slideshow calls requestFullscreen),
   * grow its view over the tab strip so nothing of the shell chrome shows;
   * restore the normal bounds on leave.
   */
  private trackHtmlFullScreen(id: string, view: WebContentsView): void {
    view.webContents.on('enter-html-full-screen', () => {
      this.htmlFullScreenId = id
      this.comparison = undefined
      for (const tab of this.tabs) tab.view?.setVisible(tab.id === id)
      this.layout()
    })
    view.webContents.on('leave-html-full-screen', () => {
      if (this.htmlFullScreenId === id) this.htmlFullScreenId = null
      this.layout()
    })
  }

  /** re-fit the active tab's view after a window resize */
  layout(): void {
    // Deferred resize layouts can land after the shell window was closed.
    if (this.shellWindow.isDestroyed()) return
    if (this.comparison) {
      const left = this.tabs.find((tab) => tab.id === this.comparison?.leftId)?.view
      const right = this.tabs.find((tab) => tab.id === this.comparison?.rightId)?.view
      if (left && right) {
        const bounds = this.contentBounds()
        const leftWidth = Math.floor(bounds.width / 2)
        left.setBounds({ ...bounds, width: leftWidth })
        right.setBounds({
          ...bounds,
          x: bounds.x + leftWidth,
          width: bounds.width - leftWidth,
        })
        return
      }
      this.comparison = undefined
    }
    const active = this.tabs.find((t) => t.id === this.activeId)
    if (active?.view) active.view.setBounds(this.contentBounds())
  }

  list(): TabSummary[] {
    return this.tabs.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      closable: t.id !== HOME_ID,
      active: t.id === this.activeId,
    }))
  }

  openHomeTab(): void {
    this.activateTab(HOME_ID)
  }

  openDocsTab(openPath?: string, options?: { newBlank?: boolean }): string {
    const view = createDocsView(openPath)
    const id = `t${this.nextId++}`
    if (options?.newBlank) markDocsNewBlank(view.webContents.id)
    this.shellWindow.contentView.addChildView(view)
    view.setVisible(false)
    this.trackHtmlFullScreen(id, view)
    this.tabs.push({
      id,
      kind: 'docs',
      view,
      title: openPath ? basename(openPath) : this.untitled('docs', 'GenOffice Docs'),
      filePath: openPath,
      agentDocument: this.openAgentDocument('docs', openPath),
    })
    this.activateTab(id)
    return id
  }

  openSheetsTab(openPath?: string, options?: { newBlank?: boolean }): string {
    if (options?.newBlank) setSheetsNewBlank()
    const view = createSheetsView()
    const id = `t${this.nextId++}`
    this.shellWindow.contentView.addChildView(view)
    view.setVisible(false)
    this.trackHtmlFullScreen(id, view)
    this.tabs.push({
      id,
      kind: 'sheets',
      view,
      title: openPath ? basename(openPath) : this.untitled('sheets', 'AI Sheets'),
      filePath: openPath,
      agentDocument: this.openAgentDocument('sheets', openPath),
    })
    this.activateTab(id)
    return id
  }

  openSlidesTab(openPath?: string): string {
    const view = createSlidesView(openPath)
    const id = `t${this.nextId++}`
    this.shellWindow.contentView.addChildView(view)
    view.setVisible(false)
    this.trackHtmlFullScreen(id, view)
    this.tabs.push({
      id,
      kind: 'slides',
      view,
      title: openPath ? basename(openPath) : this.untitled('slides', 'AI Slides'),
      filePath: openPath,
      agentDocument: this.openAgentDocument('slides', openPath),
    })
    this.activateTab(id)
    return id
  }

  openPdfTab(openPath: string): string {
    const view = createPdfView(openPath)
    const id = `t${this.nextId++}`
    this.shellWindow.contentView.addChildView(view)
    view.setVisible(false)
    this.trackHtmlFullScreen(id, view)
    this.tabs.push({
      id,
      kind: 'pdf',
      view,
      title: basename(openPath),
      filePath: openPath,
      agentDocument: this.openAgentDocument('pdf', openPath),
    })
    this.activateTab(id)
    return id
  }

  openDocsBesidePdf(pdfTabId: string, openPath: string): string {
    const pdf = this.tabs.find((tab) => tab.id === pdfTabId && tab.kind === 'pdf')
    if (!pdf?.view) return this.openDocsTab(openPath)
    const docsId = this.openDocsTab(openPath)
    const docs = this.tabs.find((tab) => tab.id === docsId)
    if (!docs?.view) return docsId
    this.comparison = { leftId: pdfTabId, rightId: docsId }
    pdf.view.setVisible(true)
    docs.view.setVisible(true)
    this.layout()
    this.onChanged()
    return docsId
  }

  activateTab(id: string): void {
    const target = this.tabs.find((t) => t.id === id)
    if (!target) return
    this.comparison = undefined
    for (const t of this.tabs) t.view?.setVisible(t.id === id)
    if (target.view) target.view.setBounds(this.contentBounds())
    this.activeId = id
    setActiveDocsResolver(target.kind === 'docs' ? () => target.view!.webContents : () => null)
    if (target.kind === 'sheets' && target.view) setActiveSheetsWebContents(target.view.webContents)
    if (target.kind === 'slides' && target.view) setActiveSlidesWebContents(target.view.webContents)
    this.applyMenuFor(target.kind)
    this.onChanged()
  }

  /** move a tab to a new index in the strip; Home is pinned at index 0 */
  reorderTab(id: string, toIndex: number): void {
    if (id === HOME_ID) return
    const fromIndex = this.tabs.findIndex((t) => t.id === id)
    if (fromIndex < 0) return
    const clamped = Math.min(Math.max(Math.trunc(toIndex), 1), this.tabs.length - 1)
    if (clamped === fromIndex) return
    const [moved] = this.tabs.splice(fromIndex, 1)
    this.tabs.splice(clamped, 0, moved)
    this.onChanged()
  }

  /** a module opened a file inside an existing tab (⌘O / queued path) — sync title + dedupe path */
  setTabFileFor(
    webContentsId: number,
    filePath: string,
    transition: 'open' | 'save' = 'save',
  ): void {
    const tab = this.tabs.find((t) => t.view?.webContents.id === webContentsId)
    if (!tab) return
    if (tab.filePath !== filePath) {
      if (transition === 'open' && tab.kind !== 'home') {
        this.releaseAgentDocumentOwner(webContentsId)
        this.onRendererClosed?.(webContentsId)
        tab.agentDocument = this.openAgentDocument(tab.kind, filePath)
      } else {
        this.bindAgentDocumentPath(tab, filePath)
      }
    }
    tab.filePath = filePath
    tab.title = basename(filePath)
    this.onChanged()
  }

  async agentDocumentIdFor(webContentsId: number): Promise<string> {
    const tab = this.tabs.find((item) => item.view?.webContents.id === webContentsId)
    if (!tab?.agentDocument) throw new Error('document_binding_not_found')
    return (await tab.agentDocument).documentId
  }

  agentDocumentKindFor(webContentsId: number): Exclude<TabKind, 'home'> | undefined {
    const kind = this.tabs.find((item) => item.view?.webContents.id === webContentsId)?.kind
    return kind === 'home' ? undefined : kind
  }

  async authorizeAgentDocument(webContentsId: number, documentId: string): Promise<boolean> {
    try {
      if ((await this.agentDocumentIdFor(webContentsId)) !== documentId) return false
      const owner = this.agentDocumentOwners.get(documentId)
      if (owner !== undefined && owner !== webContentsId) return false
      this.agentDocumentOwners.set(documentId, webContentsId)
      return true
    } catch {
      return false
    }
  }

  agentWebContentsFor(
    documentId: string,
    kind?: Exclude<TabKind, 'home'>,
  ): WebContents | undefined {
    const owner = this.agentDocumentOwners.get(documentId)
    if (owner === undefined) return undefined
    const tab = this.tabs.find((item) => item.view?.webContents.id === owner)
    if (!tab?.view || (kind !== undefined && tab.kind !== kind)) return undefined
    return tab.view.webContents
  }

  /** a file was renamed on disk (rename from the Home list) — sync any open tab's title/path;
   *  returns the affected views so callers can notify the embedded editors */
  renameTabFile(
    oldPath: string,
    newPath: string,
  ): Array<{ kind: TabKind; webContents: WebContents }> {
    const affected: Array<{ kind: TabKind; webContents: WebContents }> = []
    for (const tab of this.tabs) {
      if (tab.filePath !== oldPath) continue
      this.bindAgentDocumentPath(tab, newPath)
      tab.filePath = newPath
      tab.title = basename(newPath)
      if (tab.view) affected.push({ kind: tab.kind, webContents: tab.view.webContents })
    }
    if (affected.length > 0) this.onChanged()
    return affected
  }

  /** sheets tabs whose renderer reports unsaved journal edits (shell-close guard) */
  dirtySheetsTabs(): Array<{ id: string; webContents: WebContents }> {
    return this.tabs
      .filter(
        (t) => t.kind === 'sheets' && t.view && sheetsPendingEditCount(t.view.webContents.id) > 0,
      )
      .map((t) => ({ id: t.id, webContents: t.view!.webContents }))
  }

  /** pdf tabs whose renderer reports unsaved markups/form edits (shell-close guard) */
  dirtyPdfTabs(): Array<{ id: string; webContents: WebContents }> {
    return this.tabs
      .filter((t) => t.kind === 'pdf' && t.view && pdfIsDirty(t.view.webContents.id))
      .map((t) => ({ id: t.id, webContents: t.view!.webContents }))
  }

  /** slides tabs whose main-process session has unsaved edits (shell-close guard) */
  dirtySlidesTabs(): Array<{ id: string; webContents: WebContents }> {
    return this.tabs
      .filter((t) => t.kind === 'slides' && t.view && slidesIsDirty(t.view.webContents.id))
      .map((t) => ({ id: t.id, webContents: t.view!.webContents }))
  }

  /** all live docs tabs — dirtiness lives renderer-side, caller queries async (shell-close guard) */
  docsTabs(): Array<{ id: string; webContents: WebContents }> {
    return this.tabs
      .filter((t) => t.kind === 'docs' && t.view)
      .map((t) => ({ id: t.id, webContents: t.view!.webContents }))
  }

  /** closes whichever tab is currently active; no-op for Home (Cmd+W target) */
  closeActiveTab(): void {
    void this.closeTab(this.activeId)
  }

  async closeTab(id: string): Promise<void> {
    if (id === HOME_ID) return
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || this.closingIds.has(id)) return
    let closeGuard =
      tab.view &&
      (tab.kind === 'sheets' && sheetsPendingEditCount(tab.view.webContents.id) > 0
        ? requestSheetsClose
        : tab.kind === 'pdf' && pdfIsDirty(tab.view.webContents.id)
          ? requestPdfClose
          : tab.kind === 'slides' && slidesIsDirty(tab.view.webContents.id)
            ? requestSlidesClose
            : null)
    // docs dirty state lives in the renderer and needs an async query; skip the guard when clean (avoids a flash activation)
    if (!closeGuard && tab.kind === 'docs' && tab.view) {
      this.closingIds.add(id)
      try {
        if (await docsQueryDirty(tab.view.webContents)) closeGuard = requestDocsClose
      } finally {
        this.closingIds.delete(id)
      }
    }
    if (closeGuard && tab.view) {
      // Bring the tab into view so the save prompt has visible context.
      if (this.activeId !== id) this.activateTab(id)
      this.closingIds.add(id)
      try {
        if (!(await closeGuard(tab.view.webContents, this.shellWindow))) return
      } finally {
        this.closingIds.delete(id)
      }
    }
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    if (this.htmlFullScreenId === id) this.htmlFullScreenId = null
    const [removed] = this.tabs.splice(idx, 1)
    const closedComparison = this.comparison?.leftId === id || this.comparison?.rightId === id
    if (closedComparison) this.comparison = undefined
    if (this.activeId === id) {
      const fallback = this.tabs[idx - 1] ?? this.tabs[0]
      this.activateTab(fallback.id)
    } else if (closedComparison) {
      this.activateTab(this.activeId)
    } else {
      this.onChanged()
    }
    if (removed.view) {
      this.releaseAgentDocumentOwner(removed.view.webContents.id)
      this.onRendererClosed?.(removed.view.webContents.id)
      removed.view.setVisible(false)
      this.shellWindow.contentView.removeChildView(removed.view)
      if (removed.kind === 'docs') {
        // webContents.close()/.destroy() on a closed docs tab wedges Electron's whole
        // UI thread in a native modal run loop (reproduced consistently; survives
        // close() vs destroy(), teardown ordering, deferring, and disabling
        // accessibility support — looks like an upstream WebContentsView/Chromium
        // issue, not something fixable from here). Detaching without destroying
        // avoids the freeze; the orphaned webContents is reclaimed when the app quits.
        teardownDocsRenderer(removed.view.webContents)
      } else {
        removed.view.webContents.close()
      }
    }
  }

  findDocsTabByPath(path: string): string | undefined {
    return this.tabs.find((t) => t.kind === 'docs' && t.filePath === path)?.id
  }

  findSheetsTab(): string | undefined {
    return this.tabs.find((t) => t.kind === 'sheets')?.id
  }

  findSheetsTabByPath(path: string): string | undefined {
    return this.tabs.find((t) => t.kind === 'sheets' && t.filePath === path)?.id
  }

  findSlidesTabByPath(path: string): string | undefined {
    return this.tabs.find((t) => t.kind === 'slides' && t.filePath === path)?.id
  }

  findPdfTabByPath(path: string): string | undefined {
    return this.tabs.find((t) => t.kind === 'pdf' && t.filePath === path)?.id
  }

  /** the active tab's pdf view, if the active tab is a pdf (pdf menu target) */
  activePdfTab(): { id: string; webContents: WebContents; filePath?: string } | undefined {
    const tab = this.tabs.find((t) => t.id === this.activeId)
    return tab?.kind === 'pdf' && tab.view
      ? { id: tab.id, webContents: tab.view.webContents, filePath: tab.filePath }
      : undefined
  }

  private openAgentDocument(
    kind: Exclude<TabKind, 'home'>,
    filePath?: string,
  ): Promise<AgentDocumentBinding> | undefined {
    if (!this.agentDocuments) return undefined
    const binding = this.agentDocuments.open(kind, filePath)
    void binding.catch(() => undefined)
    return binding
  }

  private bindAgentDocumentPath(tab: TabRecord, filePath: string): void {
    if (!this.agentDocuments || !tab.agentDocument) return
    const binding = tab.agentDocument.then((current) =>
      this.agentDocuments!.bindPath(current.documentId, filePath),
    )
    void binding.catch(() => undefined)
    tab.agentDocument = binding
  }

  private releaseAgentDocumentOwner(webContentsId: number): void {
    for (const [documentId, owner] of this.agentDocumentOwners) {
      if (owner === webContentsId) this.agentDocumentOwners.delete(documentId)
    }
  }
}
