/**
 * Search provider for the Harness web seam (`ctx.web`). It drives the user's
 * already-running Chrome through the DevTools Protocol and returns the same
 * source shape the built-in `web_search` tool renders.
 *
 * Chrome 136+ rejects the browser HTTP discovery endpoint and any DevTools
 * WebSocket handshake that carries an Origin, so this client reads
 * `DevToolsActivePort` and speaks raw frames over TCP without that header.
 * Each search opens one background tab and closes it; existing tabs are left
 * alone. Cookies, storage, and credentials are never read.
 */
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export const name = 'web-search-chrome-cdp'
export const inject = ['web']
export const PROVIDER_ID = 'chrome-cdp'

const CHROME_PROFILES = [
  'Google/Chrome',
  'Google/Chrome Canary',
  'Chromium',
  'Microsoft Edge',
  'BraveSoftware/Brave-Browser',
]

const ENGINE_URLS = {
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans`,
  baidu: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=zh-CN`,
  ddg: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
}

const EXTRACT_SOURCES = `(() => {
  const engineHost = /(?:^|\\.)(?:bing|baidu|microsoft|gstatic|duckduckgo)\\.com$|google\\./
  const clean = (value) => {
    try {
      const parsed = new URL(value, location.href)
      if (parsed.hostname.includes('google.') && parsed.pathname === '/url') {
        return parsed.searchParams.get('q') || parsed.searchParams.get('url') || ''
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
      return parsed.href
    } catch {
      return ''
    }
  }
  const seen = new Set()
  const sources = []
  const push = (url, title, snippet) => {
    url = clean(url)
    title = (title || '').replace(/\\s+/g, ' ').trim()
    snippet = (snippet || '').replace(/\\s+/g, ' ').trim()
    if (!url || title.length < 2 || seen.has(url)) return
    let host = ''
    try { host = new URL(url).hostname } catch { return }
    if (engineHost.test(host)) return
    seen.add(url)
    sources.push({ url, title, snippet })
  }
  const host = location.hostname
  if (host.includes('bing.')) {
    for (const item of document.querySelectorAll('#b_results > li.b_algo')) {
      const link = item.querySelector('h2 a')
      if (!link) continue
      push(link.href, link.innerText, item.querySelector('.b_caption p, .b_lineclamp2, p')?.innerText || '')
    }
  } else if (host.includes('baidu.')) {
    for (const item of document.querySelectorAll('#content_left .c-container, #content_left .result')) {
      const link = item.querySelector('h3 a')
      if (!link) continue
      const body = item.innerText || ''
      const snippet = item.querySelector('.c-abstract, .content-right_8Zs40, [class*="content-right"]')?.innerText || body
      push(item.getAttribute('mu') || link.href, link.innerText, snippet)
    }
  } else if (host.includes('duckduckgo.')) {
    for (const item of document.querySelectorAll('.result, article[data-testid="result"]')) {
      const link = item.querySelector('a.result__a, a[data-testid="result-title-a"], h2 a')
      if (!link) continue
      push(link.href, link.innerText, item.querySelector('.result__snippet, [data-result="snippet"]')?.innerText || '')
    }
  } else {
    for (const heading of document.querySelectorAll('#rso h3, #search h3')) {
      const link = heading.closest('a')
      if (!link) continue
      const block = heading.closest('div.g') || link.parentElement
      push(link.href, heading.innerText, block?.querySelector('.VwiC3b, [data-sncf]')?.innerText || '')
    }
  }
  return { href: location.href, title: document.title, sources }
})()`

const READABLE_TEXT = `(() => {
  const root = document.querySelector('article') || document.querySelector('main') || document.body
  if (!root) return ''
  const clone = root.cloneNode(true)
  clone.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,iframe,svg').forEach((node) => node.remove())
  return (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 1600)
})()`

/** @param {unknown} config */
function optionsOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const engines = typeof source.engines === 'string' && source.engines.trim().length > 0
    ? source.engines.split(',').map((item) => item.trim()).filter((item) => item in ENGINE_URLS)
    : ['bing', 'baidu']
  return {
    port: typeof source.port === 'number' ? source.port : undefined,
    browserPath: typeof source.browserPath === 'string' && source.browserPath.length > 0 ? source.browserPath : undefined,
    engines: engines.length > 0 ? engines : ['bing'],
    navigationTimeoutMs: positive(source.navigationTimeoutMs, 12000),
    settleTimeoutMs: positive(source.settleTimeoutMs, 7000),
    snippetChars: positive(source.snippetChars, 420),
    enrichCount: Math.min(3, positive(source.enrichCount, 2)),
    enrichChars: positive(source.enrichChars, 900),
  }
}

