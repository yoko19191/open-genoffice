import { AuthType, createClient } from 'webdav'

import { CasMismatchError } from './repository.mjs'

function assertBaseUrl(value, allowInsecureLoopback) {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback))
    throw new TypeError('WebDAV sync requires HTTPS')
  return url.toString().replace(/\/?$/u, '/')
}

function strongEtag(response) {
  const etag = response.headers.get('etag')
  if (!etag || etag.startsWith('W/') || !/^"[^"\r\n]+"$/u.test(etag))
    throw new Error('WebDAV provider must return a strong ETag')
  return etag
}

export class WebDavObjectStore {
  constructor({
    baseUrl,
    fetchImpl = fetch,
    requestImpl,
    authorization,
    allowInsecureLoopback = false,
  }) {
    this.baseUrl = assertBaseUrl(baseUrl, allowInsecureLoopback)
    this.request = requestImpl ?? ((key, init) => fetchImpl(this.url(key), init))
    this.authorization = authorization
  }

  url(key) {
    return new URL(key.split('/').map(encodeURIComponent).join('/'), this.baseUrl).toString()
  }

  headers(extra = {}) {
    return { ...(this.authorization ? { Authorization: this.authorization } : {}), ...extra }
  }

  async get(key) {
    const response = await this.request(key, { headers: this.headers() })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`WebDAV GET failed with HTTP ${response.status}`)
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      versionToken: strongEtag(response),
    }
  }

  async putIfAbsent(key, bytes) {
    const response = await this.request(key, {
      method: 'PUT',
      headers: this.headers({ 'If-None-Match': '*' }),
      body: bytes,
    })
    if (response.status === 412) return { created: false }
    if (!response.ok) throw new Error(`WebDAV PUT failed with HTTP ${response.status}`)
    return { created: true }
  }

  async compareAndSwap(key, bytes, expectedVersionToken) {
    const condition = expectedVersionToken
      ? { 'If-Match': expectedVersionToken }
      : { 'If-None-Match': '*' }
    const response = await this.request(key, {
      method: 'PUT',
      headers: this.headers(condition),
      body: bytes,
    })
    if (response.status === 412) throw new CasMismatchError()
    if (!response.ok) throw new Error(`WebDAV conditional PUT failed with HTTP ${response.status}`)
    let versionToken = response.headers.get('etag')
    if (!versionToken) {
      const head = await this.request(key, { method: 'HEAD', headers: this.headers() })
      if (!head.ok) throw new Error(`WebDAV HEAD failed with HTTP ${head.status}`)
      versionToken = strongEtag(head)
    } else {
      versionToken = strongEtag(response)
    }
    return { versionToken }
  }
}

export function webDavClientOptions(auth) {
  if (!auth) return {}
  if (auth.type === 'basic')
    return { authType: AuthType.Password, username: auth.username, password: auth.password }
  if (auth.type === 'digest')
    return {
      authType: AuthType.Digest,
      username: auth.username,
      password: auth.password,
      ...(auth.ha1 ? { ha1: auth.ha1 } : {}),
    }
  if (auth.type === 'bearer')
    return { authType: AuthType.None, headers: { Authorization: `Bearer ${auth.token}` } }
  throw new TypeError('WebDAV auth must be basic, digest or bearer')
}

export function createAuthenticatedWebDavObjectStore({
  baseUrl,
  auth,
  allowInsecureLoopback = false,
  clientFactory = createClient,
}) {
  const validatedBaseUrl = assertBaseUrl(baseUrl, allowInsecureLoopback)
  const client = clientFactory(validatedBaseUrl, webDavClientOptions(auth))
  return new WebDavObjectStore({
    baseUrl: validatedBaseUrl,
    allowInsecureLoopback,
    requestImpl: async (key, init) => {
      try {
        return await client.customRequest(`/${key}`, {
          method: init.method ?? 'GET',
          headers: init.headers,
          ...(init.body === undefined ? {} : { data: Buffer.from(init.body) }),
        })
      } catch (error) {
        if (error?.response) return error.response
        throw error
      }
    },
  })
}
