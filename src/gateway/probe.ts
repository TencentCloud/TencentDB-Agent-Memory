/**
 * Recall quality probe (wave tdai-memory-subagents-2026-08-02, improvement #1).
 *
 * Fixed query corpus with KNOWN good answers lives in `dataDir/probe-corpus.json`
 * (configurable: `memory.probe.corpusPath`). The gateway runs the probe after
 * each consolidation run (which covers both "after reindex" and "night timer"
 * triggers — reindex happens inside the run, and the night timer is the run
 * driver) and reports precision@k into the run report, the dashboard and the
 * digest.
 *
 * Precision semantics (documented, deterministic):
 *   per-query precision@k = (# expected answers found in the top-k retrieved
 *   set) / min(topK, #expected). A retrieved content is "the answer" when it
 *   CONTAINS an expected substring (trimmed, non-empty). Mean over queries =
 *   overall precision@k. top1HitRate = fraction of queries whose rank-1
 *   result is relevant.
 *
 * Fail-open: a missing/malformed corpus or unavailable store/embedding makes
 * the probe report `skipped` — it never fails the run or the gateway.
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryTdaiConfig } from "../config.js";
import type { Logger } from "../core/types.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { searchMemoriesWithDetails } from "../core/hooks/auto-recall.js";

// ============================
// Types
// ============================

/** One corpus entry: a query with its known good answers (content substrings). */
export interface ProbeQuery {
  id: string;
  query: string;
  /** Known-good answers — non-empty substrings of record content. */
  expected: string[];
}

export interface ProbeCorpus {
  queries: ProbeQuery[];
}

/** Per-query probe outcome (ranked retrieval, raw contents). */
export interface ProbePerQuery {
  id: string;
  /** Retrieved contents in rank order (up to topK). */
  top: string[];
  /** Number of expected answers present in the top-k retrieved set. */
  hits: number;
}

export interface ProbeResult {
  status: "ok" | "skipped" | "failed";
  /** Number of corpus queries. */
  queries: number;
  /** Effective top-k (probe.topK). */
  topK: number;
  /** Mean per-query precision@k in [0,1]; null when nothing was evaluated. */
  precisionAtK: number | null;
  /** Fraction of queries whose rank-1 result was relevant; null when nothing evaluated. */
  top1HitRate: number | null;
  evaluated: ProbePerQuery[];
  /** Skip/failure explanation (fail-open). */
  reason?: string;
}

/** Search abstraction injected for testability; returns ranked contents. */
export type ProbeSearchFn = (query: string) => Promise<Array<{ content: string }>>;

// ============================
// Corpus loading (fail-open)
// ============================

/**
 * Read + parse the probe corpus. Returns null on any failure (missing file,
 * malformed JSON, wrong shape) — the probe then reports `skipped`.
 */
export function loadProbeCorpus(corpusPath: string): ProbeCorpus | null {
  let raw: string;
  try {
    raw = fs.readFileSync(corpusPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { queries?: unknown }).queries)) {
      return null;
    }
    const queries: ProbeQuery[] = [];
    for (const q of (parsed as { queries: unknown[] }).queries) {
      if (!q || typeof q !== "object") continue;
      const qq = q as { id?: unknown; query?: unknown; expected?: unknown };
      if (typeof qq.id !== "string" || typeof qq.query !== "string" || !qq.query.trim()) continue;
      const expected = Array.isArray(qq.expected)
        ? qq.expected.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim())
        : [];
      if (expected.length === 0) continue;
      queries.push({ id: qq.id, query: qq.query, expected });
    }
    return queries.length > 0 ? { queries } : null;
  } catch {
    return null;
  }
}

// ============================
// Precision computation (pure)
// ============================

/** Is a retrieved content "the answer" for the expected list? */
export function isRelevant(retrievedContent: string, expected: string[]): boolean {
  const haystack = retrievedContent.trim();
  if (!haystack) return false;
  return expected.some((e) => haystack.includes(e));
}

/**
 * Compute precision@k + top1 hit rate over a corpus using an injected search.
 * `topK` = retrieval window per query (cfg.probe.topK).
 */
export async function computeProbeResults(
  corpus: ProbeCorpus,
  topK: number,
  search: ProbeSearchFn,
): Promise<ProbeResult> {
  const evaluated: ProbePerQuery[] = [];
  let totalHits = 0;
  let top1Hits = 0;
  const k = topK > 0 ? topK : 3;

  for (const q of corpus.queries) {
    let top: string[];
    try {
      const results = (await search(q.query)) ?? [];
      top = results.slice(0, k).map((r) => r.content);
    } catch {
      // A single query failing is a probe failure for that query — count 0 hits.
      top = [];
    }
    const relevant = top.filter((c) => isRelevant(c, q.expected));
    const hits = relevant.length;
    const denom = Math.min(k, q.expected.length);
    totalHits += denom > 0 ? hits / denom : 0;
    if (top.length > 0 && relevant.length > 0) top1Hits += 1;
    evaluated.push({ id: q.id, top, hits });
  }

  const queries = corpus.queries.length;
  if (queries === 0) {
    return { status: "skipped", queries: 0, topK: k, precisionAtK: null, top1HitRate: null, evaluated, reason: "empty corpus" };
  }

  return {
    status: "ok",
    queries,
    topK: k,
    precisionAtK: totalHits / queries,
    top1HitRate: top1Hits / queries,
    evaluated,
  };
}

// ============================
// Real search (recall pipeline)
// ============================

/** Default search = the actual recall pipeline (strategy + typeWeights). */
async function searchViaRecall(
  query: string,
  dataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<Array<{ content: string }>> {
  const result = await searchMemoriesWithDetails(
    query,
    dataDir,
    cfg,
    logger,
    (cfg.recall.strategy ?? "hybrid") as "keyword" | "embedding" | "hybrid",
    vectorStore,
    embeddingService,
  );
  return result.memories;
}

/**
 * Run the probe end-to-end (corpus load + real recall search + precision).
 * Fail-open: skipped (not failed) when the corpus is missing/unusable or the
 * recall resources are unavailable.
 */
export async function runRecallProbe(opts: {
  dataDir: string;
  cfg: MemoryTdaiConfig;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
  /** Injectable search (tests); defaults to the real recall pipeline. */
  search?: ProbeSearchFn;
}): Promise<ProbeResult> {
  const { dataDir, cfg, vectorStore, embeddingService, logger } = opts;
  const corpusPath = path.isAbsolute(cfg.probe.corpusPath)
    ? cfg.probe.corpusPath
    : path.join(dataDir, cfg.probe.corpusPath);

  const corpus = loadProbeCorpus(corpusPath);
  if (!corpus) {
    return {
      status: "skipped",
      queries: 0,
      topK: cfg.probe.topK,
      precisionAtK: null,
      top1HitRate: null,
      evaluated: [],
      reason: `probe corpus not found or unusable (${corpusPath})`,
    };
  }

  if (!vectorStore || !embeddingService) {
    return {
      status: "skipped",
      queries: corpus.queries.length,
      topK: cfg.probe.topK,
      precisionAtK: null,
      top1HitRate: null,
      evaluated: [],
      reason: "vector store or embedding service unavailable",
    };
  }

  const search = opts.search ?? ((query) => searchViaRecall(query, dataDir, cfg, logger, vectorStore, embeddingService));
  return computeProbeResults(corpus, cfg.probe.topK, search);
}
