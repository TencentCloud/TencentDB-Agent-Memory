/**
 * MongoDB Atlas `$search` (mongot / Lucene) index definitions + idempotent
 * ensure-and-wait helpers for the phase-1 keyword BM25 backend.
 *
 * Design (D6/D7):
 *   - We pre-segment Chinese with jieba into a space-joined `tokens` field, then
 *     index it with the `lucene.whitespace` analyzer so Lucene never re-segments
 *     — write-side and query-side tokens line up across sqlite/tcvdb/mongo.
 *   - BM25 is Lucene's default scoring for the `text` operator; the resulting
 *     `$meta:"searchScore"` is normalized to 0–1 downstream (D12).
 *   - Isolation dimensions are indexed as `token` so they can be pushed into
 *     `$search.compound.filter` (`equals`), keeping the post-filter `$limit`
 *     correct for multi-tenant recall (T3).
 */

import type { Collection, Document } from "mongodb";

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** Search index name for L0/L1 memory collections. */
export const MEMORY_SEARCH_INDEX = "memory_search";
/** Search index name for the skills collection. */
export const SKILL_SEARCH_INDEX = "skill_search";

/** Analyzer used for the pre-segmented `tokens` field (no re-segmentation). */
const WHITESPACE_ANALYZER = "lucene.whitespace";

/** L0/L1 memory search index: keyword field + isolation token filters. */
export const MEMORY_SEARCH_DEFINITION: Document = {
  mappings: {
    dynamic: false,
    fields: {
      tokens: { type: "string", analyzer: WHITESPACE_ANALYZER, searchAnalyzer: WHITESPACE_ANALYZER },
      team_id: { type: "token" },
      user_id: { type: "token" },
      agent_id: { type: "token" },
      task_id: { type: "token" },
      session_id: { type: "token" },
      session_key: { type: "token" },
    },
  },
};

/** Skill search index: name+description tokens + head/status/isolation filters. */
export const SKILL_SEARCH_DEFINITION: Document = {
  mappings: {
    dynamic: false,
    fields: {
      search_tokens: { type: "string", analyzer: WHITESPACE_ANALYZER, searchAnalyzer: WHITESPACE_ANALYZER },
      team_id: { type: "token" },
      owner_agent_id: { type: "token" },
      user_id: { type: "token" },
      task_id: { type: "token" },
      status: { type: "token" },
      is_head: { type: "boolean" },
    },
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EnsureSearchIndexOptions {
  /** Max time to wait for the index to become queryable. Default 60s. */
  waitMs?: number;
  /** Poll interval while waiting. Default 500ms. */
  pollMs?: number;
  logger?: Logger;
}

/**
 * Idempotently create the named `$search` index and wait until it is queryable.
 *
 * @returns `true` if the index exists and is queryable, `false` if the wait
 *          timed out. **Throws** (fail-loud, D13) if the deployment does not
 *          support `$search` at all (no `mongot` — `createSearchIndex` errors);
 *          the caller catches this to derive `searchIndexReady=false` and
 *          degrade the `ftsSearch` capability rather than silently mis-scoring.
 */
export async function ensureSearchIndex(
  collection: Collection,
  name: string,
  definition: Document,
  opts: EnsureSearchIndexOptions = {},
): Promise<boolean> {
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 500;
  const logger = opts.logger;

  const existing = await listSearchIndexSafe(collection, name);
  if (!existing) {
    try {
      await collection.createSearchIndex({ name, definition });
      logger?.info?.(`[mongo-search] created search index "${name}" on ${collection.collectionName}`);
    } catch (e) {
      // Race: another store instance created it between list + create.
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists|duplicate/i.test(msg)) {
        logger?.debug?.(`[mongo-search] index "${name}" already exists (race), continuing`);
      } else {
        throw e;
      }
    }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const idx = await listSearchIndexSafe(collection, name);
    if (idx?.queryable) {
      logger?.debug?.(`[mongo-search] index "${name}" queryable on ${collection.collectionName}`);
      return true;
    }
    await sleep(pollMs);
  }
  logger?.warn?.(`[mongo-search] index "${name}" not queryable within ${waitMs}ms on ${collection.collectionName}`);
  return false;
}

interface SearchIndexInfo {
  name: string;
  queryable?: boolean;
  status?: string;
}

async function listSearchIndexSafe(
  collection: Collection,
  name: string,
): Promise<SearchIndexInfo | null> {
  const cursor = collection.listSearchIndexes(name);
  const rows = (await cursor.toArray()) as unknown as SearchIndexInfo[];
  return rows.find((r) => r.name === name) ?? rows[0] ?? null;
}
