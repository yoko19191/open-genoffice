import type { RuntimeHealthProjection } from '@genoffice/agent-runtime-protocol'
import {
  initializeAgentResourceHome,
  runLegacyAgentCleanup,
  type InitializeAgentResourceHomeOptions,
  type LegacyCleanupReport,
  type RunLegacyAgentCleanupOptions,
} from '@genoffice/agent-resource'

export type LegacyCleanupAuditRecord = Readonly<{
  event: 'legacy_agent_cleanup'
  status: 'completed' | 'incomplete'
  results: LegacyCleanupReport['results']
}>

export type LegacyCleanupStartupOptions = Readonly<{
  resourceHome: string
  userData: string
  legacyHome: string
  platform: NodeJS.Platform
  runtimeVersion: string
  audit?: (record: LegacyCleanupAuditRecord) => void
}>

export type LegacyCleanupStartupDependencies = Readonly<{
  initializeResourceHome?: (options: InitializeAgentResourceHomeOptions) => Promise<unknown>
  cleanup?: (options: RunLegacyAgentCleanupOptions) => Promise<LegacyCleanupReport>
}>

export class LegacyCleanupStartup {
  private runPromise: Promise<void> | undefined
  private incomplete = false

  constructor(
    private readonly options: LegacyCleanupStartupOptions,
    private readonly dependencies: LegacyCleanupStartupDependencies = {},
  ) {}

  run(): Promise<void> {
    this.runPromise ??= this.execute()
    return this.runPromise
  }

  projectHealth(health: RuntimeHealthProjection): RuntimeHealthProjection {
    if (!this.incomplete || health.state !== 'ready') return health
    return Object.freeze({ ...health, diagnosticCode: 'legacy_cleanup_incomplete' })
  }

  private async execute(): Promise<void> {
    let record: LegacyCleanupAuditRecord
    try {
      await (this.dependencies.initializeResourceHome ?? initializeAgentResourceHome)({
        rootDirectory: this.options.resourceHome,
        runtimeVersion: this.options.runtimeVersion,
        platform: this.options.platform,
      })
      const report = await (this.dependencies.cleanup ?? runLegacyAgentCleanup)({
        resourceHome: this.options.resourceHome,
        userData: this.options.userData,
        legacyGenoffice: this.options.legacyHome,
        platform: this.options.platform,
      })
      this.incomplete = report.status === 'incomplete'
      record = Object.freeze({
        event: 'legacy_agent_cleanup',
        status: report.status,
        results: report.results,
      })
    } catch {
      this.incomplete = true
      record = Object.freeze({
        event: 'legacy_agent_cleanup',
        status: 'incomplete',
        results: Object.freeze([]),
      })
    }
    try {
      this.options.audit?.(record)
    } catch {
      // Diagnostics must never block the cleanup gate or expose sink details.
    }
  }
}
