import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { handleAuxiliaryEndpoint } from '../auxiliaryHandler.js';
import { DEFAULT_CONFIG } from '../config.js';

vi.mock('../auth.js', () => ({ verifyUserKey: async () => ({ userId: 'u', rejected: false }) }));
vi.mock('../instance-upstream-cache.js', async importOriginal => ({
  ...await importOriginal<typeof import('../instance-upstream-cache.js')>(),
  getInstanceUpstreamConfigs: async () => [],
}));
afterEach(() => vi.unstubAllGlobals());

it('aux requests use the agent key or original client key, never the global key at an agent URL', async () => {
  for (const protocol of ['anthropic', 'openai'] as const) {
    for (const apiKey of [undefined, 'agent-key']) {
      const upstream = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', upstream);
      const config = { ...DEFAULT_CONFIG, upstream: {
        ...DEFAULT_CONFIG.upstream, apiKey: 'global-key',
        agents: { zcode: { [protocol]: { url: 'https://agent.example/v1', apiKey } } },
      } };
      const app = new Hono();
      app.post('/*', c => handleAuxiliaryEndpoint(c, config));
      const endpoint = protocol === 'anthropic' ? 'messages/count_tokens' : 'embeddings';
      const header = protocol === 'anthropic' ? 'x-api-key' : 'authorization';
      const clientValue = protocol === 'anthropic' ? 'client-key' : 'Bearer client-key';
      expect((await app.request(`/zcode/default/v1/${endpoint}`, {
        method: 'POST', headers: { [header]: clientValue }, body: '{}',
      })).status).toBe(200);
      const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://agent.example/v1/${endpoint}`);
      expect(new Headers(init.headers).get(header)).toBe(apiKey
        ? protocol === 'anthropic' ? apiKey : `Bearer ${apiKey}` : clientValue);
    }
  }
});
