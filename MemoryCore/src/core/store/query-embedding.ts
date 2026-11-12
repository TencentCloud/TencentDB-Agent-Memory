import type { EmbeddingCallOptions, EmbeddingService } from "./embedding.js";

const TTL_MS = 30_000;
const MAX_ENTRIES = 128;
type Entry = { expiresAt: number; vector: Promise<Float32Array> };
// The service instance owns its model, endpoint and credentials. Cache vectors
// only: every caller still performs its own store query and isolation filtering.
const caches = new WeakMap<EmbeddingService, Map<string, Entry>>();

export async function embedQuery(
  service: EmbeddingService,
  query: string,
  options?: EmbeddingCallOptions,
): Promise<Float32Array> {
  let cache = caches.get(service);
  if (!cache) {
    cache = new Map();
    caches.set(service, cache);
  }
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  const key = JSON.stringify([query, options?.timeoutMs ?? null]);
  const existing = cache.get(key);
  if (existing) return (await existing.vector).slice();
  // Keep pending work coalesced; at capacity, new distinct queries bypass cache.
  if (cache.size >= MAX_ENTRIES) return service.embed(query, options);

  const entry: Entry = { expiresAt: Infinity, vector: Promise.resolve().then(() => service.embed(query, options)) };
  cache.set(key, entry);
  try {
    const vector = await entry.vector;
    if (!vector.length) cache.delete(key);
    else entry.expiresAt = Date.now() + TTL_MS;
    return vector.slice();
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}
