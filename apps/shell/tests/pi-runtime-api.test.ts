import { describe, expect, it } from 'vitest'
import {
  PI_RUNTIME_CHANNELS,
  asPiRuntimeHealth,
  asProviderId,
  asProviderCredentialInput,
  asProviderCredentialStatus,
  asModelCatalog,
  asMcpCatalog,
  asMcpMutationInput,
  asMcpToolMutationInput,
  asModelSelectInput,
  asModelProviderConfigurationInput,
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
} from '../src/shared/pi-runtime-api'

describe('typed Pi Runtime preload health contract', () => {
  it('accepts the narrow projection and fails closed on leaked or malformed fields', () => {
    const ready = {
      state: 'ready',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      schemaVersion: '1',
    }
    expect(asPiRuntimeHealth(ready)).toEqual(ready)
    expect(asPiRuntimeHealth({ ...ready, endpoint: '/private/runtime.sock' })).toMatchObject({
      state: 'unavailable',
      diagnosticCode: 'runtime_bundle_unavailable',
    })
    expect(asPiRuntimeHealth(null)).toMatchObject({ state: 'unavailable' })
    expect(Object.isFrozen(asPiRuntimeHealth(null))).toBe(true)
    expect(PI_RUNTIME_CHANNELS.health).toBe('pi-runtime:health')
  })

  it('accepts an exact write-only API-key input and rejects shape drift', () => {
    const input = {
      providerId: 'openai',
      persistence: 'memory_only',
      apiKey: 'renderer-write-only-canary',
    } as const
    expect(asProviderCredentialInput(input)).toEqual(input)
    expect(Object.isFrozen(asProviderCredentialInput(input))).toBe(true)
    expect(() => asProviderCredentialInput({ ...input, credential: 'readable' })).toThrowError(
      'provider_credential_input_invalid',
    )
    expect(() =>
      asProviderCredentialInput({ ...input, providerId: '../other-client' }),
    ).toThrowError('provider_credential_input_invalid')
    expect(() => asProviderCredentialInput({ ...input, persistence: undefined })).toThrowError(
      'provider_credential_input_invalid',
    )
    expect(asProviderId('openai')).toBe('openai')
    expect(() => asProviderId('../other-client')).toThrowError('provider_id_invalid')
  })

  it('accepts only redacted status and exposes no raw credential channel', () => {
    const status = {
      providerId: 'openai',
      persistence: 'persistent',
      status: 'available',
      kind: 'api_key',
    } as const
    expect(asProviderCredentialStatus(status)).toEqual(status)
    expect(() => asProviderCredentialStatus({ ...status, apiKey: 'leaked-canary' })).toThrowError(
      'provider_credential_status_invalid',
    )
    expect(PI_RUNTIME_CHANNELS).toEqual({
      health: 'pi-runtime:health',
      saveProviderApiKey: 'pi-runtime:provider-credential-save',
      providerCredentialStatus: 'pi-runtime:provider-credential-status',
      logoutProvider: 'pi-runtime:provider-credential-logout',
      modelCatalog: 'pi-runtime:model-catalog',
      selectModel: 'pi-runtime:model-select',
      configureModelProvider: 'pi-runtime:model-provider-configure',
      startModelOAuth: 'pi-runtime:model-oauth-start',
      modelOAuthStatus: 'pi-runtime:model-oauth-status',
      respondModelOAuth: 'pi-runtime:model-oauth-respond',
      cancelModelOAuth: 'pi-runtime:model-oauth-cancel',
      logoutModel: 'pi-runtime:model-logout',
      resourceCatalog: 'pi-runtime:resource-catalog',
      selectResourceProject: 'pi-runtime:resource-project-select',
      grantProjectTrust: 'pi-runtime:project-trust-grant',
      revokeProjectTrust: 'pi-runtime:project-trust-revoke',
      packageCatalog: 'pi-runtime:package-catalog',
      installLocalPackage: 'pi-runtime:package-install-local',
      installNpmPackage: 'pi-runtime:package-install-npm',
      installGitPackage: 'pi-runtime:package-install-git',
      activatePackage: 'pi-runtime:package-activate',
      enablePackage: 'pi-runtime:package-enable',
      disablePackage: 'pi-runtime:package-disable',
      uninstallPackage: 'pi-runtime:package-uninstall',
      mcpCatalog: 'pi-runtime:mcp-catalog',
      activateMcp: 'pi-runtime:mcp-activate',
      enableMcp: 'pi-runtime:mcp-enable',
      disableMcp: 'pi-runtime:mcp-disable',
      retryMcp: 'pi-runtime:mcp-retry',
      enableMcpTool: 'pi-runtime:mcp-tool-enable',
      disableMcpTool: 'pi-runtime:mcp-tool-disable',
    })
    expect(JSON.stringify(PI_RUNTIME_CHANNELS)).not.toContain('credential-get')
  })

  it('validates exact model selection and write-only OAuth inputs', () => {
    const operationId = '55555555-5555-4555-8555-555555555555'
    expect(
      asModelSelectInput({ role: 'conversation', providerId: 'openai', modelId: 'gpt-5.4' }),
    ).toEqual({ role: 'conversation', providerId: 'openai', modelId: 'gpt-5.4' })
    expect(asModelOAuthStartInput({ operationId, providerId: 'openai-codex' })).toEqual({
      operationId,
      providerId: 'openai-codex',
    })
    expect(asModelOAuthOperationInput({ operationId })).toEqual({ operationId })
    expect(asModelOAuthResponseInput({ operationId, value: 'write-only-response' })).toEqual({
      operationId,
      value: 'write-only-response',
    })
    expect(() =>
      asModelSelectInput({
        role: 'fallback',
        providerId: 'openai',
        modelId: 'gpt-5.4',
      }),
    ).toThrowError('model_select_input_invalid')
    expect(() =>
      asModelOAuthResponseInput({ operationId, value: '', secret: 'readable' }),
    ).toThrowError('model_oauth_response_input_invalid')
    expect(() =>
      asModelOAuthStartInput({ operationId: 'invalid', providerId: 'openai-codex' }),
    ).toThrowError('model_oauth_start_input_invalid')
    expect(() => asModelOAuthOperationInput({ operationId: 'invalid' })).toThrowError(
      'model_oauth_operation_input_invalid',
    )
  })

  it('accepts only explicit secret-free OpenAI-compatible Provider configuration', () => {
    const configuration = {
      providerId: 'local-openai',
      name: 'Local OpenAI',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [
        {
          modelId: 'qwen-test',
          name: 'Qwen Test',
          capabilities: ['text-input', 'tool-use'],
        },
      ],
    }
    expect(asModelProviderConfigurationInput(configuration)).toEqual(configuration)
    expect(() =>
      asModelProviderConfigurationInput({ ...configuration, apiKey: 'secret-canary' }),
    ).toThrowError('model_provider_configuration_invalid')
    expect(() =>
      asModelProviderConfigurationInput({
        ...configuration,
        models: [{ ...configuration.models[0], capabilities: [] }],
      }),
    ).toThrowError('model_provider_configuration_invalid')
  })

  it('revalidates renderer-safe catalog and OAuth projections', () => {
    const catalog = { providers: [], selections: {} }
    const operation = {
      operationId: '55555555-5555-4555-8555-555555555555',
      providerId: 'openai-codex',
      state: 'running',
    }
    expect(asModelCatalog(catalog)).toEqual(catalog)
    expect(asOAuthOperation(operation)).toEqual(operation)
    expect(() => asModelCatalog({ ...catalog, apiKey: 'leaked' })).toThrowError(
      'model_catalog_invalid',
    )
    expect(() => asOAuthOperation({ ...operation, accessToken: 'leaked' })).toThrowError(
      'oauth_operation_projection_invalid',
    )
  })

  it('revalidates Resource Catalog metadata without accepting paths or bodies', () => {
    const catalog = {
      catalogId: 'a'.repeat(64),
      projectState: 'untrusted',
      resources: [
        {
          resourceKey: 'skill:project/example',
          resourceId: 'example',
          namespace: 'project',
          kind: 'skill',
          source: 'project:skills/example',
          state: 'restricted',
          reason: 'project_untrusted',
          action: 'trust_project',
        },
      ],
    } as const
    expect(asResourceCatalog(catalog)).toEqual(catalog)
    expect(() =>
      asResourceCatalog({
        ...catalog,
        resources: [{ ...catalog.resources[0], path: '/private/project' }],
      }),
    ).toThrowError('resource_catalog_invalid')
    expect(() => asResourceCatalog({ ...catalog, body: 'secret' })).toThrowError(
      'resource_catalog_invalid',
    )
  })

  it('validates renderer-safe MCP projections and exact lifecycle inputs', () => {
    const catalog = { projectState: 'none', servers: [] }
    expect(asMcpCatalog(catalog)).toEqual(catalog)
    expect(asMcpMutationInput({ namespace: 'global', serverId: 'fixture' })).toEqual({
      namespace: 'global',
      serverId: 'fixture',
    })
    expect(
      asMcpToolMutationInput({
        namespace: 'project',
        serverId: 'fixture',
        toolName: 'read_fixture',
      }),
    ).toEqual({ namespace: 'project', serverId: 'fixture', toolName: 'read_fixture' })
    expect(() => asMcpCatalog({ ...catalog, command: '/bin/secret' })).toThrowError(
      'mcp_catalog_invalid',
    )
    expect(() => asMcpMutationInput({ namespace: 'global', serverId: '../escape' })).toThrowError(
      'mcp_mutation_input_invalid',
    )
    expect(() =>
      asMcpToolMutationInput({
        namespace: 'global',
        serverId: 'fixture',
        toolName: 'read_fixture',
        credentialRef: 'forbidden',
      }),
    ).toThrowError('mcp_tool_mutation_input_invalid')
  })

  it('accepts only fixed Package inputs and path-free Package projections', () => {
    const mutation = { namespace: 'global', packageId: 'safe-extension' } as const
    expect(asPackageNamespace('project')).toBe('project')
    expect(() => asPackageNamespace('/private/project')).toThrowError('package_namespace_invalid')
    expect(asPackageMutationInput(mutation)).toEqual(mutation)
    expect(asPackageLocalInstallInput(mutation)).toEqual(mutation)
    expect(
      asPackageNpmInstallInput({ ...mutation, name: '@scope/safe-extension', version: '1.2.3' }),
    ).toEqual({ ...mutation, name: '@scope/safe-extension', version: '1.2.3' })
    expect(
      asPackageGitInstallInput({
        ...mutation,
        url: 'https://example.com/safe-extension.git',
        commit: 'a'.repeat(40),
      }),
    ).toMatchObject({ commit: 'a'.repeat(40) })
    expect(() =>
      asPackageNpmInstallInput({ ...mutation, name: 'safe-extension', version: '^1.2.3' }),
    ).toThrowError('package_npm_install_input_invalid')
    expect(() =>
      asPackageGitInstallInput({
        ...mutation,
        url: 'https://example.com/safe-extension.git',
        commit: 'main',
      }),
    ).toThrowError('package_git_install_input_invalid')
    expect(() => asPackageLocalInstallInput({ ...mutation, localPath: '/leak' })).toThrowError(
      'package_local_install_input_invalid',
    )

    const catalog = {
      globalGeneration: 2,
      packages: [
        {
          namespace: 'global',
          packageId: 'safe-extension',
          source: `local-sha256:${'a'.repeat(64)}`,
          contentSha256: 'a'.repeat(64),
          license: 'MIT',
          capabilities: ['executable'],
          enabled: true,
          status: 'eligible',
          resourceCount: 1,
        },
      ],
    } as const
    expect(asPackageCatalog(catalog)).toEqual(catalog)
    expect(() =>
      asPackageCatalog({ ...catalog, packages: [{ ...catalog.packages[0], localPath: '/leak' }] }),
    ).toThrowError('package_catalog_invalid')
  })
})
