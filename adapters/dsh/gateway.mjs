/**
 * Async HTTP client for the TencentDB Agent Memory memory-core gateway.
 *
 * Implements the sidecar routes consumed by this adapter (the same routes as
 * the official trpc-agent-go `memory/tencentdb` adapter and the sibling
 * adapters in this repository):
 *
 * - `GET  /health`
 * - `POST /capture`              (turn capture, L0)
 * - `POST /recall`               (memory recall before a model call)
 * - `POST /search/memories`      (long-term memory search tool)
 * - `POST /search/conversations` (cross-session conversation search tool)
 * - `POST /session/end`          (flush short-term session state)
 */

const DEFAULT_TIMEOUT_MS = 5000

export class GatewayError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
  }
}

/** One transcript message sent to /capture. */
export function gatewayMessage(role, content, timestampSec, id = '') {
  const message = { role, content, timestamp: timestampSec }
  if (id) message.id = id
  return message
}

/** Build the default gateway session_key (mirrors the trpc-agent-go adapter):
 * urlsafe-base64(app):urlsafe-base64(user):urlsafe-base64(session). */
export function sessionKey(appName, userId, sessionId) {
  const enc = (value) =>
    Buffer.from(String(value), 'utf8').toString('base64url')
  return [enc(appName), enc(userId), enc(sessionId)].join(':')
}

/** Extract plain text from a DSH message content value: either a string or a
 * parts array (`[{ type: 'text', text }]`). Returns '' when empty. */
export function textFromContent(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

export class TdaiGatewayClient {
  /**
   * @param {object} options
   * @param {string} options.endpoint - gateway base URL, e.g. http://127.0.0.1:8420
   * @param {string} [options.apiKey] - bearer key; required when the gateway
   *   is started with TDAI_GATEWAY_API_KEY
   * @param {number} [options.timeoutMs] - per-request timeout
   * @param {object} [options.fetchImpl] - injectable fetch (tests)
   */
  constructor({ endpoint, apiKey = '', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
    if (!endpoint || !/^https?:\/\//.test(endpoint)) {
      throw new GatewayError(`gateway endpoint must be an http(s) URL, got: ${String(endpoint)}`)
    }
    this.endpoint = String(endpoint).replace(/\/+$/, '')
    this.apiKey = apiKey || ''
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
    this._fetch = fetchImpl || ((url, init) => fetch(url, init))
  }

  async _post(path, body, signal) {
    const headers = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    return this._request(path, { method: 'POST', headers, body: JSON.stringify(body), signal })
  }

  async _request(path, init) {
    const signal = init.signal || AbortSignal.timeout(this.timeoutMs)
    let response
    try {
      response = await this._fetch(`${this.endpoint}${path}`, { ...init, signal })
    } catch (error) {
      if (signal.aborted) throw new GatewayError(`gateway request aborted: ${path}`)
      throw new GatewayError(`gateway request failed: ${path}: ${error.message}`)
    }
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      payload = {}
    }
    if (!response.ok) {
      throw new GatewayError(
        `gateway returned ${response.status} for ${path}: ${JSON.stringify(payload).slice(0, 512)}`,
        { status: response.status },
      )
    }
    return payload
  }

  async health() {
    const data = await this._request('/health', { method: 'GET' })
    return { status: data.status || '', version: data.version || '' }
  }

  /**
   * Capture one completed turn.
   * @param {object} capture - { userContent, assistantContent, sessionKey,
   *   sessionId, userId, messages: [{role, content, timestamp, id?}] }
   */
  async capture(capture) {
    const body = {
      user_content: capture.userContent,
      assistant_content: capture.assistantContent,
      session_key: capture.sessionKey,
      messages: capture.messages,
    }
    if (capture.sessionId) body.session_id = capture.sessionId
    if (capture.userId) body.user_id = capture.userId
    return this._post('/capture', body, capture.signal)
  }

  /** Recall relevant memory context for a query. */
  async recall({ query, sessionKey, userId, signal }) {
    const body = { query, session_key: sessionKey }
    if (userId) body.user_id = userId
    const data = await this._post('/recall', body, signal)
    return {
      context: data.context || '',
      prependContext: data.prepend_context || '',
      strategy: data.strategy || '',
      memoryCount: data.memory_count || 0,
    }
  }

  /** Search extracted long-term memories (cross-session, user-scoped). */
  async searchMemories({ query, limit = 10, userId, signal }) {
    const body = { query, limit }
    if (userId) body.user_id = userId
    const data = await this._post('/search/memories', body, signal)
    return { results: data.results || '', total: data.total || 0 }
  }

  /** Search raw conversation history. Without sessionKey the search is
   * cross-session for the user. */
  async searchConversations({ query, limit = 10, sessionKey, userId, signal }) {
    const body = { query, limit }
    if (sessionKey) body.session_key = sessionKey
    if (userId) body.user_id = userId
    const data = await this._post('/search/conversations', body, signal)
    return { results: data.results || '', total: data.total || 0 }
  }

  /** Flush gateway-side short-term session state. */
  async endSession({ sessionKey, userId, signal }) {
    const body = { session_key: sessionKey }
    if (userId) body.user_id = userId
    const data = await this._post('/session/end', body, signal)
    return Boolean(data.flushed)
  }
}
