import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  HomeApi,
  RecentEntry,
  RecentPage,
  RenameResult,
  ProjectHomeApi,
  ProjectSummaryEntry,
  TimelineEntryItem,
  UiLanguage,
} from '../shared/home-api'
import { HOME_CHANNELS, PROJECT_CHANNELS } from '../shared/home-api'
import type { TabsApi, TabSummary } from '../shared/tabs-api'
import { TABS_CHANNELS } from '../shared/tabs-api'
import {
  PI_RUNTIME_CHANNELS,
  asPiRuntimeHealth,
  asProviderCredentialInput,
  asProviderCredentialStatus,
  asProviderId,
  asModelCatalog,
  asMcpCatalog,
  asMcpMutationInput,
  asMcpToolMutationInput,
  asModelProviderConfigurationInput,
  asModelSelectInput,
  asModelOAuthStartInput,
  asModelOAuthOperationInput,
  asModelOAuthResponseInput,
  asOAuthOperation,
  asPackageCatalog,
  asPackageGitInstallInput,
  asPackageLocalInstallInput,
  asPackageMutationInput,
  asPackageNamespace,
  asPackageNpmInstallInput,
  asResourceCatalog,
  type PiRuntimeApi,
} from '../shared/pi-runtime-api'
import {
  MINERU_OCR_CHANNELS,
  asMineruOcrEnableInput,
  asMineruOcrStatus,
  type MineruOcrApi,
} from '../shared/mineru-ocr-api'
import type { PackageAuditApi } from '../shared/package-audit-api'

const UI_LANGUAGES: readonly UiLanguage[] = [
  'zh',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'th',
  'id',
  'ru',
  'ar',
  'pt',
  'it',
  'pl',
  'nl',
  'ms',
  'he',
  'hi',
  'zh-TW',
]

function isUiLanguage(value: unknown): value is UiLanguage {
  return UI_LANGUAGES.includes(value as UiLanguage)
}

const EMPTY_PAGE: RecentPage = { entries: [], total: 0, totalAll: 0 }

function asRecentPage(result: unknown): RecentPage {
  if (result && typeof result === 'object' && Array.isArray((result as RecentPage).entries)) {
    return result as RecentPage
  }
  return EMPTY_PAGE
}

const homeApi: HomeApi = {
  async recents(query) {
    return asRecentPage(await ipcRenderer.invoke(HOME_CHANNELS.recents, query))
  },
  async starred(query) {
    return asRecentPage(await ipcRenderer.invoke(HOME_CHANNELS.starred, query))
  },
  async statPaths(paths) {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.statPaths, paths)
    return Array.isArray(result) ? (result as RecentEntry[]) : []
  },
  async toggleStar(path) {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path.')
    await ipcRenderer.invoke(HOME_CHANNELS.toggleStar, path)
  },
  async openPath(path) {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path.')
    await ipcRenderer.invoke(HOME_CHANNELS.openPath, path)
  },
  async browse() {
    await ipcRenderer.invoke(HOME_CHANNELS.browse)
  },
  async newDoc(opts) {
    await ipcRenderer.invoke(HOME_CHANNELS.newDoc, opts)
  },
  async newSheet(opts) {
    await ipcRenderer.invoke(HOME_CHANNELS.newSheet, opts)
  },
  async newSlide(opts) {
    await ipcRenderer.invoke(HOME_CHANNELS.newSlide, opts)
  },
  async removeRecent(paths) {
    await ipcRenderer.invoke(HOME_CHANNELS.removeRecent, paths)
  },
  async revealPath(path) {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path.')
    await ipcRenderer.invoke(HOME_CHANNELS.revealPath, path)
  },
  async renameFile(path, newName) {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path.')
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.renameFile, path, newName)
    return (result ?? { ok: false, error: 'Rename failed' }) as RenameResult
  },
  async duplicateFile(path) {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path.')
    await ipcRenderer.invoke(HOME_CHANNELS.duplicateFile, path)
  },
  async deleteFiles(paths) {
    await ipcRenderer.invoke(HOME_CHANNELS.deleteFiles, paths)
  },
  async openTrash() {
    await ipcRenderer.invoke(HOME_CHANNELS.openTrash)
  },
  async getLanguage() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getLanguage)
    return isUiLanguage(result) ? result : 'zh'
  },
  async setLanguage(lang) {
    if (!isUiLanguage(lang)) throw new Error('Invalid language.')
    await ipcRenderer.invoke(HOME_CHANNELS.setLanguage, lang)
  },
  async getUpdateChannel() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getUpdateChannel)
    return result === 'beta' ? 'beta' : 'stable'
  },
  async setUpdateChannel(channel) {
    // validated inline: a runtime import from ../shared/update-api would be
    // shared with the update.ts preload entry and get split into a chunk,
    // which sandboxed preload scripts cannot load (window.aiOffice would
    // silently disappear). Preload entries must stay single-file bundles.
    if (channel !== 'stable' && channel !== 'beta') throw new Error('Invalid update channel.')
    await ipcRenderer.invoke(HOME_CHANNELS.setUpdateChannel, channel)
  },
  async getAppVersion() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getAppVersion)
    return typeof result === 'string' ? result : ''
  },
  async onboardingSeen() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.onboardingSeen)
    return result === true
  },
  async setOnboardingSeen() {
    await ipcRenderer.invoke(HOME_CHANNELS.setOnboardingSeen)
  },
}

