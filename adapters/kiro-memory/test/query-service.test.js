import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryError, UnifiedQueryService, normalizeQuery } from '../src/core/query-service.js';
import { fuseRankedHits } from '../src/core/rank-fusion.js';

test('normalizes query with NFKC, trim, and collapsed Unicode whitespace', () => {
  assert.equal(normalizeQuery('  Ａ\t\n  memory  '), 'A memory');
  assert.throws(() => normalizeQuery(' \n '), QueryError);
  assert.throws(() => normalizeQuery('x'.repeat(2001)), QueryError);
  assert.throws(() => normalizeQuery(null), QueryError);
});

test('fuses source ranks with deterministic RRF and tie breaks', () => {
  const hits = fuseRankedHits({
    atomic: [{ stableId: 'a', content: 'A' }, { stableId: 'b', content: 'B' }],
    skill: [{ stableId: 'b', content: 'B' }, { stableId: 'c', content: 'C' }],
  });
  assert.deepEqual(hits.map((hit) => hit.stableId), ['b', 'a', 'c']);
  assert.equal(hits[0].fusedScore, (1 / 62) + (1 / 61));
  assert.equal(hits[1].fusedScore, 1 / 61);
});

test('RRF tie breaks use the best rank before source order', () => {
  const hits = fuseRankedHits({
    atomic: [{ stableId: 'shared', content: 'shared' }, { stableId: 'atomic-only', content: 'atomic' }],
    skill: [{ stableId: 'skill-only', content: 'skill' }, { stableId: 'shared', content: 'shared' }],
  });
  const shared = hits.find((hit) => hit.stableId === 'shared');
  assert.equal(shared.sourceRank, 1);
  assert.equal(shared.source, 'atomic');
});

