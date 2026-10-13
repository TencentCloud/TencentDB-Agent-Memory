import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { PanelClient } from '../../../agents/asset-import.js';

async function fixture(status: number, text: string, run: (client: PanelClient) => Promise<void>) {
  let forwarded = 0;
  let sourceCalls = 0;
  const sink = createServer((req, res) => {
    forwarded++; req.resume(); res.end('{"code":0,"data":{"ok":true}}');
  });
  await new Promise<void>(r => sink.listen(0, '127.0.0.1', r));
  const target = sink.address();
  if (!target || typeof target === 'string') throw new Error('Missing address');
  const source = createServer((req, res) => {
    sourceCalls++; req.resume();
    expect(req.headers['x-tdai-user-key']).toBe('synthetic-user-key');
    res.writeHead(status, { location: `http://127.0.0.1:${target.port}/sink` });
    res.end(text);
  });
  await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
  const address = source.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  try {
    await run(new PanelClient({ panelUrl: `http://127.0.0.1:${address.port}`, serviceId: 'synthetic', userKey: 'synthetic-user-key' }));
    expect(sourceCalls).toBe(1);
    expect(forwarded).toBe(0);
  } finally {
    source.closeAllConnections(); sink.closeAllConnections();
    await Promise.all([new Promise<void>(r => source.close(() => r())), new Promise<void>(r => sink.close(() => r()))]);
  }
}

it.each([200, 301, 302, 303, 307, 308])('asset importer rejects redirects and accepts direct response %s', async status => {
  await fixture(status, '{"code":0,"data":{"ok":true}}', async client => {
    const request = client.post('/synthetic', { content: 'private-request-canary' });
    if (status === 200) await expect(request).resolves.toEqual({ code: 0, data: { ok: true } });
    else await expect(request).rejects.toThrow();
  });
});

it.each(['private-response-canary', '{"content":"private-response-canary"}'])('asset importer omits malformed response content from errors: %s', async text => {
  await fixture(200, text, async client => {
    let error: Error | undefined;
    try { await client.post('/synthetic', {}); } catch (e) { error = e as Error; }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain('private-response-canary');
    expect(error?.message).toContain('200');
  });
});
