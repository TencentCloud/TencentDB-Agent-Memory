import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { initAuth, verifyUserKey } from '../auth.js';
import { buildConfig } from '../config.js';

afterEach(() => initAuth({ enabled: false, url: '', timeoutMs: 1000 }));

describe('Core service auth during user verification', () => {
  it('separates service credentials from client identities and rejects a bad service key', async () => {
    const seen: { bearer?: string; space?: string; body?: unknown } = {};
    const server = createServer(async (req, res) => {
      seen.bearer = req.headers.authorization;
      seen.space = req.headers['x-tdai-service-id'] as string;
      let raw = ''; for await (const chunk of req) raw += chunk;
      seen.body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer fixture-service-key') {
        res.writeHead(401); res.end('{}'); return;
      }
      res.end(JSON.stringify({ code: 0, data: { valid: true, user: {user_id: 'fixture-user'} } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;
    try {
      initAuth({ enabled: true, url: `http://127.0.0.1:${port}`, timeoutMs: 1000, apiKey: 'fixture-service-key' });
      expect(await verifyUserKey('fixture-client-key', 'fixture-space')).toEqual({userId: 'fixture-user', rejected: false});
      expect(seen).toEqual({bearer: 'Bearer fixture-service-key', space: 'fixture-space', body: {user_key: 'fixture-client-key'}});
      initAuth({ enabled: true, url: `http://127.0.0.1:${port}`, timeoutMs: 1000, apiKey: 'wrong-service-key' });
      expect((await verifyUserKey('fixture-client-key', 'fixture-space')).rejected).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('loads the service credential from the operator environment', () => {
    const previous = process.env.TDAI_AUTH_API_KEY;
    try {
      process.env.TDAI_AUTH_API_KEY = 'fixture-env-key';
      expect(buildConfig().auth.apiKey).toBe('fixture-env-key');
    } finally {
      if (previous === undefined) delete process.env.TDAI_AUTH_API_KEY;
      else process.env.TDAI_AUTH_API_KEY = previous;
    }
  });
});
