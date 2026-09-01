import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/panel/infra/logger.js';
import { executeMetaFetch, KernelFetchError } from '../../src/panel/kernel/transport-fetch.js';

const cfg = { endpoint: 'https://core.example.com/', apiKey: 'sk-test', serviceId: 'svc-1' };

function jsonResponse(env: unknown, status = 200) {
  return { status, json: async () => env };
}

function makeLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info,
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return { logger, info, warn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('executeMetaFetch — data mode', () => {
  it('returns data on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 0, data: { ok: 1 } })));
    await expect(executeMetaFetch(cfg, '/v3/meta/x', {}, 'data')).resolves.toEqual({ ok: 1 });
  });

  it('throws KernelFetchError with the envelope code on business error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 403, message: 'forbidden', data: null })),
    );
    const err = await executeMetaFetch(cfg, '/v3/meta/x', {}, 'data').catch((e) => e);
    expect(err).toBeInstanceOf(KernelFetchError);
    expect(err.code).toBe(403);
    expect(err.httpStatus).toBe(403);
  });

  it('throws 502 on an invalid (non-envelope) response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ foo: 'bar' })));
    const err = await executeMetaFetch(cfg, '/v3/meta/x', {}, 'data').catch((e) => e);
    expect(err).toBeInstanceOf(KernelFetchError);
    expect(err.code).toBe(502);
  });

  it('throws 502 on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const err = await executeMetaFetch(cfg, '/v3/meta/x', {}, 'data').catch((e) => e);
    expect(err.code).toBe(502);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('throws 504 on an abort (timeout)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    const err = await executeMetaFetch(cfg, '/v3/meta/x', {}, 'data').catch((e) => e);
    expect(err.code).toBe(504);
  });
});

describe('executeMetaFetch — envelope mode', () => {
  it('returns the full envelope even when code != 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ code: 404, message: 'nf', data: null })),
    );
    const env = await executeMetaFetch(cfg, '/v3/meta/x', {}, 'envelope');
    expect(env).toMatchObject({ code: 404, message: 'nf' });
  });
});

describe('executeMetaFetch — request-body redaction', () => {
  it('masks sensitive fields in the request log', async () => {
    const { logger, info } = makeLogger();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 0, data: {} })));

    await executeMetaFetch(
      { ...cfg, logger },
      '/v3/meta/user/create',
      { password: 'secret12345', api_key: 'sk-abcdef12345', name: 'alice' },
      'data',
    );

    const requestLog = info.mock.calls.find((c) => c[0].includes('api.remote.request'));
    const body = requestLog?.[1]?.requestBody as string;
    expect(body).toBeDefined();
    expect(body).not.toContain('secret12345');
    expect(body).not.toContain('sk-abcdef12345');
    expect(body).toContain('secret12…');
    expect(body).toContain('sk-abcde…');
    expect(body).toContain('alice');
  });
});
