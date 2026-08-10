const forbiddenUiPattern = /genspark|@genspark|gsk_|credits?/i

export function packageShellLaunchTimeout(platform) {
  return platform === 'win32' ? 60_000 : 30_000
}

export function packageShellShutdownTimeout(platform) {
  return platform === 'win32' ? 60_000 : 15_000
}

export function packageShellLaunchStrategy(platform) {
  return platform === 'win32' ? 'audit-http' : 'electron'
}

export function packageShellLaunchArgs(platform, userData) {
  return platform === 'win32'
    ? [`--user-data-dir=${userData}`]
    : platform === 'linux'
      ? ['--no-sandbox']
      : []
}

export function parsePackageAuditEndpoint(value) {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('package_shell_audit_endpoint_invalid')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Number.isInteger(parsed.port) ||
    parsed.port < 1 ||
    parsed.port > 65_535 ||
    Object.keys(parsed).sort().join(',') !== 'port,schemaVersion'
  ) {
    throw new Error('package_shell_audit_endpoint_invalid')
  }
  return parsed.port
}

export function validatePackageShellSmoke(input) {
  if (input.installed !== true) throw new Error('package_shell_not_installed')
  if (input.userDataIsolated !== true) throw new Error('package_shell_user_data_invalid')
  if (input.resourceHomeIsolated !== true) throw new Error('package_shell_resource_home_invalid')
  if (input.health?.state !== 'ready') throw new Error('package_shell_runtime_not_ready')
  if (
    !Array.isArray(input.quickActions) ||
    input.quickActions.length < 4 ||
    input.quickActions.some((action) => action.disabled === true || !action.label)
  )
    throw new Error('package_shell_routes_invalid')
  if (forbiddenUiPattern.test(input.bodyText ?? ''))
    throw new Error('package_shell_retired_vendor_ui_present')
  if (input.mineru?.enabled !== false) throw new Error('package_shell_mineru_default_invalid')
  if (
    !Array.isArray(input.models?.providers) ||
    input.models.providers.some((provider) =>
      ['ready', 'checking', 'refreshing'].includes(provider.state),
    )
  )
    throw new Error('package_shell_model_default_invalid')
  if (
    !Array.isArray(input.mcp?.servers) ||
    input.mcp.servers.some((server) => ['ready', 'connecting'].includes(server.state))
  )
    throw new Error('package_shell_mcp_default_invalid')
  if (
    !Array.isArray(input.packages?.packages) ||
    input.packages.packages.some((item) => item.enabled)
  )
    throw new Error('package_shell_package_default_invalid')
  if (input.resources?.projectState !== 'none')
    throw new Error('package_shell_project_default_invalid')
  if (
    !Array.isArray(input.homeEntries) ||
    input.homeEntries.some((entry) => ['.pi', '.codex', '.mcp.json'].includes(entry)) ||
    !input.homeEntries.includes('.open-genoffice')
  )
    throw new Error('package_shell_home_invalid')
  if (
    !Array.isArray(input.networkEvents) ||
    !input.networkEvents.some((event) => event.kind === 'instrumented') ||
    input.networkEvents.some((event) => event.kind === 'network_attempt')
  )
    throw new Error('package_shell_network_invalid')
  if (input.shutdownCompleted !== true) throw new Error('package_shell_shutdown_invalid')

  return {
    status: 'passed',
    installed: true,
    firstLaunch: true,
    runtimeState: input.health.state,
    cleanHome: true,
    userDataIsolated: true,
    defaults: {
      mineruEnabled: false,
      activeModelProviders: 0,
      activeMcpServers: 0,
      enabledPackages: 0,
      projectState: 'none',
    },
    ui: {
      quickActions: input.quickActions.map((action) => action.label),
      retiredVendorMatches: 0,
      screenshotSha256: input.screenshotSha256,
    },
    network: {
      instrumentedProcesses: new Set(
        input.networkEvents
          .filter((event) => event.kind === 'instrumented')
          .map((event) => event.pid),
      ).size,
      attempts: 0,
    },
    shutdown: { completed: true },
  }
}
