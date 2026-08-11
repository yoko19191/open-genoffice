import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

const PROVIDER_ID = 'openai-codex'
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const OUTER_MODEL_ID = 'gpt-5.4-mini'
const IMAGE_MODEL_ID = 'gpt-image-2'
const isolatedHome = join(process.cwd(), '.isolated-home')
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))
const outputPath = outputArg ? resolve(outputArg.slice('--output='.length)) : undefined

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

const credential = await modelRuntime.login(PROVIDER_ID, 'oauth', {
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

if (credential.type !== 'oauth') {
  throw new Error(`Expected OAuth credentials, received ${credential.type}`)
}

const accountId =
  typeof credential.accountId === 'string' && credential.accountId.length > 0
    ? credential.accountId
    : extractAccountId(credential.access)
const requestId = crypto.randomUUID()
const requestBody = {
  instructions: '',
  stream: true,
  reasoning: { effort: 'medium', summary: 'auto' },
  parallel_tool_calls: true,
  include: ['reasoning.encrypted_content'],
  model: OUTER_MODEL_ID,
  store: false,
  tool_choice: { type: 'image_generation' },
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'A small solid blue square centered on a plain white background.',
        },
      ],
    },
  ],
  tools: [
    {
      type: 'image_generation',
      action: 'generate',
      model: IMAGE_MODEL_ID,
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
    },
  ],
}

const response = await fetch(RESPONSES_URL, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${credential.access}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': `pi (${process.platform}; ${process.arch})`,
    originator: 'pi',
    'chatgpt-account-id': accountId,
    'x-client-request-id': requestId,
    'session-id': requestId,
  },
  body: JSON.stringify(requestBody),
  signal: AbortSignal.timeout(180_000),
})

if (!response.ok) {
  const errorText = await response.text()
  console.log(
    JSON.stringify(
      {
        phase: 'codex_oauth_responses_image_generation',
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        error: sanitizeErrorText(errorText),
        verdict: 'codex_oauth_responses_image_generation_failed',
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const streamResult = await collectImageFromSse(response)
if (!streamResult.imageBase64) {
  console.log(
    JSON.stringify(
      {
        phase: 'codex_oauth_responses_image_generation',
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        responseId: streamResult.responseId,
        eventCounts: streamResult.eventCounts,
        error: streamResult.error,
        verdict: 'codex_oauth_responses_returned_no_image',
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const imageBytes = Buffer.from(streamResult.imageBase64, 'base64')
const imageMetadata = inspectImage(imageBytes)
if (outputPath) {
  writeFileSync(outputPath, imageBytes, { flag: 'wx' })
}

console.log(
  JSON.stringify(
    {
      phase: 'codex_oauth_responses_image_generation',
      status: response.status,
      requestId: response.headers.get('x-request-id'),
      responseId: streamResult.responseId,
      outerModel: OUTER_MODEL_ID,
      imageModel: IMAGE_MODEL_ID,
      eventCounts: streamResult.eventCounts,
      image: {
        ...imageMetadata,
        bytes: imageBytes.length,
        sha256: createHash('sha256').update(imageBytes).digest('hex'),
      },
      usage: streamResult.usage,
      outputPath: outputPath ?? null,
      isolatedHomeCreated: existsSync(isolatedHome),
      verdict: 'codex_oauth_responses_image_generation_supported',
    },
    null,
    2,
  ),
)

async function collectImageFromSse(response) {
  if (!response.body) throw new Error('Responses endpoint returned no body')

  const eventCounts = {}
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let imageBase64
  let responseId
  let usage
  let error

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const lines = buffer.split('\n')
    buffer = done ? '' : (lines.pop() ?? '')

    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice('data:'.length).trim()
      if (!raw || raw === '[DONE]') continue

      let event
      try {
        event = JSON.parse(raw)
      } catch {
        continue
      }

      const type = typeof event.type === 'string' ? event.type : 'unknown'
      eventCounts[type] = (eventCounts[type] ?? 0) + 1
      responseId ??= event.response?.id ?? event.response_id

      if (type === 'response.image_generation_call.partial_image') {
        if (typeof event.partial_image_b64 === 'string' && event.partial_image_b64.length > 0) {
          imageBase64 = event.partial_image_b64
        }
      }

      if (type === 'response.output_item.done' && event.item?.type === 'image_generation_call') {
        if (typeof event.item.result === 'string' && event.item.result.length > 0) {
          imageBase64 = event.item.result
        }
      }

      if (type === 'response.completed') {
        responseId ??= event.response?.id
        usage = sanitizeUsage(event.response)
        for (const item of event.response?.output ?? []) {
          if (item?.type === 'image_generation_call' && typeof item.result === 'string') {
            imageBase64 = item.result
          }
        }
      }

      if (type === 'response.failed' || type === 'error') {
        error = sanitizeEventError(event)
      }
    }

    if (done) break
  }

  return { imageBase64, responseId, usage, error, eventCounts }
}

function extractAccountId(accessToken) {
  const parts = accessToken.split('.')
  if (parts.length !== 3) throw new Error('OAuth access token is not a JWT')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('OAuth access token does not contain a ChatGPT account ID')
  }
  return accountId
}

function inspectImage(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return {
      format: 'png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    }
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) {
    return { format: 'jpeg', width: null, height: null }
  }
  return { format: 'unknown', width: null, height: null }
}

function sanitizeUsage(response) {
  const imageUsage = response?.tool_usage?.image_gen
  if (!imageUsage || typeof imageUsage !== 'object') return null
  return {
    inputTokens: finiteNumber(imageUsage.input_tokens),
    outputTokens: finiteNumber(imageUsage.output_tokens),
    totalTokens: finiteNumber(imageUsage.total_tokens),
  }
}

function sanitizeEventError(event) {
  const candidate = event.error ?? event.response?.error
  if (!candidate) return null
  return {
    type: typeof candidate.type === 'string' ? candidate.type : null,
    code: typeof candidate.code === 'string' ? candidate.code : null,
    message: typeof candidate.message === 'string' ? candidate.message.slice(0, 500) : null,
  }
}

function sanitizeErrorText(text) {
  try {
    const parsed = JSON.parse(text)
    return (
      sanitizeEventError(parsed) ?? {
        message: typeof parsed?.detail === 'string' ? parsed.detail.slice(0, 500) : null,
      }
    )
  } catch {
    return { message: text.slice(0, 500) }
  }
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null
}
