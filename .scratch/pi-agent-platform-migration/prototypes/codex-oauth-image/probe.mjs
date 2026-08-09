import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

const API_BASE_URL = 'https://api.openai.com/v1'
const MODEL_ID = 'gpt-image-2'
const PROVIDER_ID = 'openai-codex'
const isolatedHome = join(process.cwd(), '.isolated-home')
const allowBillableCall = process.argv.includes('--allow-billable-image-call')
const checkRuntimeOnly = process.argv.includes('--check-runtime')

// Keep this probe independent from both Pi CLI and Codex credential storage.
// ModelRuntime is the public Pi 0.84 integration surface used by pi-web.
process.env.HOME = isolatedHome
process.env.PI_CODING_AGENT_DIR = join(isolatedHome, '.open-genoffice', 'pi')
process.env.PI_OFFLINE = '1'

const credentialStore = new InMemoryCredentialStore()
const modelRuntime = await ModelRuntime.create({
  credentials: credentialStore,
  modelsPath: null,
  allowModelNetwork: false,
})

const provider = modelRuntime.getProvider(PROVIDER_ID)
if (!provider?.auth.oauth) {
  throw new Error(`Pi provider ${PROVIDER_ID} does not expose OAuth login`)
}

if (checkRuntimeOnly) {
  console.log(
    JSON.stringify(
      {
        phase: 'pi_runtime_contract_check',
        provider: PROVIDER_ID,
        oauth: true,
        credentialStore: 'memory',
        modelsStore: 'memory',
        isolatedHomeCreated: existsSync(isolatedHome),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const credentials = await modelRuntime.login(PROVIDER_ID, 'oauth', {
  prompt: async (prompt) => {
    if (prompt.type === 'select') {
      const deviceCodeOption = prompt.options.find((option) => option.id === 'device_code')
      if (deviceCodeOption) return deviceCodeOption.id
    }
    throw new Error(`Unexpected ${prompt.type} prompt in device-code flow`)
  },
  notify: (event) => {
    if (event.type === 'device_code') {
      console.log(`Open ${event.verificationUri}`)
      console.log(`Enter code: ${event.userCode}`)
      console.log(`The code expires in ${event.expiresInSeconds ?? 900} seconds.`)
      return
    }
    if (event.type === 'auth_url') {
      console.log(`Open ${event.url}`)
      if (event.instructions) console.log(event.instructions)
      return
    }
    if (event.type === 'info' || event.type === 'progress') {
      console.log(event.message)
    }
  },
})

if (credentials.type !== 'oauth') {
  throw new Error(`Expected OAuth credentials, received ${credentials.type}`)
}

const authHeaders = {
  Authorization: `Bearer ${credentials.access}`,
  'Content-Type': 'application/json',
  'X-Client-Request-Id': crypto.randomUUID(),
}

const modelResponse = await fetch(`${API_BASE_URL}/models/${MODEL_ID}`, {
  headers: authHeaders,
})
const modelBody = await readJson(modelResponse)

console.log(
  JSON.stringify(
    {
      phase: 'public_api_auth_probe',
      endpoint: `/v1/models/${MODEL_ID}`,
      status: modelResponse.status,
      requestId: modelResponse.headers.get('x-request-id'),
      error: sanitizeError(modelBody),
      verdict: modelResponse.ok
        ? 'oauth_credential_accepted_by_public_api'
        : 'oauth_credential_not_accepted_for_public_image_api',
    },
    null,
    2,
  ),
)

if (!modelResponse.ok || !allowBillableCall) {
  if (modelResponse.ok) {
    console.log(
      'Authentication passed. Re-run with --allow-billable-image-call only after accepting image-generation cost.',
    )
  }
  process.exitCode = modelResponse.ok ? 2 : 1
} else {
  const imageResponse = await fetch(`${API_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'X-Client-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      model: MODEL_ID,
      prompt: 'A small blue square centered on a plain white background.',
      n: 1,
      size: '1024x1024',
      quality: 'low',
    }),
  })
  const imageBody = await readJson(imageResponse)
  console.log(
    JSON.stringify(
      {
        phase: 'billable_image_generation_probe',
        endpoint: '/v1/images/generations',
        status: imageResponse.status,
        requestId: imageResponse.headers.get('x-request-id'),
        generatedImageCount: Array.isArray(imageBody?.data) ? imageBody.data.length : 0,
        error: sanitizeError(imageBody),
        verdict: imageResponse.ok
          ? 'codex_oauth_image_generation_supported'
          : 'codex_oauth_image_generation_unsupported',
      },
      null,
      2,
    ),
  )
  process.exitCode = imageResponse.ok ? 0 : 1
}

async function readJson(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.slice(0, 500) } }
  }
}

function sanitizeError(body) {
  const error = body?.error
  if (!error) return null
  return {
    type: typeof error.type === 'string' ? error.type : null,
    code: typeof error.code === 'string' ? error.code : null,
    message: typeof error.message === 'string' ? error.message.slice(0, 500) : null,
  }
}