/** @param {unknown} value @param {number} fallback */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Locate a Chrome launched with remote debugging. Local file read only.
 * @param {{ port?: number, browserPath?: string }} options
 * @returns {{ port: number, browserPath: string } | undefined}
 */
export function discoverEndpoint(options) {
  if (options.browserPath !== undefined) return { port: options.port ?? 9222, browserPath: options.browserPath }
  for (const file of activePortFiles()) {
    if (!existsSync(file)) continue
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const [portLine, pathLine] = text.split(/\r?\n/u)
    const port = Number(portLine)
    if (!Number.isInteger(port) || port < 1 || pathLine === undefined || !pathLine.startsWith('/devtools/')) continue
    if (options.port !== undefined && options.port !== port) continue
    return { port, browserPath: pathLine }
  }
  return undefined
}

/** Candidate `DevToolsActivePort` files for the current operating system. */
function activePortFiles() {
  const home = homedir()
  if (platform() === 'darwin') {
    return CHROME_PROFILES.map((directory) => join(home, 'Library/Application Support', directory, 'DevToolsActivePort'))
  }
  if (platform() === 'win32') {
    const local = join(home, 'AppData/Local')
    return [
      join(local, 'Google/Chrome/User Data/DevToolsActivePort'),
      join(local, 'Google/Chrome SxS/User Data/DevToolsActivePort'),
      join(local, 'Chromium/User Data/DevToolsActivePort'),
      join(local, 'Microsoft/Edge/User Data/DevToolsActivePort'),
      join(local, 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort'),
    ]
  }
  const config = join(home, '.config')
  return [
    join(config, 'google-chrome/DevToolsActivePort'),
    join(config, 'google-chrome-unstable/DevToolsActivePort'),
    join(config, 'chromium/DevToolsActivePort'),
    join(config, 'microsoft-edge/DevToolsActivePort'),
    join(config, 'BraveSoftware/Brave-Browser/DevToolsActivePort'),
  ]
}

/** @param {import('node:net').Socket} socket @param {Buffer} payload @param {number} opcode */
function sendFrame(socket, payload, opcode) {
  const mask = crypto.randomBytes(4)
  const length = payload.length
  let header
  if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length])
  else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index++) masked[index] = payload[index] ^ mask[index & 3]
  socket.write(Buffer.concat([header, mask, masked]))
}

class CdpConnection {
  /**
   * @param {number} port
   * @param {string} path
   * @param {AbortSignal | undefined} signal
   */
  constructor(port, path, signal) {
    this.port = port
    this.path = path
    this.signal = signal
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.id = 0
    this.pending = new Map()
    /** @type {import('node:net').Socket | null} */
    this.socket = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      const socket = net.connect(this.port, '127.0.0.1')
      this.socket = socket
      let settled = false
      let header = Buffer.alloc(0)
      const fail = (error) => {
        if (settled) return
        settled = true
        this.signal?.removeEventListener('abort', onAbort)
        reject(error)
        socket.destroy()
      }
      const onAbort = () => fail(abortError(this.signal))
      const onData = (chunk) => {
        header = Buffer.concat([header, chunk])
        const end = header.indexOf('\r\n\r\n')
        if (end < 0) return
        socket.off('data', onData)
        const status = header.subarray(0, header.indexOf('\r\n')).toString('utf8')
        if (!status.includes(' 101 ')) {
          fail(new Error(`Chrome CDP handshake failed: ${status}`))
          return
        }
        socket.on('data', (frame) => this.#onData(frame))
        socket.on('close', () => this.#failAll(new Error('Chrome CDP connection closed')))
        settled = true
        this.signal?.removeEventListener('abort', onAbort)
        const rest = header.subarray(end + 4)
        if (rest.length > 0) this.#onData(rest)
        resolve()
      }
      socket.on('data', onData)
      socket.on('error', fail)
      this.signal?.addEventListener('abort', onAbort, { once: true })
      socket.write([
        `GET ${this.path} HTTP/1.1`,
        `Host: 127.0.0.1:${this.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'))
    })
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f
      const masked = (this.buffer[1] & 0x80) !== 0
      let length = this.buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const wide = this.buffer.readBigUInt64BE(2)
        if (wide > 8n * 1024n * 1024n) throw new Error('Chrome CDP frame exceeds 8 MiB')
        length = Number(wide)
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      if (this.buffer.length < offset + maskLength + length) return
      let payload = this.buffer.subarray(offset + maskLength, offset + maskLength + length)
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4)
        payload = Buffer.from(payload)
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3]
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length)
      if (opcode === 0x9) {
        if (this.socket) sendFrame(this.socket, payload, 0xA)
        continue
      }
      if (opcode === 0x8) {
        this.socket?.end()
        continue
      }
      if (opcode === 0x0) {
        this.fragments.push(Buffer.from(payload))
        continue
      }
      if (opcode !== 0x1) continue
      const text = Buffer.concat([...this.fragments, Buffer.from(payload)]).toString('utf8')
      this.fragments = []
      let message
      try {
        message = JSON.parse(text)
      } catch {
        continue
      }
      if (message.id == null || !this.pending.has(message.id)) continue
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error.message || 'Chrome CDP command failed'))
      else waiter.resolve(message.result ?? {})
    }
  }

  /** @param {Error} error */
  #failAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string | undefined} [sessionId]
   * @param {number} [timeoutMs]
   */
  call(method, params = {}, sessionId, timeoutMs = 15000) {
    throwIfAborted(this.signal)
    if (this.socket === null) throw new Error('Chrome CDP connection is not open')
    const id = ++this.id
    const body = { id, method, params }
    if (sessionId !== undefined) body.sessionId = sessionId
    sendFrame(this.socket, Buffer.from(JSON.stringify(body)), 0x1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome CDP command timed out: ${method}`))
      }, timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(abortError(this.signal))
      }
      this.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          this.signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          this.signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
    })
  }

  close() {
    this.#failAll(new Error('Chrome CDP connection closed'))
    this.socket?.destroy()
    this.socket = null
  }
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError(signal)
}

