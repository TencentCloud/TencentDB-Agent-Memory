import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreUpstreamError } from '../../src/panel/domain/errors.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';

function client(timeoutMs = 15_000): HttpKnowledgeClient {
  return new HttpKnowledgeClient({
    baseUrl: 'https://knowledge.example',
    authToken: 'secret-token',
    serviceId: 'memory-1',
    timeoutMs,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpKnowledgeClient transport errors', () => {
  it('maps request timeouts to CoreUpstreamError 504', async () => {
    const fetchMock: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client(5).wikiGet('wiki-1')).rejects.toMatchObject({
      name: 'CoreUpstreamError',
      code: 'CORE_UPSTREAM_ERROR',
      httpStatus: 504,
      message: 'knowledge service timeout at /v3/wiki/get',
    } satisfies Partial<CoreUpstreamError>);
  });

  it('maps non-JSON upstream responses without exposing their body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('sensitive gateway failure', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );

    let error: unknown;
    try {
      await client().wikiGet('wiki-1');
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(CoreUpstreamError);
    expect(error).toMatchObject({
      httpStatus: 502,
      message:
        'invalid JSON from knowledge service at /v3/wiki/get (HTTP 502)',
    });
    expect((error as Error).message).not.toContain('sensitive gateway failure');
  });

  it('maps network failures to CoreUpstreamError 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('socket disconnected');
      }),
    );

    await expect(client().wikiGet('wiki-1')).rejects.toMatchObject({
      name: 'CoreUpstreamError',
      code: 'CORE_UPSTREAM_ERROR',
      httpStatus: 502,
      message: 'knowledge service request failed at /v3/wiki/get',
    } satisfies Partial<CoreUpstreamError>);
  });

  it('preserves valid envelopes and request credentials', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        code: 0,
        message: 'ok',
        data: { wiki_id: 'wiki-1', name: 'Example' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().wikiGet('wiki-1')).resolves.toMatchObject({
      wiki_id: 'wiki-1',
      name: 'Example',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://knowledge.example/v3/wiki/get',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-token',
          'x-tdai-service-id': 'memory-1',
        },
        body: JSON.stringify({ wiki_id: 'wiki-1' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