contextBridge.exposeInMainWorld('aiOffice', homeApi)

const projectApi: ProjectHomeApi = {
  async listProjects() {
    const result: unknown = await ipcRenderer.invoke(PROJECT_CHANNELS.list)
    return Array.isArray(result) ? (result as ProjectSummaryEntry[]) : []
  },
  async listFiles(projectId) {
    const result: unknown = await ipcRenderer.invoke(PROJECT_CHANNELS.files, { projectId })
    return Array.isArray(result)
      ? result.filter((path): path is string => typeof path === 'string')
      : []
  },
  async createProject(name) {
    const result: unknown = await ipcRenderer.invoke(PROJECT_CHANNELS.create, { name })
    return result as ProjectSummaryEntry
  },
  async renameProject(id, name) {
    await ipcRenderer.invoke(PROJECT_CHANNELS.rename, { id, name })
  },
  async deleteProject(id) {
    await ipcRenderer.invoke(PROJECT_CHANNELS.delete, { id })
  },
  async moveFile(filePath, projectId) {
    await ipcRenderer.invoke(PROJECT_CHANNELS.moveFile, { filePath, projectId })
  },
  async getTimeline(projectId, limit) {
    const result: unknown = await ipcRenderer.invoke(PROJECT_CHANNELS.timeline, {
      projectId,
      limit,
    })
    return Array.isArray(result) ? (result as TimelineEntryItem[]) : []
  },
}

contextBridge.exposeInMainWorld('aiOfficeProject', projectApi)

const tabsApi: TabsApi = {
  async list() {
    const result: unknown = await ipcRenderer.invoke(TABS_CHANNELS.list)
    return Array.isArray(result) ? (result as TabSummary[]) : []
  },
  async activate(id) {
    await ipcRenderer.invoke(TABS_CHANNELS.activate, id)
  },
  async close(id) {
    await ipcRenderer.invoke(TABS_CHANNELS.close, id)
  },
  async showMenu(x, y) {
    await ipcRenderer.invoke(TABS_CHANNELS.showMenu, x, y)
  },
  async showNewMenu(x, y) {
    await ipcRenderer.invoke(TABS_CHANNELS.showNewMenu, x, y)
  },
  async reorder(id, toIndex) {
    await ipcRenderer.invoke(TABS_CHANNELS.reorder, id, toIndex)
  },
  onChanged(handler) {
    const listener = (_event: IpcRendererEvent, tabs: TabSummary[]) => handler(tabs)
    ipcRenderer.on(TABS_CHANNELS.changed, listener)
    return () => ipcRenderer.removeListener(TABS_CHANNELS.changed, listener)
  },
}

contextBridge.exposeInMainWorld('aiOfficeTabs', tabsApi)

