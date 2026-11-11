import {GatewayClient} from './client.mjs';
export class BoundedGatewayClient extends GatewayClient {
  async post(path, body, {signal} = {}) {
    const started = performance.now(), deadline = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.baseUrl}/v2${path}`, {method: 'POST', headers: this.headers,
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline});
    const envelope = await response.json();
    if (!response.ok || envelope.code !== 0) throw Error('gateway_request_failed');
    return {data: envelope.data, request_id: envelope.request_id, latency_ms: performance.now() - started};
  }
  async search(scope, query, limit, options = {}) {
    const r = await this.post('/conversation/search', {...scope, query, limit}, options);
    if (!Array.isArray(r.data.messages)) throw Error('gateway_candidate_schema');
    return {items: r.data.messages, request_id: r.request_id, latency_ms: r.latency_ms};
  }
}
