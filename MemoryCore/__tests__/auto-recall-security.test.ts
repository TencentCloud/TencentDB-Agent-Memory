import { expect, it, vi } from 'vitest';
import { performAutoRecall } from '../src/core/hooks/auto-recall.js';
import { parseConfig } from '../src/config.js';

function fixture(strategy: 'keyword' | 'hybrid') {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const row = { record_id: 'synthetic-private-record', type: 'fact', content: 'synthetic-private-memory', score: 1 };
  const searchL1Fts = vi.fn(async () => [row]);
  const store = { getCapabilities: () => ({ nativeHybridSearch: true }), isFtsAvailable: () => true, searchL1Fts };
  const params = {
    userText: 'syntheticprivatequery', actorId: 'synthetic-actor', sessionKey: 'synthetic-session',
    cfg: parseConfig({ recall: { strategy, scoreThreshold: 0, maxResults: 2 } }),
    pluginDataDir: '/unused-synthetic-path', logger, vectorStore: store as never,
    storage: { readFile: async () => null, getBackend: () => ({}) } as never,
  };
  return { params, logger, store, row, searchL1Fts };
}
it('keeps keyword recall private while preserving caller query and memory', async () => {
  const f = fixture('keyword');
  const result = await performAutoRecall(f.params);
  expect(result?.prependContext).toContain(f.row.content);
  expect(f.searchL1Fts).toHaveBeenCalled();
  const logs = JSON.stringify([f.logger.debug.mock.calls, f.logger.info.mock.calls, f.logger.warn.mock.calls]);
  for (const privateValue of [f.params.userText, f.row.record_id, f.row.content]) expect(logs).not.toContain(privateValue);
});
it('falls back to keyword when hybrid capability lacks its optional method and no embedder exists', async () => {
  const f = fixture('hybrid');
  const result = await performAutoRecall(f.params);
  expect(result?.prependContext).toContain(f.row.content);
  expect(f.searchL1Fts).toHaveBeenCalledTimes(1);
});
it('preserves native hybrid recall without a client embedder', async () => {
  const f = fixture('hybrid');
  const searchL1Hybrid = vi.fn(async () => [f.row]);
  f.params.vectorStore = { ...f.store, searchL1Hybrid } as never;
  const result = await performAutoRecall(f.params);
  expect(result?.prependContext).toContain(f.row.content);
  expect(searchL1Hybrid).toHaveBeenCalledWith({ query: f.params.userText, topK: 2 });
  expect(f.searchL1Fts).not.toHaveBeenCalled();
});

it('omits backend error payloads from recall logs', async () => {
  const f = fixture('keyword');
  f.searchL1Fts.mockRejectedValue(new Error('synthetic-private-backend-payload'));
  await expect(performAutoRecall(f.params)).resolves.toBeUndefined();
  expect(f.logger.warn).toHaveBeenCalled();
  expect(JSON.stringify([f.logger.warn.mock.calls, f.logger.debug.mock.calls])).not.toContain('synthetic-private-backend-payload');
});
