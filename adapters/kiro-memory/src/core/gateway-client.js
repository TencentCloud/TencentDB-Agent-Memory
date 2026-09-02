const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

export class GatewayError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.retryable = retryable;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const HEALTH_MAX_BYTES = 16 * 1024;

const invalidEnvelope = (status) => new GatewayError('Gateway response envelope is invalid', {
  status,
  retryable: false,
});

const readBoundedText = async (response) => {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let source = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > HEALTH_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw invalidEnvelope(response.status);
      }
      source += decoder.decode(value, { stream: true });
    }
    return source + decoder.decode();
  }
  if (typeof response.text !== 'function') throw invalidEnvelope(response.status);
  const source = await response.text();
  if (Buffer.byteLength(source, 'utf8') > HEALTH_MAX_BYTES) throw invalidEnvelope(response.status);
  return source;
};

export class GatewayClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async post(path, body, { timeoutMs, signal } = {}) {
    const effectiveTimeoutMs = timeoutMs === undefined
      ? this.config.timeoutMs
      : Math.min(this.config.timeoutMs, timeoutMs);
    if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
      throw new GatewayError('Gateway request failed', { retryable: true });
    }
    const controller = new AbortController();
    const abortFromUpstream = () => controller.abort();
    let timer;

    try {
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener('abort', abortFromUpstream, { once: true });
      timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      const headers = {
        'Content-Type': 'application/json',
        'x-tdai-service-id': this.config.serviceId,
      };
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

      let response;
      try {
        response = await this.fetch(`${this.config.gatewayUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new GatewayError('Gateway request failed', { retryable: true });
      }

      if (!response || typeof response.status !== 'number') throw invalidEnvelope();
      if (!response.ok) {
        throw new GatewayError('Gateway returned an unsuccessful HTTP status', {
          status: response.status,
          retryable: retryableStatuses.has(response.status),
        });
      }

      let envelope;
      try {
        envelope = await response.json();
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new GatewayError('Gateway request failed', { retryable: true });
        }
        if (error instanceof SyntaxError) throw invalidEnvelope(response.status);
        throw new GatewayError('Gateway request failed', { retryable: true });
      }
      if (!isObject(envelope) || envelope.code !== 0 || !Object.hasOwn(envelope, 'data')) {
        throw invalidEnvelope(response.status);
      }
      return envelope.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromUpstream);
    }
  }

  async health({ timeoutMs = this.config.timeoutMs } = {}) {
    const controller = new AbortController();
    const effective = Math.min(this.config.timeoutMs, timeoutMs);
    const timer = setTimeout(() => controller.abort(), effective);
    try {
      let response;
      try { response = await this.fetch(`${this.config.gatewayUrl}/health`, { method: 'GET', signal: controller.signal }); }
      catch { throw new GatewayError('Gateway health failed', { retryable: true }); }
      if (!response || typeof response.status !== 'number') throw invalidEnvelope();
      if (![200, 503].includes(response.status)) {
        throw new GatewayError('Gateway health failed', { status: response.status, retryable: retryableStatuses.has(response.status) });
      }
      let data;
      try { data = JSON.parse(await readBoundedText(response)); }
      catch (error) {
        if (error instanceof GatewayError) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError') throw new GatewayError('Gateway health failed', { retryable: true });
        throw invalidEnvelope(response.status);
      }
      const degraded = data?.status === 'degraded';
      if (!isObject(data) || !['ok', 'degraded'].includes(data.status) || typeof data.version !== 'string' || data.version.length === 0
        || !isObject(data.storage) || typeof data.storage.degraded !== 'boolean' || data.storage.degraded !== degraded
        || (response.status === 200) === degraded) throw invalidEnvelope(response.status);
      return { status: data.status };
    } finally { clearTimeout(timer); }
  }

  async atomicSearch(query, limit, { timeoutMs, signal } = {}) {
    const data = await this.post('/v3/atomic/search', {
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
      query,
      limit,
    }, { timeoutMs, signal });
    if (
      !isObject(data)
      || !Array.isArray(data.items)
      || data.items.some((item) => !isObject(item) || typeof item.id !== 'string' || item.id.length === 0
        || typeof item.type !== 'string' || typeof item.content !== 'string'
        || typeof item.created_at !== 'string' || Number.isNaN(Date.parse(item.created_at))
        || typeof item.updated_at !== 'string' || Number.isNaN(Date.parse(item.updated_at))
        || typeof item.score !== 'number' || !Number.isFinite(item.score))
    ) {
      throw invalidEnvelope();
    }
    return data;
  }

  async coreRead({ timeoutMs, signal } = {}) {
    const data = await this.post('/v3/core/read', {
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
    }, { timeoutMs, signal });
    if (!isObject(data) || !Object.hasOwn(data, 'content') || (typeof data.content !== 'string' && data.content !== null)) {
      throw invalidEnvelope();
    }
    return data;
  }

  async conversationSearch(query, limit, { timeStart, timeEnd, timeoutMs, signal } = {}) {
    const body = {
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
      query,
      limit,
    };
    if (timeStart !== undefined) body.time_start = timeStart;
    if (timeEnd !== undefined) body.time_end = timeEnd;
    const data = await this.post('/v3/conversation/search', body, { timeoutMs, signal });
    if (!isObject(data) || !Array.isArray(data.messages) || data.messages.some((item) =>
      !isObject(item)
      || !['user', 'assistant', 'system'].includes(item.role)
      || typeof item.content !== 'string'
      || typeof item.score !== 'number' || !Number.isFinite(item.score)
      || (item.id !== undefined && typeof item.id !== 'string')
      || (item.timestamp !== undefined && (typeof item.timestamp !== 'string' || Number.isNaN(Date.parse(item.timestamp)))))
    ) throw invalidEnvelope();
    return { messages: data.messages.map((item) => ({
      ...(item.id === undefined ? {} : { id: item.id }), role: item.role, content: item.content,
      ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
    })) };
  }

  async skillSearch(query, limit, { timeoutMs, signal } = {}) {
    // The v3 Skill Search wire contract names this field top_k; the public adapter option remains limit.
    const data = await this.post('/v3/skill/search', {
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
      query,
      top_k: limit,
      mode: 'hybrid',
    }, { timeoutMs, signal });
    if (!isObject(data) || !Array.isArray(data.items) || data.items.some((item) =>
      !isObject(item) || typeof item.skill_id !== 'string' || !item.skill_id
      || typeof item.name !== 'string' || typeof item.description !== 'string'
      || typeof item.snippet !== 'string'
      || typeof item.score !== 'number' || !Number.isFinite(item.score)
      || (item.version !== undefined && !Number.isSafeInteger(item.version))
      || (item.status !== undefined && typeof item.status !== 'string')
      || (item.updated_at_ms !== undefined && (!Number.isSafeInteger(item.updated_at_ms) || item.updated_at_ms < 0)))
    ) throw invalidEnvelope();
    return { items: data.items.map((item) => ({
      id: item.skill_id,
      content: item.snippet || item.description,
      name: item.name,
      description: item.description,
      ...(item.version === undefined ? {} : { version: item.version }),
      ...(item.status === undefined ? {} : { status: item.status }),
      ...(item.updated_at_ms === undefined ? {} : { timestamp: new Date(item.updated_at_ms).toISOString() }),
    })) };
  }

  async skillConversationAdd(payload, { timeoutMs } = {}) {
    const data = await this.post('/v3/skill/conversation/add', payload, { timeoutMs });
    if (isObject(data) && Object.keys(data).length === 1 && data.status === 'ok') return data;
    if (
      isObject(data) && Object.keys(data).length === 2 && data.status === 'archived'
      && isObject(data.archived) && Object.keys(data.archived).length === 4
      && typeof data.archived.task_id === 'string'
      && Number.isSafeInteger(data.archived.archived_at_ms) && data.archived.archived_at_ms >= 0
      && typeof data.archived.archive_key === 'string'
      && new Set(['tool_calls', 'bytes', 'compressed', 'oversize']).has(data.archived.reason)
    ) return data;
    throw invalidEnvelope();
  }

  async forceArchive({ sessionId, reason, taskId } = {}, { timeoutMs } = {}) {
    const body = {
      session_id: sessionId,
      space_id: this.config.serviceId,
      user_id: this.config.userId,
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
    };
    if (reason !== undefined) body.reason = reason;
    if (taskId !== undefined) body.task_id = taskId;
    const data = await this.post('/v3/skill/conversation/force-archive', body, { timeoutMs });
    if (isObject(data) && data.status === 'empty'
      && Object.keys(data).every((key) => ['status', 'message'].includes(key))
      && (data.message === undefined || typeof data.message === 'string')) return { status: 'empty' };
    if (isObject(data) && data.status === 'archived'
      && Object.keys(data).every((key) => ['status', 'task_id', 'archived_at_ms', 'archive_key'].includes(key))
      && typeof data.task_id === 'string' && Number.isSafeInteger(data.archived_at_ms) && data.archived_at_ms >= 0
      && typeof data.archive_key === 'string') return data;
    throw invalidEnvelope();
  }
}