/** @param {AbortSignal | undefined} signal */
function abortError(signal) {
  const error = new Error('Chrome CDP search aborted')
  error.name = 'WebError'
  error.code = 'WEB_ABORTED'
  error.cause = signal?.reason
  return error
}

/** @param {Error} error @param {string} code */
function providerError(error, code = 'WEB_PROVIDER_ERROR') {
  const wrapped = new Error(error.message)
  wrapped.name = 'WebError'
  wrapped.code = code
  wrapped.cause = error
  return wrapped
}

/** @param {number} ms @param {AbortSignal | undefined} signal */
function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => finish(abortError(signal))
    function finish(error) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * @param {CdpConnection} connection
 * @param {string} sessionId
 * @param {string} query
 * @param {string} engine
 * @param {{ navigationTimeoutMs: number, settleTimeoutMs: number }} limits
 */
async function searchEngine(connection, sessionId, query, engine, limits) {
  const buildUrl = ENGINE_URLS[engine]
  await connection.call('Page.navigate', { url: buildUrl(query) }, sessionId, limits.navigationTimeoutMs)
  const deadline = Date.now() + limits.settleTimeoutMs
  let latest = []
  while (Date.now() < deadline) {
    throwIfAborted(connection.signal)
    await delay(Math.min(400, Math.max(0, deadline - Date.now())), connection.signal)
    const evaluated = await connection.call('Runtime.evaluate', {
      expression: EXTRACT_SOURCES,
      returnByValue: true,
    }, sessionId, 5000)
    const sources = evaluated.result?.value?.sources
    if (Array.isArray(sources)) {
      latest = sources.filter((item) => typeof item?.url === 'string' && typeof item?.title === 'string')
      if (latest.length >= 3) return latest
    }
  }
  return latest
}

/**
 * Open the top result pages and replace thin SERP snippets with readable text.
 * Failures stay on the original snippet.
 * @param {CdpConnection} connection
 * @param {string} sessionId
 * @param {{ url: string, title: string, snippet?: string }[]} sources
 * @param {{ navigationTimeoutMs: number, enrichCount: number, enrichChars: number }} limits
 */