test('RRF counts a repeated stable id at most once per source', () => {
  const hits = fuseRankedHits({ atomic: [
    { stableId: 'same', content: 'same' },
    { stableId: 'same', content: 'same' },
  ] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fusedScore, 1 / 61);
});

test('queries requested sources concurrently, degrades one source, deduplicates content, and reserves core budget', async () => {
  const calls = [];
  const gatewayClient = {
    async atomicSearch(query, limit) { calls.push(['atomic', query, limit]); return { items: [
      { id: 'a1', content: 'same content', type: 'fact', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'a2', content: 'atomic only', type: 'fact' },
    ] }; },
    async conversationSearch() { calls.push(['conversation']); throw new Error('private upstream body'); },
    async skillSearch() { calls.push(['skill']); return { items: [{ id: 's1', content: 'same content', name: 'same', version: 1, status: 'active' }] }; },
    async coreRead() { calls.push(['core']); return { content: 'core memory' }; },
  };
  const service = new UnifiedQueryService({ gatewayClient, monotonicNow: () => 10 });
  const result = await service.query({
    query: '  test  ', sources: ['atomic', 'conversation', 'core', 'skill'],
    resultLimit: 5, charBudget: 80, deadlineMs: 100,
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(result.degradedSources, ['conversation']);
  assert.equal(result.coreContent, 'core memory');
  assert.deepEqual(result.hits.map((hit) => hit.content), ['same content', 'atomic only']);
  assert.equal(result.hits.every((hit) => !Object.hasOwn(hit.metadata, 'owner_user_id')), true);
  assert.deepEqual(result.hits[0].metadata.also_from, ['skill']);
  assert.equal(result.hits[0].fusedScore, (1 / 61) + (1 / 61));
});

test('a too-small item budget omits the item instead of emitting a partial truncation marker', async () => {
  const service = new UnifiedQueryService({ gatewayClient: {
    atomicSearch: async () => ({ items: [{ id: 'a', type: 'fact', content: 'x'.repeat(100), created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', score: 1 }] }),
  } });
  const result = await service.query({ query: 'q', sources: ['atomic'], resultLimit: 1, charBudget: 10, maxItemChars: 10, deadlineMs: 100 });
  assert.deepEqual(result.hits, []);
  assert.equal(result.truncated, true);
});

test('same-source duplicate content does not inflate RRF or contradict primary metadata', async () => {
  const service = new UnifiedQueryService({ gatewayClient: {
    atomicSearch: async () => ({ items: [
      { id: 'a1', type: 'fact', content: 'same', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', score: 1 },
      { id: 'a2', type: 'fact', content: 'same', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', score: 0.9 },
    ] }),
    skillSearch: async () => ({ items: [{ id: 's1', name: 'skill', content: 'same', version: 1, status: 'active', timestamp: '2026-01-01T00:00:00.000Z' }] }),
  } });
  const result = await service.query({ query: 'q', sources: ['atomic', 'skill'], resultLimit: 3, charBudget: 512, deadlineMs: 100 });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].source, 'atomic');
  assert.match(result.hits[0].stableId, /^atomic:/);
  assert.deepEqual(result.hits[0].metadata.also_from, ['skill']);
  assert.equal(result.hits[0].fusedScore, (1 / 61) + (1 / 61));
});

test('returns at the shared deadline when a selected source ignores its timeout', async () => {
  const never = new Promise(() => {});
  const service = new UnifiedQueryService({
    gatewayClient: {
      atomicSearch: async () => ({ items: [{ id: 'a', type: 'fact', content: 'ready', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', score: 1 }] }),
      skillSearch: async () => never,
    },
  });
  const started = Date.now();
  const result = await service.query({ query: 'q', sources: ['atomic', 'skill'], resultLimit: 2, charBudget: 512, deadlineMs: 40 });
  assert.equal(Date.now() - started < 250, true);
  assert.deepEqual(result.hits.map((hit) => hit.content), ['ready']);
  assert.deepEqual(result.degradedSources, ['skill']);
});

test('shared deadline aborts every unfinished source request', async () => {
  const signals = [];
  const never = (_query, _limit, { signal } = {}) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  const service = new UnifiedQueryService({
    gatewayClient: {
      atomicSearch: never,
      conversationSearch: never,
      skillSearch: never,
      coreRead: ({ signal } = {}) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    },
  });

  await assert.rejects(
    service.query({
      query: 'deadline',
      sources: ['atomic', 'conversation', 'skill', 'core'],
      resultLimit: 1,
      charBudget: 512,
      deadlineMs: 25,
    }),
    (error) => error instanceof QueryError && error.category === 'all_sources_failed',
  );
  assert.equal(signals.length, 4);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals.every((signal) => signal instanceof AbortSignal && signal.aborted), true);
});

test('caps Core reservation at 1500 characters and truncates items on Unicode boundaries', async () => {
  const service = new UnifiedQueryService({ gatewayClient: {
    atomicSearch: async () => ({ items: [{ id: 'a', type: 'fact', content: `${'😀'.repeat(2000)}tail`, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', score: 1 }] }),
    coreRead: async () => ({ content: 'c'.repeat(4000) }),
  } });
  const result = await service.query({ query: 'q', sources: ['atomic', 'core'], resultLimit: 1, charBudget: 3500, deadlineMs: 100, maxItemChars: 3000 });
  assert.equal([...result.coreContent].length, 1500);
  assert.equal([...result.hits[0].content].length <= 2000, true);
  assert.equal(result.hits[0].content.includes('\uFFFD'), false);
  assert.match(result.hits[0].content, /<TRUNCATED original_chars=2004>$/);
});

test('throws a safe error when every requested source fails', async () => {
  const gatewayClient = {
    atomicSearch: async () => { throw new Error('secret-one'); },
    skillSearch: async () => { throw new Error('secret-two'); },
  };
  const service = new UnifiedQueryService({ gatewayClient });
  await assert.rejects(
    service.query({ query: 'q', sources: ['atomic', 'skill'], resultLimit: 2, charBudget: 512, deadlineMs: 50 }),
    (error) => error instanceof QueryError && error.category === 'all_sources_failed' && !error.message.includes('secret'),
  );
});