const piRuntimeApi: PiRuntimeApi = {
  async health() {
    return asPiRuntimeHealth(await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.health))
  },
  async saveProviderApiKey(input) {
    return asProviderCredentialStatus(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.saveProviderApiKey,
        asProviderCredentialInput(input),
      ),
    )
  },
  async providerCredentialStatus(providerId) {
    return asProviderCredentialStatus(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.providerCredentialStatus,
        asProviderId(providerId),
      ),
    )
  },
  async logoutProvider(providerId) {
    return asProviderCredentialStatus(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.logoutProvider, asProviderId(providerId)),
    )
  },
  async modelCatalog() {
    return asModelCatalog(await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.modelCatalog))
  },
  async selectModel(input) {
    return asModelCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.selectModel, asModelSelectInput(input)),
    )
  },
  async configureModelProvider(input) {
    return asModelCatalog(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.configureModelProvider,
        asModelProviderConfigurationInput(input),
      ),
    )
  },
  async startModelOAuth(input) {
    return asOAuthOperation(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.startModelOAuth, asModelOAuthStartInput(input)),
    )
  },
  async modelOAuthStatus(input) {
    return asOAuthOperation(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.modelOAuthStatus,
        asModelOAuthOperationInput(input),
      ),
    )
  },
  async respondModelOAuth(input) {
    return asOAuthOperation(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.respondModelOAuth,
        asModelOAuthResponseInput(input),
      ),
    )
  },
  async cancelModelOAuth(input) {
    return asOAuthOperation(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.cancelModelOAuth,
        asModelOAuthOperationInput(input),
      ),
    )
  },
  async logoutModel(providerId) {
    return asModelCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.logoutModel, asProviderId(providerId)),
    )
  },
  async resourceCatalog() {
    return asResourceCatalog(await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.resourceCatalog))
  },
  async selectResourceProject() {
    return asResourceCatalog(await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.selectResourceProject))
  },
  async grantProjectTrust() {
    return asResourceCatalog(await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.grantProjectTrust))
  },
  async revokeProjectTrust() {
    return asResourceCatalog(await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.revokeProjectTrust))
  },
  async packageCatalog(namespace) {
    return asPackageCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.packageCatalog, asPackageNamespace(namespace)),
    )
  },
  async installLocalPackage(input) {
    return asPackageCatalog(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.installLocalPackage,
        asPackageLocalInstallInput(input),
      ),
    )
  },
  async installNpmPackage(input) {
    return asPackageCatalog(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.installNpmPackage,
        asPackageNpmInstallInput(input),
      ),
    )
  },
  async installGitPackage(input) {
    return asPackageCatalog(
      await ipcRenderer.invoke(
        PI_RUNTIME_CHANNELS.installGitPackage,
        asPackageGitInstallInput(input),
      ),
    )
  },
  async activatePackage(input) {
    return asPackageCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.activatePackage, asPackageMutationInput(input)),
    )
  },
  async enablePackage(input) {
    return asPackageCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.enablePackage, asPackageMutationInput(input)),
    )
  },
  async disablePackage(input) {
    return asPackageCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.disablePackage, asPackageMutationInput(input)),
    )
  },
  async uninstallPackage(input) {
    return asPackageCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.uninstallPackage, asPackageMutationInput(input)),
    )
  },
  async mcpCatalog() {
    return asMcpCatalog(await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.mcpCatalog))
  },
  async activateMcp(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.activateMcp, asMcpMutationInput(input)),
    )
  },
  async enableMcp(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.enableMcp, asMcpMutationInput(input)),
    )
  },
  async disableMcp(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.disableMcp, asMcpMutationInput(input)),
    )
  },
  async retryMcp(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.retryMcp, asMcpMutationInput(input)),
    )
  },
  async loginMcp(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.loginMcp, asMcpMutationInput(input)),
    )
  },
  async cancelMcpLogin(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.cancelMcpLogin, asMcpMutationInput(input)),
    )
  },
  async enableMcpTool(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.enableMcpTool, asMcpToolMutationInput(input)),
    )
  },
  async disableMcpTool(input) {
    return asMcpCatalog(
      await ipcRenderer.invoke(PI_RUNTIME_CHANNELS.disableMcpTool, asMcpToolMutationInput(input)),
    )
  },
}

contextBridge.exposeInMainWorld('aiOfficeAgent', piRuntimeApi)

const mineruOcrApi: MineruOcrApi = {
  async status() {
    return asMineruOcrStatus(await ipcRenderer.invoke(MINERU_OCR_CHANNELS.status))
  },
  async enable(input) {
    return asMineruOcrStatus(
      await ipcRenderer.invoke(MINERU_OCR_CHANNELS.enable, asMineruOcrEnableInput(input)),
    )
  },
  async disable() {
    return asMineruOcrStatus(await ipcRenderer.invoke(MINERU_OCR_CHANNELS.disable))
  },
}

contextBridge.exposeInMainWorld('aiOfficeMineruOcr', mineruOcrApi)

if (
  process.env.GENOFFICE_PACKAGE_NETWORK_AUDIT === '1' &&
  process.env.GENOFFICE_NETWORK_REPORT &&
  process.env.GENOFFICE_NETWORK_SURFACE
) {
  const packageAuditApi: PackageAuditApi = {
    state: () => ipcRenderer.invoke('package-audit:state'),
    shutdown: () => ipcRenderer.invoke('package-audit:shutdown'),
  }
  contextBridge.exposeInMainWorld('aiOfficePackageAudit', packageAuditApi)
}