async function enrichSources(connection, sessionId, sources, limits) {
  const chosen = sources.filter((source) => !SKIP_ENRICH.test(source.url)).slice(0, limits.enrichCount)
  for (const source of chosen) {
    throwIfAborted(connection.signal)
    const original = source.snippet ?? ''
    try {
      await connection.call('Page.navigate', { url: source.url }, sessionId, Math.min(limits.navigationTimeoutMs, 8000))
      await delay(700, connection.signal)
      const evaluated = await connection.call('Runtime.evaluate', {
        expression: READABLE_TEXT,
        returnByValue: true,
      }, sessionId, 4000)
      const text = typeof evaluated.result?.value === 'string'
        ? evaluated.result.value.replace(/\s+/gu, ' ').trim()
        : ''
      if (usableExcerpt(text, original)) source.snippet = text.slice(0, limits.enrichChars)
    } catch (error) {
      if (connection.signal?.aborted === true) throw error
      source.snippet = original
    }
  }
}

const SKIP_ENRICH = /csdn\.net|zhihu\.com|weixin\.qq\.com|mp\.weixin\.qq\.com|login\.|accounts\.google\./iu

/** @param {string} text @param {string} original */
function usableExcerpt(text, original) {
  if (text.length < 180) return false
  if (/安全验证|Security Verification|captcha|just a moment|access denied|enable javascript|请完成验证|机器人/iu.test(text)) return false
  return text.length > original.length + 80
}

/**
 * @param {readonly { url: string, title: string, snippet?: string }[][]} lists
 * @param {number} snippetChars
 */
function mergeSources(lists, snippetChars) {
  const seen = new Set()
  const sources = []
  const longest = Math.max(0, ...lists.map((list) => list.length))
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const source = list[rank]
      if (source === undefined || seen.has(source.url)) continue
      seen.add(source.url)
      const snippet = typeof source.snippet === 'string' ? source.snippet.slice(0, snippetChars) : ''
      sources.push({
        url: source.url,
        title: source.title,
        ...snippet.length > 0 ? { snippet } : {},
      })
    }
  }
  return sources
}

export class ChromeCdpSearchProvider {
  /** @param {() => ReturnType<typeof optionsOf>} readOptions */
  constructor(readOptions) {
    this.readOptions = readOptions
    this.id = PROVIDER_ID
  }

  available() {
    return discoverEndpoint(this.readOptions()) !== undefined
  }

  /**
   * @param {{ query: string, maxResults?: number }} request
   * @param {AbortSignal} [signal]
   */
  async search(request, signal) {
    throwIfAborted(signal)
    const options = this.readOptions()
    const endpoint = discoverEndpoint(options)
    if (endpoint === undefined) {
      throw providerError(new Error(
        'Chrome CDP search has no reachable browser. Quit Chrome completely, then relaunch it with --remote-debugging-port=9222. An already-running Chrome ignores that flag. The plugin reads ~/Library/Application Support/Google/Chrome/DevToolsActivePort.',
      ), 'WEB_PROVIDER_UNAVAILABLE')
    }
    const connection = new CdpConnection(endpoint.port, endpoint.browserPath, signal)
    let targetId
    try {
      await connection.connect()
      const created = await connection.call('Target.createTarget', { url: 'about:blank', background: true })
      targetId = created.targetId
      if (typeof targetId !== 'string') throw new Error('Chrome did not return a target id')
      const attached = await connection.call('Target.attachToTarget', { targetId, flatten: true })
      const sessionId = attached.sessionId
      if (typeof sessionId !== 'string') throw new Error('Chrome did not return a session id')
      const lists = []
      const failures = []
      for (const engine of options.engines) {
        throwIfAborted(signal)
        try {
          const found = await searchEngine(connection, sessionId, request.query, engine, options)
          if (found.length > 0) lists.push(found)
          if (found.length >= 3) break
        } catch (error) {
          if (signal?.aborted === true) throw error
          failures.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const sources = mergeSources(lists, options.snippetChars)
      if (sources.length === 0) {
        throw new Error(`Chrome CDP search returned no results (${failures.join('; ') || 'pages loaded without recognizable result blocks'})`)
      }
      if (options.enrichCount > 0) await enrichSources(connection, sessionId, sources, options)
      return { sources, truncated: false }
    } catch (error) {
      if (error instanceof Error && error.code === 'WEB_ABORTED') throw error
      if (signal?.aborted === true) throw abortError(signal)
      if (error instanceof Error && error.code === 'WEB_PROVIDER_UNAVAILABLE') throw error
      throw providerError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (targetId !== undefined) {
        await connection.call('Target.closeTarget', { targetId }, undefined, 2000).catch(() => {})
      }
      connection.close()
    }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {unknown} config */
export function apply(ctx, config) {
  const readOptions = () => optionsOf(config)
  ctx.web.registerSearchProvider(new ChromeCdpSearchProvider(readOptions))
}
