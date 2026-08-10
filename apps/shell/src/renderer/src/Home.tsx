import { useCallback, useEffect, useRef, useState } from 'react'
import logoLockup from './assets/genoffice-logo.svg'
import iconDocx from './assets/file-docx.svg'
import iconXlsx from './assets/file-xlsx.svg'
import iconPptx from './assets/file-pptx.svg'
import iconPdf from './assets/file-pdf.svg'
import type {
  HomeApi,
  ProjectHomeApi,
  ProjectSummaryEntry,
  RecentEntry,
} from '../../shared/home-api'
import { fileCountKey, visiblePageCount } from './counts'
import { useI18n } from './locale'
import type { I18n, StringKey } from './locale'
import type { PiRuntimeApi } from '../../shared/pi-runtime-api'
import type { MineruOcrApi, MineruOcrStatusProjection } from '../../shared/mineru-ocr-api'

declare global {
  interface Window {
    aiOffice: HomeApi
    aiOfficeProject?: ProjectHomeApi
    aiOfficeAgent: PiRuntimeApi
    aiOfficeMineruOcr: MineruOcrApi
  }
}

/** page size of the home list; scrolling to the bottom auto-loads the next page */
const PAGE_SIZE = 50

/** greeting sublines on the home page: one is picked at random on entry */
const GREET_ASK_KEYS = [
  'greetAsk1',
  'greetAsk2',
  'greetAsk3',
  'greetAsk4',
  'greetAsk5',
  'greetAsk6',
] as const satisfies readonly StringKey[]

const FILE_ICONS: Record<string, string> = {
  docx: iconDocx,
  xlsx: iconXlsx,
  pptx: iconPptx,
  pdf: iconPdf,
}

function FileBadge({ ext, size }: { ext: string; size: number }) {
  const icon = FILE_ICONS[ext]
  if (icon) {
    return <img src={icon} width={size} height={size} alt="" aria-hidden="true" />
  }
  const label = ext ? ext[0].toUpperCase() : '?'
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7.5" fill="#98a2b3" />
      <text
        x="16"
        y="16.5"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontSize={17}
        fontWeight="700"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
      >
        {label}
      </text>
    </svg>
  )
}

function formatModified(mtimeMs: number, i18n: I18n): string {
  const date = new Date(mtimeMs)
  const now = new Date()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
  if (days <= 0) {
    return `${i18n.t('today')} · ${date.toLocaleTimeString(i18n.dateLocale, { hour: '2-digit', minute: '2-digit' })}`
  }
  if (days === 1) return i18n.t('yesterday')
  return date.toLocaleDateString(i18n.dateLocale, { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function parentDir(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function baseName(entry: RecentEntry): string {
  return entry.ext ? entry.name.slice(0, -(entry.ext.length + 1)) : entry.name
}

// ── Project hooks ─────────────────────────────────────────

/** whether we are inside the shell (aiOfficeProject API available) */
function hasProjectApi(): boolean {
  return typeof window.aiOfficeProject !== 'undefined'
}

const FILTERS: { key: string; label: StringKey }[] = [
  { key: 'all', label: 'filterAll' },
  { key: 'docx', label: 'filterDocs' },
  { key: 'xlsx', label: 'filterSheets' },
  { key: 'pptx', label: 'filterSlides' },
  { key: 'pdf', label: 'filterPdf' },
]

// ── Project sidebar component ────────────────────────────

interface ProjectPanelProps {
  projects: ProjectSummaryEntry[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onRefresh: () => void
}

function ProjectPanel({ projects, selectedId, onSelect, onRefresh }: ProjectPanelProps) {
  const { t } = useI18n()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  // open menu id + fixed-position anchor (viewport coords), so the popup can
  // escape the scrollable project list without the list losing overflow-y
  const [projMenu, setProjMenu] = useState<{ id: string; top: number; right: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const newInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating && newInputRef.current) newInputRef.current.focus()
  }, [creating])

  // close the menu on outside click or any scroll (the fixed-position popup
  // would otherwise detach from its row while the list scrolls)
  useEffect(() => {
    if (!projMenu) return
    const handler = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target?.closest?.('.proj-menu-wrap')) setProjMenu(null)
    }
    const close = () => setProjMenu(null)
    window.addEventListener('pointerdown', handler)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', handler)
      window.removeEventListener('scroll', close, true)
    }
  }, [projMenu])

  const commitCreate = async () => {
    const name = newName.trim()
    setCreating(false)
    setNewName('')
    if (!name) return
    await window.aiOfficeProject?.createProject(name)
    onRefresh()
  }

  const commitRename = async () => {
    if (!renaming) return
    const name = renaming.value.trim()
    const id = renaming.id
    setRenaming(null)
    if (!name) return
    await window.aiOfficeProject?.renameProject(id, name)
    onRefresh()
  }

  // in-app confirm dialog (same style as the delete-files modal), not window.confirm
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const doDelete = (id: string) => {
    setProjMenu(null)
    setConfirmDeleteId(id)
  }

  const confirmDeleteNow = async () => {
    const id = confirmDeleteId
    setConfirmDeleteId(null)
    if (!id) return
    await window.aiOfficeProject?.deleteProject(id)
    if (selectedId === id) onSelect(null)
    onRefresh()
  }

  useEffect(() => {
    if (!confirmDeleteId) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmDeleteId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmDeleteId])

  return (
    <div className="proj-panel">
      <div className="proj-panel-head">
        <span className="proj-panel-title">{t('projects')}</span>
        <button
          className="proj-add-btn"
          title={t('newProject')}
          onClick={() => setCreating(true)}
          aria-label={t('newProject')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 1v12M1 7h12"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {creating && (
        <div className="proj-new-row">
          <input
            ref={newInputRef}
            className="proj-rename-input"
            placeholder={t('projectName')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => void commitCreate()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitCreate()
              if (e.key === 'Escape') {
                setCreating(false)
                setNewName('')
              }
            }}
          />
        </div>
      )}

      <ul className="proj-list">
        {projects.map((proj) => {
          const isActive = selectedId === proj.id
          const isRenaming = renaming?.id === proj.id
          return (
            <li key={proj.id} className={`proj-item${isActive ? ' active' : ''}`}>
              <div
                className="proj-item-main"
                role="button"
                tabIndex={0}
                onClick={() => onSelect(isActive ? null : proj.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelect(isActive ? null : proj.id)
                }}
              >
                <span className="proj-item-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1c.44 0 .85.19 1.13.52L8.4 4.4H13A1.5 1.5 0 0 1 14.5 5.9v5.6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V4z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {isRenaming ? (
                  <input
                    className="proj-rename-input inline"
                    value={renaming.value}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ id: proj.id, value: e.target.value })}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') void commitRename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <span className="proj-item-name">
                    {proj.isDefault ? t('defaultProject') : proj.name}
                  </span>
                )}
                <span className="proj-item-meta">
                  <span className="proj-item-count">{proj.fileCount}</span>
                </span>
              </div>

              {!proj.isDefault && (
                <div className="proj-menu-wrap">
                  <button
                    className="proj-more-btn"
                    aria-label={t('projMoreActions', { name: proj.name })}
                    aria-expanded={projMenu?.id === proj.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (projMenu?.id === proj.id) {
                        setProjMenu(null)
                        return
                      }
                      const rect = e.currentTarget.getBoundingClientRect()
                      setProjMenu({
                        id: proj.id,
                        top: rect.bottom + 4,
                        right: window.innerWidth - rect.right,
                      })
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="3.2" cy="8" r="1.35" fill="currentColor" />
                      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
                      <circle cx="12.8" cy="8" r="1.35" fill="currentColor" />
                    </svg>
                  </button>
                  {projMenu?.id === proj.id && (
                    <div
                      className="proj-menu"
                      role="menu"
                      style={{ top: projMenu.top, right: projMenu.right }}
                    >
                      <button
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation()
                          setProjMenu(null)
                          setRenaming({ id: proj.id, value: proj.name })
                        }}
                      >
                        {t('rename')}
                      </button>
                      <div className="row-menu-divider" />
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          doDelete(proj.id)
                        }}
                      >
                        {t('deleteProject')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {confirmDeleteId &&
        (() => {
          // locale string is "title?\nbody" — split it across the dialog
          const [confirmTitle, ...confirmBody] = t('deleteProjectConfirm').split('\n')
          return (
            <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
              <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label={confirmTitle}
                onClick={(event) => event.stopPropagation()}
              >
                <h3>{confirmTitle}</h3>
                <p>{confirmBody.join('\n')}</p>
                <div className="modal-buttons">
                  <button
                    className="btn btn-secondary"
                    autoFocus
                    onClick={() => setConfirmDeleteId(null)}
                  >
                    {t('cancel')}
                  </button>
                  <button className="btn btn-danger" onClick={() => void confirmDeleteNow()}>
                    {t('delete')}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
    </div>
  )
}

// ── Settings entry (bottom-left) ─────────────────────────

// sorted by ISO 639 language code — native-script labels have no natural
// shared alphabet, so the code is the ordering key
const LANG_OPTIONS = [
  { value: 'ar', label: 'العربية' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'he', label: 'עברית' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
] as const

const CHANNEL_OPTIONS = [
  { value: 'stable', labelKey: 'channelStable' },
  { value: 'beta', labelKey: 'channelBeta' },
] as const

const PRIMARY_MODEL_PROVIDER_ID = 'openai'
type ModelCatalog = Awaited<ReturnType<PiRuntimeApi['modelCatalog']>>
type ResourceCatalog = Awaited<ReturnType<PiRuntimeApi['resourceCatalog']>>
type PackageCatalog = Awaited<ReturnType<PiRuntimeApi['packageCatalog']>>
type McpCatalog = Awaited<ReturnType<PiRuntimeApi['mcpCatalog']>>
type PackageNamespace = Parameters<PiRuntimeApi['packageCatalog']>[0]
type OAuthOperation = Awaited<ReturnType<PiRuntimeApi['modelOAuthStatus']>>
type ModelCapability = ModelCatalog['providers'][number]['models'][number]['capabilities'][number]
const configurableCapabilities: readonly ModelCapability[] = [
  'text-input',
  'image-input',
  'audio-input',
  'video-input',
  'tool-use',
  'reasoning',
]

function MineruOcrDialog({ onClose }: { onClose: () => void }) {
  const { lang } = useI18n()
  const zh = lang === 'zh' || lang === 'zh-TW'
  const [status, setStatus] = useState<MineruOcrStatusProjection>()
  const [token, setToken] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    void window.aiOfficeMineruOcr
      .status()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'mineru_status_failed')
      })
    return () => {
      active = false
    }
  }, [])

  const enable = async () => {
    if (!accepted || !token.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      setStatus(
        await window.aiOfficeMineruOcr.enable({
          disclosureAccepted: true,
          token,
        }),
      )
      setToken('')
      setAccepted(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'mineru_enable_failed')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      setStatus(await window.aiOfficeMineruOcr.disable())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'mineru_disable_failed')
    } finally {
      setBusy(false)
    }
  }

  const statusText = !status
    ? zh
      ? '正在读取状态…'
      : 'Loading status…'
    : status.enabled
      ? zh
        ? '已启用；凭据已由系统安全存储保管。'
        : 'Enabled; the credential is protected by system secure storage.'
      : status.credential === 'secure_storage_unavailable'
        ? zh
          ? '系统安全存储不可用，无法启用。'
          : 'System secure storage is unavailable; MinerU cannot be enabled.'
        : zh
          ? '未启用。'
          : 'Disabled.'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form
        className="modal mineru-ocr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? 'MinerU PDF 转 Word' : 'MinerU PDF to Word'}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void enable()
        }}
      >
        <h3>{zh ? 'MinerU PDF 转 Word' : 'MinerU PDF to Word'}</h3>
        <p className="provider-credential-status" role="status">
          {statusText}
        </p>
        <p className="mineru-disclosure">
          {zh
            ? '启用后，只有在你主动选择“导出为 Word”时，当前 PDF 才会上传到 MinerU 云端并使用 VLM 转换。每次只提交一个 PDF，不会切换到其他服务。取消本地任务不能保证远端任务停止。访问令牌只写入系统加密存储，不会显示、同步或写入日志。'
            : 'After you enable this provider, the current PDF is uploaded to MinerU only when you explicitly choose Export as Word. Each batch contains one PDF, uses VLM, and never falls back to another service. Local cancellation cannot guarantee that remote work stops. The token is write-only in system-encrypted storage and is never displayed, synced, or logged.'}
        </p>
        <label className="provider-credential-field">
          <span>{zh ? 'MinerU 访问令牌（只写）' : 'MinerU access token (write-only)'}</span>
          <input
            type="password"
            autoComplete="off"
            value={token}
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label className="mineru-consent">
          <input
            type="checkbox"
            checked={accepted}
            disabled={busy}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>
            {zh
              ? '我理解并同意上述云端上传说明'
              : 'I understand and accept the cloud upload disclosure'}
          </span>
        </label>
        {error && <p className="provider-credential-error">{error}</p>}
        <div className="modal-buttons">
          {status?.enabled && (
            <button type="button" className="btn" disabled={busy} onClick={() => void disable()}>
              {zh ? '禁用' : 'Disable'}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {zh ? '关闭' : 'Close'}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !accepted || !token.trim()}
          >
            {busy ? (zh ? '保存中…' : 'Saving…') : zh ? '启用并保存令牌' : 'Enable and save token'}
          </button>
        </div>
      </form>
    </div>
  )
}

