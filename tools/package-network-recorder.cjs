'use strict'

const fs = require('node:fs')
const dns = require('node:dns')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')

const reportPath = process.env.GENOFFICE_NETWORK_REPORT
const surface = process.env.GENOFFICE_NETWORK_SURFACE
if (reportPath && surface) {
  const append = (event) => {
    fs.appendFileSync(
      reportPath,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, surface, ...event })}\n`,
      { mode: 0o600 },
    )
  }
  const hostname = (value) => {
    if (typeof value === 'string') {
      try {
        return new URL(value).hostname.toLowerCase()
      } catch {
        return value.toLowerCase()
      }
    }
    return String(value?.hostname ?? value?.host ?? '')
      .split(':')[0]
      .toLowerCase()
  }
  const local = (value) => {
    const host = hostname(value).replace(/^\[|\]$/g, '')
    return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1'
  }
  const blocked = (protocol, value) => {
    const host = hostname(value)
    append({ kind: 'network_attempt', protocol, hostname: host, outcome: 'blocked' })
    const error = new Error('package_network_forbidden')
    error.code = 'GENOFFICE_PACKAGE_NETWORK_FORBIDDEN'
    throw error
  }

  append({ kind: 'instrumented' })

  const patchRequest = (module, protocol) => {
    const request = module.request
    const get = module.get
    module.request = function recordedRequest(input, ...args) {
      return local(input) ? request.call(this, input, ...args) : blocked(protocol, input)
    }
    module.get = function recordedGet(input, ...args) {
      return local(input) ? get.call(this, input, ...args) : blocked(protocol, input)
    }
  }
  patchRequest(http, 'http')
  patchRequest(https, 'https')

  const originalFetch = globalThis.fetch
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function recordedFetch(input, ...args) {
      return local(input) ? originalFetch.call(this, input, ...args) : blocked('fetch', input)
    }
  }

  const originalLookup = dns.lookup
  dns.lookup = function recordedLookup(value, ...args) {
    return local(value) ? originalLookup.call(this, value, ...args) : blocked('dns', value)
  }
  for (const name of ['resolve', 'resolve4', 'resolve6']) {
    const original = dns[name]
    dns[name] = function recordedResolve(value, ...args) {
      return local(value) ? original.call(this, value, ...args) : blocked('dns', value)
    }
  }
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    const original = dns.promises[name]
    dns.promises[name] = function recordedPromiseResolve(value, ...args) {
      return local(value) ? original.call(this, value, ...args) : blocked('dns', value)
    }
  }

  for (const name of ['connect', 'createConnection']) {
    const original = net[name]
    net[name] = function recordedConnect(input, ...args) {
      if (typeof input === 'string' || local(input)) return original.call(this, input, ...args)
      return blocked('tcp', input)
    }
  }
}
