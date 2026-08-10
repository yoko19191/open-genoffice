export interface OpenFileResult {
  path: string
  name: string
  /** raw docx bytes */
  data: ArrayBuffer
  /** sha256 of the original file; original archived under this hash */
  hash: string
}

export interface PickImageResult {
  /** raw image bytes, base64 encoded */
  base64: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif'
  name: string
}

/** an open docs tab, for View → Switch Tab */
export interface DocsTabInfo {
  id: string
  title: string
  focused: boolean
}

/** commands dispatched from the native application menu to the renderer */
export type MenuCommand =
  | 'new'
  | 'open'
  | 'open-path'
  | 'save'
  | 'save-as'
  | 'undo'
  | 'redo'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-100'
  | 'zoom-page-width'
  | 'zoom-whole-page'
  | 'toggle-ai'
  | 'toggle-dark'
  | 'insert-table'
  | 'insert-image'
  | 'insert-page-break'
  | 'insert-link'
  | 'insert-equation'
  | 'insert-comment'
  | 'font-dialog'
  | 'paragraph-dialog'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-justify'
  | 'page-setup'
  | 'find'
  | 'print'
  | 'export-pdf'
  | 'word-count'

export interface DesktopApi {
  /** current UI language (persisted by the shell in app-settings.json) */
  getLanguage(): Promise<'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'>
  /** language switched from the shell home page */
  onLanguageChanged(
    handler: (
      lang: 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar',
    ) => void,
  ): () => void
  openDocx(): Promise<OpenFileResult | null>
  openDocxPath(path: string): Promise<OpenFileResult | null>
  /** mark the renderer ready and consume a file passed by Finder/Explorer at launch */
  consumePendingOpenDocx(): Promise<OpenFileResult | null>
  /** returns true when this tab was created via "New Document" and should start blank */
  consumeNewBlankDoc(): Promise<boolean>
  /** receive documents opened from Finder/Explorer while the app is running */
  onOpenDocx(handler: (result: OpenFileResult) => void): () => void
  /** File was renamed externally (renamed in the shell Home list) — pushes old and new paths; renderer syncs its save path and title bar */
  onRenamedDocx(handler: (paths: { oldPath: string; newPath: string }) => void): () => void
  /** auto=true marks an autosave: an externally modified file then fails with
   *  reason 'external-modified' instead of prompting (manual saves get an
   *  Overwrite/Cancel dialog in the main process) */
  saveDocx(
    path: string,
    data: ArrayBuffer,
    auto?: boolean,
  ): Promise<{ ok: boolean; error?: string; reason?: 'external-modified' }>
  /** crash-recovery copy of a dirty document, stored under userData */
  writeRecoveryCopy(path: string, data: ArrayBuffer): Promise<{ ok: boolean }>
  /** tab closed but webContents kept alive (shell freeze workaround) — stop background timers */
  onTeardown(handler: () => void): () => void
  saveDocxAs(
    defaultName: string,
    data: ArrayBuffer,
  ): Promise<{ ok: boolean; path?: string; error?: string }>
  /** first save of a new document: silently writes into the default folder, no dialog */
  saveDocxNew(
    defaultName: string,
    data: ArrayBuffer,
  ): Promise<{ ok: boolean; path?: string; error?: string }>
  getRecentFiles(): Promise<string[]>
  pickImage(): Promise<PickImageResult | null>
  /** system print dialog for the current window */
  print(): Promise<void>
  /** render the document to PDF and ask where to save; size in twips.
   *  outPath is only honored when a previous export dialog chose that exact path */
  exportPdf(
    defaultName: string,
    pageWidthTwips: number,
    pageHeightTwips: number,
    outPath?: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }>
  /** Mixed paper-size export: produce a set of PDF bytes (base64) at given sizes per the current print layout */
  printPdfBuffer(
    pageWidthTwips: number,
    pageHeightTwips: number,
  ): Promise<{ ok: boolean; base64?: string; error?: string }>
  /** Merge grouped PDF fragments in order and write to disk (missing outPath opens
   *  the save dialog; a given outPath must come from a previous export dialog) */
  saveMergedPdf(
    defaultName: string,
    base64Parts: string[],
    outPath?: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }>
  /** View → New Tab: open another docs tab, optionally loading the same document */
  openNewTab(openPath?: string | null): Promise<void>
  /** all open docs tabs, for View → Switch Tab */
  listDocsTabs(): Promise<DocsTabInfo[]>
  focusDocsTab(id: string): Promise<void>
  /** subscribe to native menu commands; returns unsubscribe */
  onMenuCommand(handler: (command: MenuCommand, payload?: string) => void): () => void
  /** Close guard: main process queries pre-close state (dirty flag + autosave switch; if autosave is on, save silently without a dialog) */
  onCloseCheck(handler: () => void): () => void
  reportCloseCheck(state: { dirty: boolean; autoSave: boolean; filePath?: string | null }): void
  /** Close guard chose "Save": main process asks the renderer to run the full save flow */
  onCloseSaveRequest(handler: () => void): () => void
  reportCloseSaveResult(ok: boolean): void
}