function ProviderCredentialDialog({ onClose }: { onClose: () => void }) {
  const { lang } = useI18n()
  const zh = lang === 'zh' || lang === 'zh-TW'
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [resourceCatalog, setResourceCatalog] = useState<ResourceCatalog>()
  const [packageCatalog, setPackageCatalog] = useState<PackageCatalog>()
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalog>()
  const [mcpLoginKey, setMcpLoginKey] = useState<string>()
  const [packageNamespace, setPackageNamespace] = useState<PackageNamespace>('global')
  const [packageId, setPackageId] = useState('')
  const [npmPackageName, setNpmPackageName] = useState('')
  const [npmPackageVersion, setNpmPackageVersion] = useState('')
  const [gitPackageUrl, setGitPackageUrl] = useState('')
  const [gitPackageCommit, setGitPackageCommit] = useState('')
  const [providerId, setProviderId] = useState(PRIMARY_MODEL_PROVIDER_ID)
  const [apiKey, setApiKey] = useState('')
  const [persistence, setPersistence] = useState<'persistent' | 'memory_only'>('persistent')
  const [oauth, setOAuth] = useState<OAuthOperation>()
  const [oauthResponse, setOAuthResponse] = useState('')
  const [localProviderId, setLocalProviderId] = useState('local-openai')
  const [localProviderName, setLocalProviderName] = useState('Local OpenAI')
  const [localBaseUrl, setLocalBaseUrl] = useState('')
  const [localModelId, setLocalModelId] = useState('')
  const [localModelName, setLocalModelName] = useState('')
  const [localCapabilities, setLocalCapabilities] = useState<ModelCapability[]>([
    'text-input',
    'tool-use',
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshCatalog = useCallback(async () => {
    try {
      const next = await window.aiOfficeAgent.modelCatalog()
      setCatalog(next)
      const selected = next.selections.conversation?.providerId
      if (selected && next.providers.some((provider) => provider.providerId === selected)) {
        setProviderId(selected)
      } else if (!next.providers.some((provider) => provider.providerId === providerId)) {
        setProviderId(next.providers[0]?.providerId ?? PRIMARY_MODEL_PROVIDER_ID)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'model_catalog_failed')
    }
  }, [providerId])

  const refreshResourceCatalog = useCallback(async () => {
    try {
      setResourceCatalog(await window.aiOfficeAgent.resourceCatalog())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'resource_catalog_failed')
    }
  }, [])

  const refreshPackageCatalog = useCallback(async () => {
    try {
      setPackageCatalog(await window.aiOfficeAgent.packageCatalog(packageNamespace))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'package_catalog_failed')
    }
  }, [packageNamespace])

  const refreshMcpCatalog = useCallback(async () => {
    try {
      setMcpCatalog(await window.aiOfficeAgent.mcpCatalog())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'mcp_catalog_failed')
    }
  }, [])

  useEffect(() => {
    void refreshCatalog()
    void refreshResourceCatalog()
    void refreshPackageCatalog()
    void refreshMcpCatalog()
  }, [refreshCatalog, refreshMcpCatalog, refreshPackageCatalog, refreshResourceCatalog])

  useEffect(() => {
    if (!mcpLoginKey) return
    let active = true
    const poll = async () => {
      try {
        const next = await window.aiOfficeAgent.mcpCatalog()
        if (!active) return
        setMcpCatalog(next)
        const target = next.servers.find(
          (server) => `${server.namespace}/${server.serverId}` === mcpLoginKey,
        )
        if (!target || target.state !== 'auth_required') setMcpLoginKey(undefined)
      } catch {
        // A transient Runtime restart is surfaced by the next regular poll.
      }
    }
    const timer = window.setInterval(() => void poll(), 1_000)
    void poll()
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [mcpLoginKey])

  useEffect(() => {
    if (
      !oauth ||
      oauth.state === 'ready' ||
      oauth.state === 'failed' ||
      oauth.state === 'cancelled'
    )
      return
    let active = true
    const poll = async () => {
      try {
        const next = await window.aiOfficeAgent.modelOAuthStatus({
          operationId: oauth.operationId,
        })
        if (!active) return
        setOAuth(next)
        if (next.state === 'ready') await refreshCatalog()
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'model_oauth_failed')
      }
    }
    const timer = window.setInterval(() => void poll(), 750)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [oauth, refreshCatalog])

  const provider = catalog?.providers.find((item) => item.providerId === providerId)
  const selected = catalog?.selections.conversation

  const saveApiKey = async () => {
    if (!apiKey || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.aiOfficeAgent.saveProviderApiKey({
        providerId,
        persistence,
        apiKey,
      })
      setApiKey('')
      await refreshCatalog()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'credential_persist_failed'
      const code = message.includes('secure_storage_unavailable')
        ? 'secure_storage_unavailable'
        : 'credential_persist_failed'
      setError(code)
      if (code === 'secure_storage_unavailable') setPersistence('memory_only')
    } finally {
      setBusy(false)
    }
  }

  const selectModel = async (value: string) => {
    const [nextProviderId, modelId] = value.split('\0')
    if (!nextProviderId || !modelId || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.aiOfficeAgent.selectModel({
        role: 'conversation',
        providerId: nextProviderId,
        modelId,
      })
      setCatalog(next)
      setProviderId(nextProviderId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'model_select_failed')
    } finally {
      setBusy(false)
    }
  }

  const startOAuth = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setOAuth(
        await window.aiOfficeAgent.startModelOAuth({
          operationId: crypto.randomUUID(),
          providerId,
        }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'model_oauth_failed')
    } finally {
      setBusy(false)
    }
  }

  const configureLocalProvider = async () => {
    if (
      busy ||
      !localProviderId ||
      !localProviderName ||
      !localBaseUrl ||
      !localModelId ||
      !localModelName ||
      localCapabilities.length === 0
    )
      return
    setBusy(true)
    setError(null)
    try {
      const next = await window.aiOfficeAgent.configureModelProvider({
        providerId: localProviderId,
        name: localProviderName,
        baseUrl: localBaseUrl,
        models: [
          {
            modelId: localModelId,
            name: localModelName,
            capabilities: localCapabilities,
          },
        ],
      })
      setCatalog(next)
      setProviderId(localProviderId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'model_provider_invalid')
    } finally {
      setBusy(false)
    }
  }

  const toggleLocalCapability = (capability: ModelCapability) => {
    setLocalCapabilities((current) =>
      current.includes(capability)
        ? current.filter((value) => value !== capability)
        : [...current, capability],
    )
  }

  const respondOAuth = async () => {
    if (!oauth || !oauthResponse || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.aiOfficeAgent.respondModelOAuth({
        operationId: oauth.operationId,
        value: oauthResponse,
      })
      setOAuthResponse('')
      setOAuth(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'model_oauth_failed')
    } finally {
      setBusy(false)
    }
  }

  const cancelOAuth = async () => {
    if (!oauth || busy) return
    setBusy(true)
    try {
      setOAuth(await window.aiOfficeAgent.cancelModelOAuth({ operationId: oauth.operationId }))
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setCatalog(await window.aiOfficeAgent.logoutModel(providerId))
      setApiKey('')
      setOAuth(undefined)
      setOAuthResponse('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'credential_delete_failed')
    } finally {
      setBusy(false)
    }
  }

  const selectResourceProject = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setResourceCatalog(await window.aiOfficeAgent.selectResourceProject())
      setMcpCatalog(await window.aiOfficeAgent.mcpCatalog())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'resource_catalog_failed')
    } finally {
      setBusy(false)
    }
  }

  const updateProjectTrust = async (trusted: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = trusted
        ? await window.aiOfficeAgent.grantProjectTrust()
        : await window.aiOfficeAgent.revokeProjectTrust()
      setResourceCatalog(next)
      setMcpCatalog(await window.aiOfficeAgent.mcpCatalog())
      if (!trusted && packageNamespace === 'project') setPackageNamespace('global')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'project_trust_failed')
    } finally {
      setBusy(false)
    }
  }

  const selectedPackageHash = packageCatalog?.packages.find(
    (item) => item.namespace === packageNamespace && item.packageId === packageId,
  )?.contentSha256

  const installPackage = async (source: 'local' | 'npm' | 'git') => {
    if (!packageId || busy) return
    setBusy(true)
    setError(null)
    try {
      const base = {
        namespace: packageNamespace,
        packageId,
        ...(selectedPackageHash ? { expectedPreviousContentSha256: selectedPackageHash } : {}),
      }
      const next =
        source === 'local'
          ? await window.aiOfficeAgent.installLocalPackage(base)
          : source === 'npm'
            ? await window.aiOfficeAgent.installNpmPackage({
                ...base,
                name: npmPackageName,
                version: npmPackageVersion,
              })
            : await window.aiOfficeAgent.installGitPackage({
                ...base,
                url: gitPackageUrl,
                commit: gitPackageCommit,
              })
      setPackageCatalog(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'package_install_failed')
    } finally {
      setBusy(false)
    }
  }

  const mutatePackage = async (
    action: 'activate' | 'enable' | 'disable' | 'uninstall',
    targetPackageId: string,
  ) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const input = { namespace: packageNamespace, packageId: targetPackageId }
      const next =
        action === 'activate'
          ? await window.aiOfficeAgent.activatePackage(input)
          : action === 'enable'
            ? await window.aiOfficeAgent.enablePackage(input)
            : action === 'disable'
              ? await window.aiOfficeAgent.disablePackage(input)
              : await window.aiOfficeAgent.uninstallPackage(input)
      setPackageCatalog(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'package_mutation_failed')
    } finally {
      setBusy(false)
    }
  }

  const mutateMcp = async (
    action: 'activate' | 'enable' | 'disable' | 'retry',
    namespace: PackageNamespace,
    serverId: string,
  ) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const input = { namespace, serverId }
      setMcpCatalog(
        action === 'activate'
          ? await window.aiOfficeAgent.activateMcp(input)
          : action === 'enable'
            ? await window.aiOfficeAgent.enableMcp(input)
            : action === 'disable'
              ? await window.aiOfficeAgent.disableMcp(input)
              : await window.aiOfficeAgent.retryMcp(input),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'mcp_mutation_failed')
    } finally {
      setBusy(false)
    }
  }

  const loginMcp = async (namespace: PackageNamespace, serverId: string, cancel = false) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const key = `${namespace}/${serverId}`
    try {
      setMcpCatalog(
        cancel
          ? await window.aiOfficeAgent.cancelMcpLogin({ namespace, serverId })
          : await window.aiOfficeAgent.loginMcp({ namespace, serverId }),
      )
      setMcpLoginKey(cancel ? undefined : key)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'mcp_oauth_failed')
      if (cancel) setMcpLoginKey(undefined)
    } finally {
      setBusy(false)
    }
  }

  const toggleMcpTool = async (
    namespace: PackageNamespace,
    serverId: string,
    toolName: string,
    enabled: boolean,
  ) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const input = { namespace, serverId, toolName }
      setMcpCatalog(
        enabled
          ? await window.aiOfficeAgent.disableMcpTool(input)
          : await window.aiOfficeAgent.enableMcpTool(input),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'mcp_tool_mutation_failed')
    } finally {
      setBusy(false)
    }
  }

  const statusText = provider
    ? zh
      ? {
          ready: '已就绪',
          needs_credentials: '需要在本机登录或配置密钥',
          checking: '正在检查',
          refreshing: '正在刷新登录',
          incompatible: '协议或能力不兼容',
          unavailable: '服务暂不可用',
          disabled: '已停用',
        }[provider.state]
      : provider.state.replaceAll('_', ' ')
    : zh
      ? '正在读取模型目录…'
      : 'Loading model catalog…'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form
        className="modal provider-credential-modal"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? '模型服务商凭据' : 'Model provider credential'}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (provider?.authMethods.includes('api_key')) void saveApiKey()
        }}
      >
        <h3>{zh ? '模型服务商' : 'Model provider'}</h3>
        <label className="provider-credential-field provider-credential-field-first">
          <span>{zh ? '服务商' : 'Provider'}</span>
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {catalog?.providers.map((item) => (
              <option key={item.providerId} value={item.providerId}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <p className="provider-credential-status" role="status">
          {statusText}
        </p>
        <label className="provider-credential-field">
          <span>{zh ? '对话模型' : 'Conversation model'}</span>
          <select
            value={selected ? `${selected.providerId}\0${selected.modelId}` : ''}
            disabled={busy}
            onChange={(event) => void selectModel(event.target.value)}
          >
            <option value="" disabled>
              {zh ? '请选择模型' : 'Choose a model'}
            </option>
            {catalog?.providers.flatMap((item) =>
              item.models.map((model) => (
                <option
                  key={`${item.providerId}/${model.modelId}`}
                  value={`${item.providerId}\0${model.modelId}`}
                >
                  {item.name} · {model.name}
                </option>
              )),
            )}
          </select>
        </label>
        <details className="provider-local-config">
          <summary>
            {zh ? '添加本地 OpenAI-compatible 服务' : 'Add local OpenAI-compatible service'}
          </summary>
          <label className="provider-credential-field">
            <span>{zh ? '服务商 ID' : 'Provider ID'}</span>
            <input
              value={localProviderId}
              spellCheck={false}
              onChange={(event) => setLocalProviderId(event.target.value)}
            />
          </label>
          <label className="provider-credential-field">
            <span>{zh ? '显示名称' : 'Display name'}</span>
            <input
              value={localProviderName}
              onChange={(event) => setLocalProviderName(event.target.value)}
            />
          </label>
          <label className="provider-credential-field">
            <span>{zh ? 'API 地址' : 'API endpoint'}</span>
            <input
              value={localBaseUrl}
              spellCheck={false}
              placeholder="http://127.0.0.1:11434/v1"
              onChange={(event) => setLocalBaseUrl(event.target.value)}
            />
          </label>
          <label className="provider-credential-field">
            <span>{zh ? '模型 ID' : 'Model ID'}</span>
            <input
              value={localModelId}
              spellCheck={false}
              onChange={(event) => setLocalModelId(event.target.value)}
            />
          </label>
          <label className="provider-credential-field">
            <span>{zh ? '模型名称' : 'Model name'}</span>
            <input
              value={localModelName}
              onChange={(event) => setLocalModelName(event.target.value)}
            />
          </label>
          <fieldset className="provider-local-capabilities">
            <legend>{zh ? '模型能力（显式声明）' : 'Model capabilities (explicit)'}</legend>
            {configurableCapabilities.map((capability) => (
              <label key={capability}>
                <input
                  type="checkbox"
                  checked={localCapabilities.includes(capability)}
                  onChange={() => toggleLocalCapability(capability)}
                />
                <span>{capability}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={
              busy ||
              !localProviderId ||
              !localProviderName ||
              !localBaseUrl ||
              !localModelId ||
              !localModelName ||
              localCapabilities.length === 0
            }
            onClick={configureLocalProvider}
          >
            {zh ? '保存本地服务' : 'Save local service'}
          </button>
        </details>
        <details className="provider-resource-catalog">
          <summary>{zh ? 'Agent 资源目录与项目授权' : 'Agent resources and project trust'}</summary>
          <p className="provider-credential-status">
            {zh ? '项目状态：' : 'Project state: '}
            {resourceCatalog?.projectState ?? (zh ? '正在读取…' : 'loading…')}
          </p>
          <div className="provider-resource-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={selectResourceProject}
            >
              {zh ? '选择项目目录' : 'Select project directory'}
            </button>
            {resourceCatalog?.projectState === 'untrusted' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void updateProjectTrust(true)}
              >
                {zh ? '信任此项目' : 'Trust this project'}
              </button>
            )}
            {resourceCatalog?.projectState === 'trusted' && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void updateProjectTrust(false)}
              >
                {zh ? '撤销项目授权' : 'Revoke project trust'}
              </button>
            )}
          </div>
          <div className="provider-resource-list">
            {resourceCatalog?.resources.length === 0 && (
              <p className="provider-credential-status">
                {zh ? '当前没有已发现的 Agent 资源。' : 'No Agent resources discovered.'}
              </p>
            )}
            {resourceCatalog?.resources.map((resource) => (
              <article key={resource.resourceKey} className="provider-resource-item">
                <strong>{resource.resourceId}</strong>
                <span>
                  {resource.kind} · {resource.namespace} · {resource.state}
                </span>
                <code>{resource.source}</code>
                <code>
                  {resource.contentSha256
                    ? `sha256:${resource.contentSha256}`
                    : zh
                      ? 'hash：授权后计算'
                      : 'hash: available after trust'}
                </code>
                <span>
                  {zh ? '修复动作：' : 'Repair action: '}
                  {resource.action}
                </span>
              </article>
            ))}
          </div>
        </details>
        <details className="provider-resource-catalog">
          <summary>{zh ? 'Pi Packages' : 'Pi Packages'}</summary>
          <p className="provider-credential-status">
            {zh
              ? '只接受本地目录、精确 npm 版本或固定 Git commit；本地路径不会显示在界面中。'
              : 'Only local directories, exact npm versions, or fixed Git commits are accepted. Local paths are never displayed.'}
          </p>
          <label className="provider-credential-field">
            <span>{zh ? '安装范围' : 'Scope'}</span>
            <select
              value={packageNamespace}
              onChange={(event) => setPackageNamespace(event.target.value as PackageNamespace)}
            >
              <option value="global">global</option>
              <option value="project" disabled={resourceCatalog?.projectState !== 'trusted'}>
                project
              </option>
            </select>
          </label>
          <label className="provider-credential-field">
            <span>Package ID</span>
            <input
              value={packageId}
              spellCheck={false}
              placeholder="safe-extension"
              onChange={(event) => setPackageId(event.target.value)}
            />
          </label>
          <div className="provider-resource-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !packageId}
              onClick={() => void installPackage('local')}
            >
              {zh ? '选择本地目录并安装' : 'Choose local directory'}
            </button>
          </div>
          <label className="provider-credential-field">
            <span>npm name</span>
            <input
              value={npmPackageName}
              spellCheck={false}
              onChange={(event) => setNpmPackageName(event.target.value)}
            />
          </label>
          <label className="provider-credential-field">
            <span>{zh ? '精确版本' : 'Exact version'}</span>
            <input
              value={npmPackageVersion}
              spellCheck={false}
              placeholder="1.2.3"
              onChange={(event) => setNpmPackageVersion(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !packageId || !npmPackageName || !npmPackageVersion}
            onClick={() => void installPackage('npm')}
          >
            {zh ? '安装固定 npm Package' : 'Install fixed npm package'}
          </button>
          <label className="provider-credential-field">
            <span>Git URL</span>
            <input
              value={gitPackageUrl}
              spellCheck={false}
              placeholder="https://example.com/owner/repo.git"
              onChange={(event) => setGitPackageUrl(event.target.value)}
            />
          </label>
          <label className="provider-credential-field">
            <span>{zh ? '完整 commit' : 'Full commit'}</span>
            <input
              value={gitPackageCommit}
              spellCheck={false}
              placeholder="40 hexadecimal characters"
              onChange={(event) => setGitPackageCommit(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !packageId || !gitPackageUrl || !gitPackageCommit}
            onClick={() => void installPackage('git')}
          >
            {zh ? '安装固定 Git Package' : 'Install fixed Git package'}
          </button>
          <div className="provider-resource-list">
            {packageCatalog?.packages
              .filter((item) => item.namespace === packageNamespace)
              .map((item) => (
                <article
                  key={`${item.namespace}/${item.packageId}`}
                  className="provider-resource-item"
                >
                  <strong>{item.packageId}</strong>
                  <span>
                    {item.namespace} · {item.status} · {item.license}
                  </span>
                  <code>{item.source}</code>
                  <code>sha256:{item.contentSha256}</code>
                  <span>
                    {item.capabilities.join(', ')} · {item.resourceCount}{' '}
                    {zh ? '个工具' : 'tool(s)'}
                  </span>
                  <div className="provider-resource-actions">
                    {item.status === 'activation_required' && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => void mutatePackage('activate', item.packageId)}
                      >
                        {zh ? '授权并激活' : 'Authorize and activate'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        void mutatePackage(item.enabled ? 'disable' : 'enable', item.packageId)
                      }
                    >
                      {item.enabled ? (zh ? '停用' : 'Disable') : zh ? '启用' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => void mutatePackage('uninstall', item.packageId)}
                    >
                      {zh ? '卸载' : 'Uninstall'}
                    </button>
                  </div>
                </article>
              ))}
          </div>
        </details>
        <details className="provider-resource-catalog">
          <summary>{zh ? 'MCP 服务与工具' : 'MCP servers and tools'}</summary>
          <p className="provider-credential-status">
            {zh
              ? '这里只显示脱敏状态。命令、参数、环境变量、凭据引用和进程信息只留在受信 Runtime。'
              : 'Only redacted state is shown. Commands, arguments, environment, credential references, and process details remain in the trusted Runtime.'}
          </p>
          <div className="provider-resource-list">
            {mcpCatalog?.servers.length === 0 && (
              <p className="provider-credential-status">
                {zh ? '当前没有已配置的 MCP 服务。' : 'No MCP servers configured.'}
              </p>
            )}
            {mcpCatalog?.servers.map((server) => (
              <article
                key={`${server.namespace}/${server.serverId}`}
                className="provider-resource-item"
              >
                <strong>{server.serverId}</strong>
                <span>
                  {server.namespace} ·{' '}
                  {{
                    disabled: zh ? '已停用' : 'Disabled',
                    activation_required: zh ? '等待授权激活' : 'Activation required',
                    connecting: zh ? '正在连接' : 'Connecting',
                    auth_required: zh ? '需要登录' : 'Sign-in required',
                    ready: zh ? '已就绪' : 'Ready',
                    degraded: zh ? '连接已降级' : 'Degraded',
                    failed: zh ? '连接失败' : 'Failed',
                    server_id_collision: zh ? '服务 ID 冲突' : 'Server ID collision',
                    tool_alias_collision: zh ? '工具别名冲突' : 'Tool alias collision',
                    needs_credentials: zh ? '需要凭据' : 'Credentials required',
                  }[server.state] ?? server.state}
                </span>
                <code>sha256:{server.contentSha256}</code>
                <div className="provider-resource-actions">
                  {server.action === 'activate' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void mutateMcp('activate', server.namespace, server.serverId)}
                    >
                      {zh ? '授权并激活' : 'Authorize and activate'}
                    </button>
                  )}
                  {server.action === 'enable' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => void mutateMcp('enable', server.namespace, server.serverId)}
                    >
                      {zh ? '启用' : 'Enable'}
                    </button>
                  )}
                  {server.action === 'disable' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => void mutateMcp('disable', server.namespace, server.serverId)}
                    >
                      {zh ? '停用并回收进程' : 'Disable and stop'}
                    </button>
                  )}
                  {server.action === 'retry' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => void mutateMcp('retry', server.namespace, server.serverId)}
                    >
                      {zh ? '重新连接' : 'Reconnect'}
                    </button>
                  )}
                  {server.action === 'login' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void loginMcp(
                          server.namespace,
                          server.serverId,
                          mcpLoginKey === `${server.namespace}/${server.serverId}`,
                        )
                      }
                    >
                      {mcpLoginKey === `${server.namespace}/${server.serverId}`
                        ? zh
                          ? '取消登录'
                          : 'Cancel sign-in'
                        : zh
                          ? '登录'
                          : 'Sign in'}
                    </button>
                  )}
                </div>
                {server.tools.map((tool) => (
                  <div key={tool.canonicalToolId} className="provider-resource-actions">
                    <code>{tool.modelAlias}</code>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        void toggleMcpTool(
                          server.namespace,
                          server.serverId,
                          tool.toolName,
                          tool.enabled,
                        )
                      }
                    >
                      {tool.enabled
                        ? zh
                          ? '停用工具'
                          : 'Disable tool'
                        : zh
                          ? '启用工具'
                          : 'Enable tool'}
                    </button>
                  </div>
                ))}
              </article>
            ))}
          </div>
        </details>
        {provider?.authMethods.includes('api_key') && (
          <>
            <label className="provider-credential-field">
              <span>{zh ? 'API 密钥（只写）' : 'API key (write-only)'}</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
              />
            </label>
            <fieldset className="provider-credential-modes">
              <legend>{zh ? '保存方式' : 'Storage'}</legend>
              <label>
                <input
                  type="radio"
                  name="provider-persistence"
                  checked={persistence === 'persistent'}
                  onChange={() => setPersistence('persistent')}
                />
                <span>{zh ? '系统安全存储' : 'Secure system storage'}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="provider-persistence"
                  checked={persistence === 'memory_only'}
                  onChange={() => setPersistence('memory_only')}
                />
                <span>{zh ? '仅本次运行，退出即失效' : 'This run only; cleared on exit'}</span>
              </label>
            </fieldset>
          </>
        )}
        {provider?.authMethods.includes('oauth') && (
          <div className="provider-oauth">
            {!oauth || oauth.state === 'failed' || oauth.state === 'cancelled' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={startOAuth}
              >
                {zh ? '使用 Codex 登录' : 'Sign in with Codex'}
              </button>
            ) : (
              <p className="provider-credential-status">
                {oauth.state === 'ready'
                  ? zh
                    ? '登录完成'
                    : 'Signed in'
                  : zh
                    ? '请在浏览器中完成登录'
                    : 'Complete sign-in in your browser'}
              </p>
            )}
            {oauth?.interaction?.type === 'device_code' && (
              <p className="provider-device-code">
                {zh ? '设备码：' : 'Device code: '}
                <strong>{oauth.interaction.userCode}</strong>
              </p>
            )}
            {oauth?.interaction?.type === 'prompt' && (
              <label className="provider-credential-field">
                <span>{zh ? '一次性响应' : 'One-time response'}</span>
                <input
                  type={oauth.interaction.promptType === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  value={oauthResponse}
                  placeholder={oauth.interaction.placeholder}
                  onChange={(event) => setOAuthResponse(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !oauthResponse}
                  onClick={respondOAuth}
                >
                  {zh ? '提交' : 'Submit'}
                </button>
              </label>
            )}
          </div>
        )}
        {error && (
          <p className="provider-credential-error">
            {error === 'secure_storage_unavailable'
              ? zh
                ? '当前系统没有可用的安全密钥库。请选择“仅本次运行”后重试。'
                : 'No secure credential backend is available. Choose “This run only” and retry.'
              : error.includes('model_provider')
                ? zh
                  ? '本地服务配置无效。请检查 ID、地址与模型能力。'
                  : 'The local provider configuration is invalid. Check its IDs, endpoint, and capabilities.'
                : error.includes('package_')
                  ? zh
                    ? `Package 操作失败：${error}`
                    : `Package operation failed: ${error}`
                  : zh
                    ? '凭据操作失败，请重试。'
                    : 'Credential operation failed. Please retry.'}
          </p>
        )}
        <div className="modal-buttons provider-credential-actions">
          {provider?.state === 'ready' && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={logout}>
              {zh ? '退出服务商' : 'Sign out provider'}
            </button>
          )}
          {oauth &&
            oauth.state !== 'ready' &&
            oauth.state !== 'failed' &&
            oauth.state !== 'cancelled' && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={cancelOAuth}
              >
                {zh ? '取消登录' : 'Cancel sign-in'}
              </button>
            )}
          <span className="provider-credential-action-spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {zh ? '关闭' : 'Close'}
          </button>
          {provider?.authMethods.includes('api_key') && (
            <button type="submit" className="btn btn-primary" disabled={busy || !apiKey}>
              {busy ? (zh ? '保存中…' : 'Saving…') : zh ? '保存' : 'Save'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function SettingsEntry() {
  const { lang, setLang, t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  // language flyout: opens on hover, fixed-position so it can escape the
  // sidebar's scroll container (same trick as the project row menu)
  const [langFly, setLangFly] = useState<{ left: number; bottom: number } | null>(null)
  const langRowRef = useRef<HTMLDivElement>(null)
  // grace period before the hover flyout closes: the pointer's diagonal path
  // from the row to the options crosses ground outside both elements
  const langCloseTimer = useRef<number | null>(null)
  // update-channel flyout: same hover/click/outside-scroll pattern as the language flyout
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable')
  const [chanFly, setChanFly] = useState<{ left: number; bottom: number } | null>(null)
  const chanRowRef = useRef<HTMLDivElement>(null)
  const chanCloseTimer = useRef<number | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const [mineruDialogOpen, setMineruDialogOpen] = useState(false)

  // Query the version once; the remaining settings read their live state when opened.
  useEffect(() => {
    let alive = true
    void window.aiOffice.getAppVersion?.().then((v) => {
      if (alive && v) setAppVersion(v)
    })
    return () => {
      alive = false
    }
  }, [])

  // close the menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target?.closest?.('.account-entry')) {
        setMenuOpen(false)
        setLangFly(null)
        setChanFly(null)
      }
    }
    window.addEventListener('pointerdown', handler)
    return () => window.removeEventListener('pointerdown', handler)
  }, [menuOpen])

  const closeMenu = () => {
    setMenuOpen(false)
    setLangFly(null)
    setChanFly(null)
  }

  const cancelLangFlyClose = () => {
    if (langCloseTimer.current !== null) {
      window.clearTimeout(langCloseTimer.current)
      langCloseTimer.current = null
    }
  }

  const openLangFly = () => {
    cancelLangFlyClose()
    const rect = langRowRef.current?.getBoundingClientRect()
    if (rect) setLangFly({ left: rect.right - 2, bottom: window.innerHeight - rect.bottom })
  }

  const scheduleLangFlyClose = () => {
    cancelLangFlyClose()
    langCloseTimer.current = window.setTimeout(() => setLangFly(null), 200)
  }

  // the fixed-position flyout would detach from its row on scroll — close it
  // (same rule as the project row menu); also drop any pending close timer
  useEffect(() => {
    if (!langFly) return
    const close = (event: Event) => {
      // the flyout scrolls its own options (max-height + overflow-y) — only
      // outside scrolls detach it from its row
      const target = event.target as Element | null
      if (target instanceof Element && target.closest('.lang-flyout')) return
      setLangFly(null)
    }
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('scroll', close, true)
      cancelLangFlyClose()
    }
  }, [langFly])

  const cancelChanFlyClose = () => {
    if (chanCloseTimer.current !== null) {
      window.clearTimeout(chanCloseTimer.current)
      chanCloseTimer.current = null
    }
  }

  const openChanFly = () => {
    cancelChanFlyClose()
    const rect = chanRowRef.current?.getBoundingClientRect()
    if (rect) setChanFly({ left: rect.right - 2, bottom: window.innerHeight - rect.bottom })
  }

  const scheduleChanFlyClose = () => {
    cancelChanFlyClose()
    chanCloseTimer.current = window.setTimeout(() => setChanFly(null), 200)
  }

  // same scroll-close rule as the language flyout: the fixed-position flyout
  // would otherwise detach from its row when the sidebar scrolls
  useEffect(() => {
    if (!chanFly) return
    const close = (event: Event) => {
      const target = event.target as Element | null
      if (target instanceof Element && target.closest('.lang-flyout')) return
      setChanFly(null)
    }
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('scroll', close, true)
      cancelChanFlyClose()
    }
  }, [chanFly])

  const handleClick = () => {
    setMenuOpen((v) => {
      if (!v) void window.aiOffice.getUpdateChannel().then(setChannel)
      return !v
    })
    setLangFly(null)
    setChanFly(null)
  }

  return (
    <div className="account-entry">
      {menuOpen && (
        <div className="account-menu" role="menu">
          <button
            className="account-menu-item"
            role="menuitem"
            onClick={() => {
              closeMenu()
              setProviderDialogOpen(true)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 8.2h10M8 3.2v10M4.4 4.6l7.2 7.2M11.6 4.6l-7.2 7.2"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </svg>
            <span>{lang === 'zh' || lang === 'zh-TW' ? '模型服务商' : 'Model provider'}</span>
          </button>
          <button
            className="account-menu-item"
            role="menuitem"
            onClick={() => {
              closeMenu()
              setMineruDialogOpen(true)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3 2.5h7l3 3v8H3zM10 2.5v3h3M5 9h6M5 11h4"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
            <span>{lang === 'zh' || lang === 'zh-TW' ? 'PDF 转 Word' : 'PDF to Word'}</span>
          </button>
          <div className="account-menu-divider" />
          <div
            className="lang-row-wrap"
            ref={langRowRef}
            onMouseEnter={openLangFly}
            onMouseLeave={scheduleLangFlyClose}
          >
            <button
              className="account-menu-item lang-row"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={!!langFly}
              onClick={openLangFly}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.2" />
                <ellipse cx="8" cy="8" rx="2.8" ry="6.3" stroke="currentColor" strokeWidth="1.1" />
                <path d="M2 5.9h12M2 10.1h12" stroke="currentColor" strokeWidth="1.1" />
              </svg>
              <span className="lang-row-label">{t('language')}</span>
              <span className="lang-row-current">
                {LANG_OPTIONS.find((opt) => opt.value === lang)?.label}
              </span>
              <svg
                className="lang-row-chevron"
                width="11"
                height="11"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path
                  d="M4.5 2.5l4 3.5-4 3.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
            {langFly && (
              <div
                className="lang-flyout"
                role="menu"
                style={{ left: langFly.left, bottom: langFly.bottom }}
              >
                {LANG_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    role="menuitemradio"
                    aria-checked={lang === opt.value}
                    className={`lang-menu-item${lang === opt.value ? ' active' : ''}`}
                    onClick={() => {
                      closeMenu()
                      if (lang !== opt.value) setLang(opt.value)
                    }}
                  >
                    {opt.label}
                    {lang === opt.value && (
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path
                          d="M2.5 6.2l2.4 2.4 4.6-5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            className="lang-row-wrap"
            ref={chanRowRef}
            onMouseEnter={openChanFly}
            onMouseLeave={scheduleChanFlyClose}
          >
            <button
              className="account-menu-item lang-row"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={!!chanFly}
              onClick={openChanFly}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 3v6.5a3 3 0 0 0 3 3h5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
                <circle cx="4" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.2" />
                <path
                  d="M9.8 10l2.4 2.5-2.4 2.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              <span className="lang-row-label">{t('updateChannel')}</span>
              <span className="lang-row-current">
                {t(channel === 'beta' ? 'channelBeta' : 'channelStable')}
              </span>
              <svg
                className="lang-row-chevron"
                width="11"
                height="11"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path
                  d="M4.5 2.5l4 3.5-4 3.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
            {chanFly && (
              <div
                className="lang-flyout"
                role="menu"
                style={{ left: chanFly.left, bottom: chanFly.bottom }}
              >
                {CHANNEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    role="menuitemradio"
                    aria-checked={channel === opt.value}
                    className={`lang-menu-item${channel === opt.value ? ' active' : ''}`}
                    onClick={() => {
                      closeMenu()
                      if (channel !== opt.value) {
                        setChannel(opt.value)
                        void window.aiOffice.setUpdateChannel(opt.value)
                      }
                    }}
                  >
                    {t(opt.labelKey)}
                    {channel === opt.value && (
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path
                          d="M2.5 6.2l2.4 2.4 4.6-5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {appVersion && (
            <div className="account-menu-version">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.2" />
                <path
                  d="M8 7.4v3.4"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
                <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
              </svg>
              <span className="version-row-label">{t('versionLabel')}</span>
              <span className="version-row-value">{appVersion}</span>
            </div>
          )}
        </div>
      )}
      {providerDialogOpen && (
        <ProviderCredentialDialog onClose={() => setProviderDialogOpen(false)} />
      )}
      {mineruDialogOpen && <MineruOcrDialog onClose={() => setMineruDialogOpen(false)} />}
      <button
        className="account-btn"
        onClick={handleClick}
        aria-expanded={menuOpen}
        title={lang === 'zh' || lang === 'zh-TW' ? '设置' : 'Settings'}
        aria-label={lang === 'zh' || lang === 'zh-TW' ? '设置' : 'Settings'}
      >
        <span className="account-avatar" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M8 1.7v1.5M8 12.8v1.5M1.7 8h1.5M12.8 8h1.5M3.55 3.55l1.06 1.06M11.39 11.39l1.06 1.06M12.45 3.55l-1.06 1.06M4.61 11.39l-1.06 1.06"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="account-text">
          <span className="account-name">
            {lang === 'zh' || lang === 'zh-TW' ? '设置' : 'Settings'}
          </span>
          <span className="account-sub">
            {lang === 'zh' || lang === 'zh-TW'
              ? '模型、资源与更新'
              : 'Models, resources, and updates'}
          </span>
        </span>
      </button>
    </div>
  )
}

// ── Main component ──────────────────────────────────────

export function Home() {
  const i18n = useI18n()
  const { t, lang } = i18n
  // ── Paged list state (rows loaded for the current view + filter) ──
  const [entries, setEntries] = useState<RecentEntry[]>([])
  /** total count under the current view + filter (not just the loaded rows) */
  const [listTotal, setListTotal] = useState(0)
  /** sidebar Recent / Starred counts under the active type filter */
  const [navCounts, setNavCounts] = useState({ recent: 0, starred: 0 })
  const [loadingMore, setLoadingMore] = useState(false)
  const [view, setView] = useState<'recent' | 'starred'>('recent')
  const [filter, setFilter] = useState('all')
  const [rowMenu, setRowMenu] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  const [greetAskKey] = useState(
    () => GREET_ASK_KEYS[Math.floor(Math.random() * GREET_ASK_KEYS.length)]!,
  )

  // ── Project state ──
  const [projects, setProjects] = useState<ProjectSummaryEntry[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  const projectMode = hasProjectApi()

  // ── Paged loading ──
  // stale responses are dropped via a request sequence number (when views/filters switch quickly)
  const requestSeq = useRef(0)
  const entriesLen = useRef(0)
  entriesLen.current = entries.length

  /** reload the list; keepCount keeps the loaded row count (refresh), otherwise back to page one */
  const reload = (keepCount: boolean) => {
    const seq = ++requestSeq.current
    const ext = filter === 'all' ? undefined : filter
    const limit = keepCount ? Math.max(entriesLen.current, PAGE_SIZE) : PAGE_SIZE
    const primary = view === 'recent' ? window.aiOffice.recents : window.aiOffice.starred
    const secondary = view === 'recent' ? window.aiOffice.starred : window.aiOffice.recents
    void primary({ offset: 0, limit, ext }).then((page) => {
      if (seq !== requestSeq.current) return
      setEntries(page.entries)
      setListTotal(page.total)
      setNavCounts((prev) =>
        view === 'recent'
          ? { ...prev, recent: visiblePageCount(page) }
          : { ...prev, starred: visiblePageCount(page) },
      )
    })
    // The other view fetches only its count under the same active filter.
    void secondary({ offset: 0, limit: 0, ext }).then((page) => {
      if (seq !== requestSeq.current) return
      setNavCounts((prev) =>
        view === 'recent'
          ? { ...prev, starred: visiblePageCount(page) }
          : { ...prev, recent: visiblePageCount(page) },
      )
    })
    if (projectMode) {
      void window.aiOfficeProject!.listProjects().then(setProjects)
    }
  }
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  // refresh signal for project-view data (re-pull file stats after file changes)
  const [projectTick, setProjectTick] = useState(0)

  const refresh = () => {
    reloadRef.current(true)
    setProjectTick((n) => n + 1)
  }

  useEffect(() => {
    reloadRef.current(false)
  }, [view, filter])

  useEffect(() => {
    const onFocus = () => {
      reloadRef.current(true)
      setProjectTick((n) => n + 1)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const hasMore = entries.length < listTotal

  const loadMore = () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const seq = requestSeq.current
    const ext = filter === 'all' ? undefined : filter
    const api = view === 'recent' ? window.aiOffice.recents : window.aiOffice.starred
    void api({ offset: entriesLen.current, limit: PAGE_SIZE, ext }).then((page) => {
      setLoadingMore(false)
      if (seq !== requestSeq.current) return
      setEntries((prev) => [...prev, ...page.entries])
      setListTotal(page.total)
    })
  }
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore

  // Load the next page once the bottom sentinel enters the viewport (240px early);
  // depending on entries.length rebuilds the observer after each page — observe fires an immediate
  // callback, so while the sentinel stays in view we keep loading until full or exhausted
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) loadMoreRef.current()
      },
      { rootMargin: '240px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, entries.length])

  useEffect(() => {
    if (rowMenu === null && confirmDelete === null) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (rowMenu !== null && !target?.closest?.('.recent-actions')) setRowMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRowMenu(null)
        setConfirmDelete(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [rowMenu, confirmDelete])

  // ── Project files state ────────────────────────────────

  const [projectFileEntries, setProjectFileEntries] = useState<RecentEntry[]>([])
  const [moveFileMenu, setMoveFileMenu] = useState<string | null>(null)
  // submenu opens rightward by default; flips left when the window edge is too close
  const [moveMenuFlip, setMoveMenuFlip] = useState(false)
  // hover-open/close delays: avoid flashing the submenu while the pointer passes
  // through, and keep it open while crossing the 4px gap into it
  const moveMenuTimers = useRef<{ open: number | null; close: number | null }>({
    open: null,
    close: null,
  })

  const openMoveMenu = (path: string) => {
    setMoveMenuFlip(false)
    setMoveFileMenu(path)
  }

  // ref runs pre-paint, so measuring the real width (long project names exceed
  // the min-width) and flipping never flashes; once flipped the check no longer hits
  const measureSubmenu = (el: HTMLDivElement | null) => {
    if (el && el.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
      setMoveMenuFlip(true)
    }
  }

  const clearMoveMenuTimer = (kind: 'open' | 'close') => {
    const timers = moveMenuTimers.current
    if (timers[kind] !== null) {
      window.clearTimeout(timers[kind])
      timers[kind] = null
    }
  }
  const [bulkMoveMenu, setBulkMoveMenu] = useState(false)

  useEffect(() => {
    if (!projectMode || !selectedProjectId) {
      setProjectFileEntries([])
      return
    }
    let active = true
    const api = window.aiOfficeProject!
    void api.listFiles(selectedProjectId).then(async (paths) => {
      const stats = await window.aiOffice.statPaths(paths)
      if (!active) return
      setProjectFileEntries(stats.sort((a, b) => b.mtimeMs - a.mtimeMs))
    })
    return () => {
      active = false
    }
  }, [projectMode, selectedProjectId, projectTick])

  // the submenu lives inside the row menu: when that closes, drop the stale
  // submenu state and any pending hover timers so it doesn't reopen expanded
  useEffect(() => {
    if (rowMenu === null) {
      clearMoveMenuTimer('open')
      clearMoveMenuTimer('close')
      setMoveFileMenu(null)
    }
  }, [rowMenu])

  // close the move-file menu
  useEffect(() => {
    if (!moveFileMenu) return
    const handler = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target?.closest?.('.move-menu-wrap')) setMoveFileMenu(null)
    }
    window.addEventListener('pointerdown', handler)
    return () => window.removeEventListener('pointerdown', handler)
  }, [moveFileMenu])

  // close the bulk move-to-project menu in the selection bar
  useEffect(() => {
    if (!bulkMoveMenu) return
    const handler = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target?.closest?.('.selection-move-wrap')) setBulkMoveMenu(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBulkMoveMenu(false)
    }
    window.addEventListener('pointerdown', handler)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handler)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [bulkMoveMenu])

  // ── Plain view (no project selected): filtering runs in the main process; entries is the visible list ──
  const selectedPaths = entries.filter((e) => selected.has(e.path)).map((e) => e.path)
  const allSelected = entries.length > 0 && selectedPaths.length === entries.length

  // project view shares the same `selected` set (keyed by path)
  const projSelectedPaths = projectFileEntries
    .filter((e) => selected.has(e.path))
    .map((e) => e.path)
  const projAllSelected =
    projectFileEntries.length > 0 && projSelectedPaths.length === projectFileEntries.length

  const changeView = (next: 'recent' | 'starred') => {
    setView(next)
    setSelected(new Set())
    setRowMenu(null)
  }

  const changeFilter = (key: string) => {
    setFilter(key)
    setSelected(new Set())
    setRowMenu(null)
  }

  const toggleSelect = (path: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.path)))
  }

  const toggleSelectAllProject = () => {
    setSelected(projAllSelected ? new Set() : new Set(projectFileEntries.map((e) => e.path)))
  }

  const toggleStar = (path: string) => {
    void window.aiOffice.toggleStar(path).then(refresh)
  }

  const removeRecent = (paths: string[]) => {
    setRowMenu(null)
    setSelected(new Set())
    void window.aiOffice.removeRecent(paths).then(refresh)
  }

  const deleteFiles = (paths: string[]) => {
    setRowMenu(null)
    setConfirmDelete(paths)
  }

  const confirmDeleteNow = () => {
    const paths = confirmDelete ?? []
    setConfirmDelete(null)
    setSelected(new Set())
    void window.aiOffice.deleteFiles(paths).then(refresh)
  }

  const duplicateFile = (path: string) => {
    setRowMenu(null)
    void window.aiOffice.duplicateFile(path).then(refresh)
  }

  const startRename = (entry: RecentEntry) => {
    setRowMenu(null)
    setRenaming({ path: entry.path, value: baseName(entry) })
  }

  const commitRename = (entry: RecentEntry) => {
    const value = renaming?.value.trim() ?? ''
    setRenaming(null)
    if (!value || value === baseName(entry)) return
    const newName = entry.ext ? `${value}.${entry.ext}` : value
    void window.aiOffice.renameFile(entry.path, newName).then((result) => {
      if (!result.ok) window.alert(result.error ?? t('renameFailed'))
      refresh()
    })
  }

  const moveFileTo = async (filePath: string, targetProjectId: string) => {
    setMoveFileMenu(null)
    setRowMenu(null)
    await window.aiOfficeProject?.moveFile(filePath, targetProjectId)
    refresh()
    if (selectedProjectId) {
      setProjectFileEntries((prev) => prev.filter((e) => e.path !== filePath))
    }
  }

  const moveFilesTo = async (paths: string[], targetProjectId: string) => {
    setBulkMoveMenu(false)
    setSelected(new Set())
    // drop moved rows immediately (same as moveFileTo) so they cannot be
    // re-selected or re-moved while the sequential IPC loop is in flight
    const moved = new Set(paths)
    setProjectFileEntries((prev) => prev.filter((e) => !moved.has(e.path)))
    for (const path of paths) {
      await window.aiOfficeProject?.moveFile(path, targetProjectId)
    }
    refresh()
  }

  // ── New file (passes projectId when a project is selected) ──
  const handleNewDoc = () => {
    void window.aiOffice.newDoc(selectedProjectId ? { projectId: selectedProjectId } : undefined)
  }

  const handleNewSheet = () => {
    void window.aiOffice.newSheet(selectedProjectId ? { projectId: selectedProjectId } : undefined)
  }

  const handleNewSlide = () => {
    void window.aiOffice.newSlide(selectedProjectId ? { projectId: selectedProjectId } : undefined)
  }

  const NEW_ITEMS = [
    { ext: 'docx', title: t('newDoc'), sub: '.docx', action: handleNewDoc },
    { ext: 'xlsx', title: t('newSheet'), sub: '.xlsx', action: handleNewSheet },
    { ext: 'pptx', title: t('newSlide'), sub: '.pptx', action: handleNewSlide },
  ]

  function renderQuickCards() {
    return (
      <div className="quick-cards">
        {NEW_ITEMS.map((item) => (
          <button key={item.ext} className="quick-card" onClick={() => void item.action()}>
            <FileBadge ext={item.ext} size={30} />
            <span className="quick-text">
              <span className="quick-title-row">
                <span className="quick-title">{item.title}</span>
                <span className="ai-chip">AI</span>
              </span>
              <span className="quick-sub">{item.sub}</span>
            </span>
          </button>
        ))}
        <button className="quick-card" onClick={() => void window.aiOffice.browse()}>
          <span className="quick-folder">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1c.44 0 .85.19 1.13.52L8.4 4.4H13A1.5 1.5 0 0 1 14.5 5.9v5.6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V4z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="quick-text">
            <span className="quick-title-row">
              <span className="quick-title">{t('openLocal')}</span>
            </span>
            <span className="quick-sub">.docx / .xlsx / .xls / .csv / .pptx / .pdf</span>
          </span>
        </button>
      </div>
    )
  }

  // ── File row rendering (shared by the plain view and the project files view) ──

  function renderFileRow(entry: RecentEntry, context: 'global' | 'project') {
    const isRenaming = renaming?.path === entry.path
    const otherProjects = projects.filter(
      (p) => p.id !== (context === 'project' ? selectedProjectId : undefined),
    )
    return (
      <li className="recent-row" key={entry.path}>
        <div
          className="recent-item"
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isRenaming) void window.aiOffice.openPath(entry.path)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target === event.currentTarget) {
              void window.aiOffice.openPath(entry.path)
            }
          }}
        >
          <span className="col-check" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              className="row-check"
              checked={selected.has(entry.path)}
              onChange={(event) => toggleSelect(entry.path, event.target.checked)}
              aria-label={t('selectFile', { name: entry.name })}
            />
          </span>
          <span className="recent-icon">
            <FileBadge ext={entry.ext} size={24} />
          </span>
          {isRenaming ? (
            <input
              className="rename-input"
              value={renaming.value}
              autoFocus
              onFocus={(event) => event.target.select()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setRenaming({ path: entry.path, value: event.target.value })}
              onBlur={() => commitRename(entry)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') commitRename(entry)
                if (event.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <span className="recent-name">{entry.name}</span>
          )}
          <span className="recent-path">{parentDir(entry.path)}</span>
          <span className="recent-time">{formatModified(entry.mtimeMs, i18n)}</span>
          <span className="recent-size">{formatSize(entry.sizeBytes)}</span>
          <button
            className={`star-btn${entry.starred ? ' starred' : ''}`}
            aria-label={entry.starred ? t('unstar') : t('star')}
            onClick={(event) => {
              event.stopPropagation()
              toggleStar(entry.path)
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 1.9l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.6l-3.8 2 .72-4.23-3.07-3 4.25-.62z"
                fill={entry.starred ? '#f5a623' : 'none'}
                stroke={entry.starred ? '#f5a623' : 'currentColor'}
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="recent-actions" onClick={(event) => event.stopPropagation()}>
            <button
              className="more-btn"
              aria-label={t('moreActions')}
              aria-expanded={rowMenu === entry.path}
              onClick={() => setRowMenu(rowMenu === entry.path ? null : entry.path)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="3.2" cy="8" r="1.4" fill="currentColor" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                <circle cx="12.8" cy="8" r="1.4" fill="currentColor" />
              </svg>
            </button>
            {rowMenu === entry.path && (
              <div className="row-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null)
                    void window.aiOffice.openPath(entry.path)
                  }}
                >
                  {t('open')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null)
                    void window.aiOffice.revealPath(entry.path)
                  }}
                >
                  {t('revealInFolder')}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null)
                    void navigator.clipboard.writeText(entry.path)
                  }}
                >
                  {t('copyPath')}
                </button>
                {projectMode && otherProjects.length > 0 && (
                  <>
                    <div className="row-menu-divider" />
                    <div
                      className="move-menu-wrap"
                      onMouseEnter={() => {
                        clearMoveMenuTimer('close')
                        if (moveFileMenu === entry.path) return
                        clearMoveMenuTimer('open')
                        moveMenuTimers.current.open = window.setTimeout(
                          () => openMoveMenu(entry.path),
                          160,
                        )
                      }}
                      onMouseLeave={() => {
                        clearMoveMenuTimer('open')
                        clearMoveMenuTimer('close')
                        moveMenuTimers.current.close = window.setTimeout(
                          () => setMoveFileMenu(null),
                          140,
                        )
                      }}
                    >
                      <button
                        role="menuitem"
                        className="submenu-trigger"
                        onClick={(e) => {
                          e.stopPropagation()
                          clearMoveMenuTimer('open')
                          clearMoveMenuTimer('close')
                          if (moveFileMenu === entry.path) setMoveFileMenu(null)
                          else openMoveMenu(entry.path)
                        }}
                      >
                        {t('moveToProject')}
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 12 12"
                          aria-hidden="true"
                          style={{ marginLeft: 'auto' }}
                        >
                          <path
                            d="M4.5 2.5l4 3.5-4 3.5"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                            fill="none"
                          />
                        </svg>
                      </button>
                      {moveFileMenu === entry.path && (
                        <div
                          className={`submenu${moveMenuFlip ? ' submenu-left' : ''}`}
                          role="menu"
                          ref={measureSubmenu}
                        >
                          {otherProjects.map((p) => (
                            <button
                              key={p.id}
                              role="menuitem"
                              onClick={() => void moveFileTo(entry.path, p.id)}
                            >
                              {p.isDefault ? t('defaultProject') : p.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
                <div className="row-menu-divider" />
                <button role="menuitem" onClick={() => startRename(entry)}>
                  {t('rename')}
                </button>
                <button role="menuitem" onClick={() => duplicateFile(entry.path)}>
                  {t('duplicate')}
                </button>
                {context === 'global' && selectedPaths.length === 0 && (
                  <>
                    <div className="row-menu-divider" />
                    <button role="menuitem" onClick={() => removeRecent([entry.path])}>
                      {t('removeFromList')}
                    </button>
                    <button
                      role="menuitem"
                      className="danger"
                      onClick={() => deleteFiles([entry.path])}
                    >
                      {t('deleteFiles')}
                    </button>
                  </>
                )}
              </div>
            )}
          </span>
        </div>
      </li>
    )
  }

  // ── Project files view ────────────────────────────────

  function renderProjectContent() {
    const proj = projects.find((p) => p.id === selectedProjectId)
    if (!proj) return null
    const otherProjects = projects.filter((p) => p.id !== proj.id)

    return (
      <main className="content">
        <section className="quick-start" aria-label={t('secQuickStart')}>
          <div className="section-head">
            <span className="section-label">{t('secQuickStart')}</span>
          </div>
          {renderQuickCards()}
        </section>

        <section className="recents" aria-label={t('secProjectFiles')}>
          <div className="recents-toolbar">
            <div className="recents-heading">
              <span className="section-label">{t('secProjectFiles')}</span>
              <span className="file-count">
                {t(fileCountKey(projectFileEntries.length), { n: projectFileEntries.length })}
              </span>
            </div>
            {projSelectedPaths.length > 0 && (
              <div className="selection-bar">
                <span className="selection-count">
                  {t('selectedCount', { n: projSelectedPaths.length })}
                </span>
                {otherProjects.length > 0 && (
                  <span className="selection-move-wrap">
                    <button
                      className="selection-action"
                      aria-expanded={bulkMoveMenu}
                      onClick={() => setBulkMoveMenu((open) => !open)}
                    >
                      {t('moveToProject')}
                    </button>
                    {bulkMoveMenu && (
                      <div className="selection-move-menu" role="menu">
                        {otherProjects.map((p) => (
                          <button
                            key={p.id}
                            role="menuitem"
                            onClick={() => void moveFilesTo(projSelectedPaths, p.id)}
                          >
                            {p.isDefault ? t('defaultProject') : p.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                )}
                <button
                  className="selection-action danger"
                  onClick={() => deleteFiles(projSelectedPaths)}
                >
                  {t('deleteFiles')}
                </button>
                <button className="selection-action" onClick={() => setSelected(new Set())}>
                  {t('cancel')}
                </button>
              </div>
            )}
          </div>

          {projectFileEntries.length === 0 ? (
            <p className="empty proj-empty">
              <svg
                className="proj-empty-icon"
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6.29297 3.75H14.1729C14.4927 3.75 14.7979 3.88392 15.0146 4.11914L18.5566 7.96387C18.7512 8.17512 18.8593 8.45208 18.8594 8.73926V19.1055C18.8593 19.7376 18.346 20.25 17.7139 20.25H6.29297C5.66091 20.2499 5.14855 19.7375 5.14844 19.1055V4.89453C5.14855 4.26247 5.66091 3.75011 6.29297 3.75Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M13.8984 4V7.11C13.8984 8.15382 14.7446 9 15.7884 9H18.8984"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
              <span className="empty-hint">{t('projEmptyHint')}</span>
            </p>
          ) : (
            <div className="recent-table">
              <div className="recent-columns">
                <span className="col-check">
                  <input
                    type="checkbox"
                    checked={projAllSelected}
                    onChange={toggleSelectAllProject}
                    aria-label={t('selectAll')}
                  />
                </span>
                <span className="col-name">{t('colName')}</span>
                <span>{t('colLocation')}</span>
                <span>{t('colModified')}</span>
                <span className="col-size">{t('colSize')}</span>
                <span />
                <span />
              </div>
              <ul className="recent-list">
                {projectFileEntries.map((entry) => renderFileRow(entry, 'project'))}
              </ul>
            </div>
          )}
        </section>
      </main>
    )
  }

  // ── Plain view ────────────────────────────────────────

  function renderGlobalContent() {
    const now = new Date()
    const hour = now.getHours()
    const greetKey =
      hour < 6
        ? 'greetEvening'
        : hour < 12
          ? 'greetMorning'
          : hour < 18
            ? 'greetAfternoon'
            : 'greetEvening'
    const cjk = lang === 'zh' || lang === 'zh-TW' || lang === 'ja'
    const greeting = `${t(greetKey)}${cjk ? '。' : '. '}`
    return (
      <main className="content">
        <section className="quick-start" aria-label={t('secQuickStart')}>
          <div className="home-hero">
            <h1 className="hero-title">
              {greeting}
              <span className="hero-ask">{t(greetAskKey)}</span>
            </h1>
          </div>
          {renderQuickCards()}
        </section>

        <section
          className="recents"
          aria-label={view === 'recent' ? t('secRecent') : t('secStarred')}
        >
          <div className="recents-toolbar">
            <div className="recents-heading">
              <span className="section-label">
                {view === 'recent' ? t('secRecent') : t('secStarred')}
              </span>
              <span className="file-count">{t(fileCountKey(listTotal), { n: listTotal })}</span>
            </div>
            {selectedPaths.length > 0 ? (
              <div className="selection-bar">
                <span className="selection-count">
                  {t('selectedCount', { n: selectedPaths.length })}
                </span>
                <button className="selection-action" onClick={() => removeRecent(selectedPaths)}>
                  {t('removeFromList')}
                </button>
                <button
                  className="selection-action danger"
                  onClick={() => deleteFiles(selectedPaths)}
                >
                  {t('deleteFiles')}
                </button>
                <button className="selection-action" onClick={() => setSelected(new Set())}>
                  {t('cancel')}
                </button>
              </div>
            ) : (
              <div className="filter-pills" role="tablist" aria-label={t('filterAria')}>
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    className={`filter-pill${filter === f.key ? ' active' : ''}`}
                    onClick={() => changeFilter(f.key)}
                  >
                    {t(f.label)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="empty proj-empty">
              <svg
                className="proj-empty-icon"
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6.29297 3.75H14.1729C14.4927 3.75 14.7979 3.88392 15.0146 4.11914L18.5566 7.96387C18.7512 8.17512 18.8593 8.45208 18.8594 8.73926V19.1055C18.8593 19.7376 18.346 20.25 17.7139 20.25H6.29297C5.66091 20.2499 5.14855 19.7375 5.14844 19.1055V4.89453C5.14855 4.26247 5.66091 3.75011 6.29297 3.75Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M13.8984 4V7.11C13.8984 8.15382 14.7446 9 15.7884 9H18.8984"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
              <span className="empty-hint">
                {view === 'starred'
                  ? t('emptyStarred')
                  : navCounts.recent === 0
                    ? t('emptyRecent')
                    : t('emptyFiltered')}
              </span>
            </p>
          ) : (
            <div className={`recent-table${selectedPaths.length > 0 ? ' has-selection' : ''}`}>
              <div className="recent-columns">
                <span className="col-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label={t('selectAll')}
                  />
                </span>
                <span className="col-name">{t('colName')}</span>
                <span>{t('colLocation')}</span>
                <span>{t('colModified')}</span>
                <span className="col-size">{t('colSize')}</span>
                <span />
                <span />
              </div>
              <ul className="recent-list">
                {entries.map((entry) => renderFileRow(entry, 'global'))}
              </ul>
              {hasMore && (
                <div ref={sentinelRef} className="load-more" aria-hidden="true">
                  <span className="load-more-spinner" />
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    )
  }

  return (
    <div className="home">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <img className="logo-lockup" src={logoLockup} alt="GenOffice" />
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-item${view === 'recent' && !selectedProjectId ? ' active' : ''}`}
            onClick={() => {
              changeView('recent')
              setSelectedProjectId(null)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M8 4.8V8l2.2 1.6"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            <span className="nav-label">{t('navRecent')}</span>
            <span className="nav-count">{navCounts.recent}</span>
          </button>
          <button
            className={`nav-item${view === 'starred' && !selectedProjectId ? ' active' : ''}`}
            onClick={() => {
              changeView('starred')
              setSelectedProjectId(null)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1.9l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.6l-3.8 2 .72-4.23-3.07-3 4.25-.62z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
            <span className="nav-label">{t('navStarred')}</span>
            <span className="nav-count">{navCounts.starred}</span>
          </button>
        </nav>

        {/* project sidebar */}
        {projectMode && (
          <>
            <div className="sidebar-divider" />
            <ProjectPanel
              projects={projects}
              selectedId={selectedProjectId}
              onSelect={(id) => {
                setSelectedProjectId(id)
                // reset list-selection state on any project switch (paths are
                // shared between the plain view and project views)
                setSelected(new Set())
                setRowMenu(null)
              }}
              onRefresh={refresh}
            />
          </>
        )}

        <SettingsEntry />
      </aside>

      {selectedProjectId ? renderProjectContent() : renderGlobalContent()}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('deleteModalTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{t('deleteModalTitle')}</h3>
            <p>
              {confirmDelete.length === 1
                ? t('deleteConfirmOne', { name: fileName(confirmDelete[0]) })
                : t('deleteConfirmMany', { n: confirmDelete.length })}
            </p>
            {confirmDelete.length > 1 && (
              <ul className="modal-file-list">
                {confirmDelete.slice(0, 6).map((p) => (
                  <li key={p}>{fileName(p)}</li>
                ))}
                {confirmDelete.length > 6 && (
                  <li>{t('deleteMoreCount', { n: confirmDelete.length })}</li>
                )}
              </ul>
            )}
            <div className="modal-buttons">
              <button
                className="btn btn-secondary"
                autoFocus
                onClick={() => setConfirmDelete(null)}
              >
                {t('cancel')}
              </button>
              <button className="btn btn-danger" onClick={confirmDeleteNow}>
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
