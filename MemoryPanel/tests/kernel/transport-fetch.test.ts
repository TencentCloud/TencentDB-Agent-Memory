import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeMetaFetch,
  type MetaFetchConfig,
} from '../../src/panel/kernel/transport-fetch.js';

const config: MetaFetchConfig = {
  endpoint: 'https://kernel.example.com',
  apiKey: 'api-key',
  serviceId: 'service-1',
  requestId: 'request-1',
};

function mockResponse(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('executeMetaFetch HTTP status handling', () => {
  it.each(['data', 'envelope'] as const)(
    'rejects HTTP failures carrying a success envelope in %s mode',
    async (mode) => {
      mockResponse(500, {
        code: 0,
        message: 'ok',
        request_id: 'upstream-1',
        data: { accepted: true },
      });

      await expect(
        executeMetaFetch(config, '/v3/meta/test', {}, mode),
      ).rejects.toMatchObject({
        name: 'KernelFetchError',
        code: 500,
        httpStatus: 500,
        message: 'remote metadata HTTP 500 at /v3/meta/test',
      });
    },
  );

  it('keeps business error envelopes transparent in envelope mode', async () => {
    mockResponse(400, {
      code: 400,
      message: 'invalid input',
      request_id: 'upstream-2',
      data: null,
    });

    await expect(
      executeMetaFetch(config, '/v3/meta/test', {}, 'envelope'),
    ).resolves.toEqual({
      code: 400,
      message: 'invalid input',
      request_id: 'upstream-2',
      data: {},
    });
  });

  it('returns data from a successful HTTP response', async () => {
    mockResponse(200, {
      code: 0,
      message: 'ok',
      request_id: 'upstream-3',
      data: { accepted: true },
    });

    await expect(
      executeMetaFetch(config, '/v3/meta/test', {}, 'data'),
    ).resolves.toEqual({ accepted: true });
  });
});
