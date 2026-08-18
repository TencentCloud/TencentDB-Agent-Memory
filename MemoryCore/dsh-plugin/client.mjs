const TEXT_LIMIT = 12000

export class TdaiClient {
  constructor(config) {
    this.endpoint = String(config.endpoint).replace(/\/$/, '')
    this.apiKey = config.apiKey || ''
    this.serviceId = config.serviceId
  }

  async post(path, body, signal) {
    const headers = { 'content-type': 'application/json', 'x-tdai-service-id': this.serviceId }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const response = await fetch(`${this.endpoint}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || (payload && payload.code && payload.code !== 0)) {
      throw new Error(`TDAI ${path} failed (${response.status})`)
    }
    return payload.data ?? payload
  }

  recall(identity, query, limit, signal) {
    return this.post('/v3/atomic/search', { ...identity, query, top_k: limit }, signal)
  }

  conversationSearch(identity, query, limit, signal) {
    return this.post('/v3/conversation/search', { ...identity, query, limit }, signal)
  }

  skillSearch(identity, query, top_k, signal) {
    return this.post('/v3/skill/search', { ...identity, query, top_k }, signal)
  }

  capture(identity, messages, signal) {
    return this.post('/v3/conversation/add', { ...identity, messages }, signal)
  }

  skillConversationAdd(identity, messages, signal) {
    return this.post('/v3/skill/conversation/add', { ...identity, messages }, signal)
  }
}

export function safeText(value) {
  if (typeof value === 'string') return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value
  if (Array.isArray(value)) return value.map((item) => safeText(item?.text ?? item?.content ?? '')).filter(Boolean).join('\n').slice(0, TEXT_LIMIT)
  return ''
}
