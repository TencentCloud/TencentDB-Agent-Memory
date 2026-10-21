import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeMetaFetch, KernelFetchError, mapHttpStatusFromEnvelopeCode } from '../../src/panel/kernel/transport-fetch.js';

const config = { endpoint: 'https://core.test///', apiKey: 'server-api-key', serviceId: 'instance-a', userKey: 'caller-key', requestId: 'request-local', timeoutMs: 1000 };
const path = '/v3/meta/agent/list';

function mockResponse(value: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Panel to Kernel HTTP transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('forwards the server bearer, selected service, user key and request ID', async () => {
    const fetch = mockResponse({ code: 0, data: { items: ['agent-a'] } });
    expect(await executeMetaFetch(config, path, { team_id: 'team-a' }, 'data')).toEqual({ items: ['agent-a'] });
    expect(fetch).toHaveBeenCalledWith(`https://core.test${path}`, expect.objectContaining({
      method: 'POST', body: '{"team_id":"team-a"}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer server-api-key', 'x-tdai-service-id': 'instance-a', 'x-tdai-user-key': 'caller-key', 'x-request-id': 'request-local' },
      signal: expect.any(AbortSignal),
    }));
  });

  it('sends GET requests without a body or an absent user key', async () => {
    const fetch = mockResponse({ code: 0, data: [] });
    await executeMetaFetch({ ...config, userKey: undefined }, path, { ignored: true }, 'data', 'GET');
    const options = fetch.mock.calls[0][1];
    expect(options.method).toBe('GET');
    expect(options).not.toHaveProperty('body');
    expect(options.headers).not.toHaveProperty('x-tdai-user-key');
  });

  it('fills optional envelope fields using the outbound correlation ID', async () => {
    mockResponse({ code: 0 });
    expect(await executeMetaFetch(config, path, undefined, 'envelope')).toEqual({ code: 0, message: 'ok', request_id: 'request-local', data: {} });
  });

  it('returns a business failure unchanged in envelope mode', async () => {
    const denied = { code: 403, message: 'permission_denied', request_id: 'upstream-request', data: { reason: 'owner-only' } };
    mockResponse(denied, 403);
    expect(await executeMetaFetch(config, path, {}, 'envelope')).toEqual(denied);
  });

  it('turns a business failure into KernelFetchError in data mode', async () => {
    mockResponse({ code: 403, message: 'permission_denied' }, 403);
    await expect(executeMetaFetch(config, path, {}, 'data')).rejects.toMatchObject({ name: 'KernelFetchError', code: 403, httpStatus: 403 });
  });

  it.each([null, {}, { code: '0' }])('rejects invalid upstream envelopes %j', async (body) => {
    mockResponse(body);
    await expect(executeMetaFetch(config, path, {}, 'envelope')).rejects.toMatchObject({ code: 502 });
  });

  it('reports invalid JSON as a gateway failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 502 })));
    await expect(executeMetaFetch(config, path, {}, 'data')).rejects.toBeInstanceOf(KernelFetchError);
  });

  it('maps network failures to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
    await expect(executeMetaFetch(config, path, {}, 'data')).rejects.toMatchObject({ code: 502, message: expect.stringContaining('network unavailable') });
  });

  it('aborts a stalled upstream at its timeout and clears the timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const result = executeMetaFetch(config, path, {}, 'data');
    const assertion = expect(result).rejects.toMatchObject({ code: 504, httpStatus: 504 });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[0, 200], [400, 400], [599, 599], [600, 502], [-1, 502], [1, 502]])('maps envelope code %s to HTTP %s', (code, status) => {
    expect(mapHttpStatusFromEnvelopeCode(code)).toBe(status);
  });
});
