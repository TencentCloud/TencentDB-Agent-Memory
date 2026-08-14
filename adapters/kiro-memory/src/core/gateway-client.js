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

const invalidEnvelope = (status) => new GatewayError('Gateway response envelope is invalid', {
  status,
  retryable: false,
});

export class GatewayClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      'x-tdai-service-id': this.config.serviceId,
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    try {
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
      } catch {
        if (controller.signal.aborted) {
          throw new GatewayError('Gateway request failed', { retryable: true });
        }
        throw invalidEnvelope(response.status);
      }
      if (!isObject(envelope) || envelope.code !== 0 || !Object.hasOwn(envelope, 'data')) {
        throw invalidEnvelope(response.status);
      }
      return envelope.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async atomicSearch(query, limit) {
    const data = await this.post('/v3/atomic/search', {
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
      query,
      limit,
    });
    if (
      !isObject(data)
      || !Array.isArray(data.items)
      || data.items.some((item) => !isObject(item) || typeof item.content !== 'string')
    ) {
      throw invalidEnvelope();
    }
    return data;
  }

  async coreRead() {
    const data = await this.post('/v3/core/read', {
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId,
    });
    if (!isObject(data) || !Object.hasOwn(data, 'content') || (typeof data.content !== 'string' && data.content !== null)) {
      throw invalidEnvelope();
    }
    return data;
  }
}
