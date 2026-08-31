import { sha256 } from './hash.js';
import { compareFusedHits, fuseRankedHits } from './rank-fusion.js';
import { truncateWithMarker, unicodeLength } from './text-budget.js';

const validSources = new Set(['atomic', 'conversation', 'core', 'skill']);
const contentKey = (content) => sha256(content.normalize('NFKC').trim().replace(/\s+/gu, ' '));

export class QueryError extends Error {
  constructor(category) {
    super(`Memory query failed: ${category}`);
    this.name = 'QueryError';
    this.category = category;
  }
}

export function normalizeQuery(value) {
  if (typeof value !== 'string') throw new QueryError('invalid_query');
  const query = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (query.length < 1 || [...query].length > 2000) throw new QueryError('invalid_query');
  return query;
}

const stableId = (source, id, content) => `${source}:${typeof id === 'string' && id ? id : `sha256:${contentKey(content)}`}`;
const atomicHits = (data) => data.items.map((item) => ({
  stableId: stableId('atomic', item.id, item.content), content: item.content.trim(),
  timestamp: typeof item.updated_at === 'string' ? item.updated_at : undefined,
  metadata: { type: typeof item.type === 'string' ? item.type : null },
})).filter((item) => item.content);
const conversationHits = (data) => data.messages.map((item) => ({
  stableId: stableId('conversation', item.id, item.content), content: item.content.trim(),
  timestamp: item.timestamp,
  metadata: { role: item.role },
})).filter((item) => item.content);
const skillHits = (data) => data.items.map((item) => ({
  stableId: stableId('skill', item.id, item.content), content: item.content.trim(),
  timestamp: item.timestamp,
  metadata: { name: item.name, version: item.version, status: item.status },
})).filter((item) => item.content);

export class UnifiedQueryService {
  constructor({ gatewayClient, monotonicNow = () => performance.now() } = {}) {
    this.gatewayClient = gatewayClient;
    this.monotonicNow = monotonicNow;
  }

  async query({ query: rawQuery, sources, resultLimit, charBudget, deadlineMs, timeStart, timeEnd, maxItemChars = 1500 } = {}) {
    const query = normalizeQuery(rawQuery);
    if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => !validSources.has(source))) throw new QueryError('invalid_sources');
    if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 100) throw new QueryError('invalid_limit');
    if (!Number.isInteger(charBudget) || charBudget < 1) throw new QueryError('invalid_budget');
    if (!Number.isInteger(maxItemChars) || maxItemChars < 1 || maxItemChars > 3000) throw new QueryError('invalid_item_budget');
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 3000) throw new QueryError('invalid_deadline');
    const deadline = this.monotonicNow() + deadlineMs;
    const bySource = {};
    let coreContent = null;
    const degradedSources = [];
    const settledSources = new Set();
    let successes = 0;
    const remaining = () => Math.max(0, deadline - this.monotonicNow());
    const run = async (source) => {
      try {
        if (source === 'atomic') bySource.atomic = atomicHits(await this.gatewayClient.atomicSearch(query, resultLimit, { timeoutMs: remaining() }));
        if (source === 'conversation') bySource.conversation = conversationHits(await this.gatewayClient.conversationSearch(query, resultLimit, { timeStart, timeEnd, timeoutMs: remaining() }));
        if (source === 'skill') bySource.skill = skillHits(await this.gatewayClient.skillSearch(query, resultLimit, { timeoutMs: remaining() }));
        if (source === 'core') {
          const data = await this.gatewayClient.coreRead({ timeoutMs: remaining() });
          coreContent = typeof data.content === 'string' && data.content.trim() ? data.content.trim() : null;
        }
        successes += 1;
      } catch {
        degradedSources.push(source);
      } finally {
        settledSources.add(source);
      }
    };
    const selectedSources = [...new Set(sources)];
    const tasks = selectedSources.map(run);
    let timer;
    await Promise.race([
      Promise.all(tasks),
      new Promise((resolve) => { timer = setTimeout(resolve, deadlineMs); }),
    ]);
    clearTimeout(timer);
    for (const source of selectedSources) {
      if (!settledSources.has(source) && !degradedSources.includes(source)) degradedSources.push(source);
    }
    degradedSources.sort((a, b) => [...validSources].indexOf(a) - [...validSources].indexOf(b));
    if (successes === 0) throw new QueryError('all_sources_failed');

    const fused = fuseRankedHits(bySource);
    const seenContent = new Map();
    const deduped = [];
    for (const hit of fused) {
      const key = contentKey(hit.content);
      const existing = seenContent.get(key);
      if (existing) {
        const existingSources = new Set(existing.metadata.sources ?? [existing.source]);
        const incomingSources = hit.metadata.sources ?? [hit.source];
        if (incomingSources.some((source) => !existingSources.has(source))) existing.fusedScore += hit.fusedScore;
        for (const source of incomingSources) existingSources.add(source);
        existing.metadata.sources = [...existingSources].sort((a, b) => [...validSources].indexOf(a) - [...validSources].indexOf(b));
        existing.metadata.also_from = existing.metadata.sources.filter((source) => source !== existing.source);
        existing.sourceRank = Math.min(existing.sourceRank, hit.sourceRank);
        continue;
      }
      seenContent.set(key, hit);
      deduped.push(hit);
    }
    deduped.sort(compareFusedHits);
    if (coreContent && unicodeLength(coreContent) > 1500) coreContent = truncateWithMarker(coreContent, 1500);
    const reservedCore = coreContent ? unicodeLength(coreContent) : 0;
    let remainingChars = Math.max(0, charBudget - reservedCore);
    const hits = [];
    let truncated = deduped.length > resultLimit || reservedCore > charBudget;
    for (const hit of deduped.slice(0, resultLimit)) {
      if (remainingChars === 0) { truncated = true; break; }
      const allowed = Math.min(maxItemChars, remainingChars);
      const content = truncateWithMarker(hit.content, allowed);
      if (!content) { truncated = true; break; }
      if (unicodeLength(content) < unicodeLength(hit.content)) truncated = true;
      hits.push({ ...hit, content });
      remainingChars -= unicodeLength(content);
    }
    if (coreContent && unicodeLength(coreContent) > charBudget) {
      coreContent = truncateWithMarker(coreContent, charBudget);
      truncated = true;
    }
    return { hits, coreContent, degradedSources, truncated };
  }
}
