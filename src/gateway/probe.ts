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
import type { RecallDiagnostic, RecallItem } from "../core/hooks/auto-recall.js";

// ============================
// Types
// ============================

/** One corpus entry: a query with its known good answers (content substrings). */
export interface ProbeQuery {
  id: string;
  query: string;
  /** Known-good answers — non-empty substrings of record content. */
  expected: string[];
  /**
   * Project this query is asked from. Without it the query measures recall
   * with no project context — a separate baseline that is never mixed into the
   * leakage numbers (tz-10 C10.4).
   */
  projectId?: string;
  /**
   * Foreign-project negatives: contents that MUST NOT come back for this
   * query. A hit on one of them is leakage, counted and reported per item.
   */
  foreignExpected?: string[];
  /**
   * Record ids that ARE the answer (tz-04 C1a/C2). Matching by id is what
   * makes `precision@k` and `recall@k` mean what they say: a substring can
   * match several retrieved rows and count one answer twice.
   */
  expectedRecordIds?: string[];
  /** L1 type of the expected record — one axis of the strata (tz-04 C1). */
  expectedType?: "instruction" | "persona" | "episodic";
  /** Whether the answer lives in the query's own project or another one. */
  scopeRelation?: "own" | "foreign";
  /** Where the query text came from: the store's content or the owner. */
  origin?: "store-derived" | "owner-task";
}

/** The six strata of tz-04 C1: type × scope relation. */
export type StratumKey = `${NonNullable<ProbeQuery["expectedType"]>}/${NonNullable<ProbeQuery["scopeRelation"]>}`;

/** The four metrics tz-04 C2 asks for, at both cut-offs. */
export interface ProbeMetrics {
  precisionAt5: number;
  precisionAt10: number;
  recallAt5: number;
  recallAt10: number;
}

/** One stratum's metrics plus how many pairs stand behind them. */
export interface ProbeStratum extends ProbeMetrics {
  queries: number;
}

export interface ProbeCorpus {
  queries: ProbeQuery[];
}

/** One retrieved item as the probe recorded it (tz-10 C10.4). */
export interface ProbeItem {
  memoryId: string;
  content: string;
  /** Project the record is tagged to ('' / undefined = untagged). */
  projectId?: string;
  /** 'global' | 'project' | undefined. */
  scope?: string;
  /**
   * Score as the strategy produced it, before its own multipliers. On the
   * native-hybrid path the store already ranked and downweighted the row, so
   * `raw` equals `final` there — `final < raw` is evidence of decay only on
   * the JS legs (keyword / embedding / RRF hybrid).
   */
  raw: number;
  /** Score after decay / type weights — what the ranking used. */
  final: number;
  /** Why the final score is what it is (decay:*, type-weight:*, …). */
  reasons: string[];
  /** Matched one of the query's expected answers. */
  relevant: boolean;
  /** Matched a foreign-project negative — this is leakage. */
  foreign: boolean;
}

/** Per-query probe outcome (ranked retrieval with item-level diagnostics). */
export interface ProbePerQuery {
  id: string;
  /** Stratum this query belongs to, "" when the entry carries no strata. */
  stratum: StratumKey | "";
  /** Metrics for this query alone (tz-04 C2). */
  metrics: ProbeMetrics;
  /** Project context the query was asked with ("" = none). */
  projectId: string;
  /** Retrieved contents in rank order (up to topK). */
  top: string[];
  /** Number of expected answers present in the top-k retrieved set. */
  hits: number;
  /** Retrieved items in rank order, with identity, scope and both scores. */
  items: ProbeItem[];
  /** How many foreign-project negatives made it into the top-k. */
  foreignHits: number;
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
  /**
   * Fraction of project-scoped queries that retrieved a foreign-project
   * negative. `null` when no corpus query carries BOTH a projectId and
   * foreignExpected — a query asked without project context is a separate
   * baseline and must not be averaged in (tz-10 C10.4 / S4).
   */
  leakageRate: number | null;
  evaluated: ProbePerQuery[];
  /** Mean precision@5/@10 and recall@5/@10 over the corpus (tz-04 C2). */
  metrics: ProbeMetrics;
  /** The same four metrics per stratum — an aggregate hides a dead multiplier. */
  strata: Partial<Record<StratumKey, ProbeStratum>>;
  /**
   * The scoring this measurement belongs to. A metric without it cannot be
   * compared with a baseline: the number alone does not say what produced it.
   */
  scoringVersion: string;
  /** When the run happened (ISO 8601). */
  at: string;
  /** Recall-path notes collected while running the corpus (tz-10 C10.5). */
  diagnostics: RecallDiagnostic[];
  /** Skip/failure explanation (fail-open). */
  reason?: string;
}

/**
 * Search abstraction injected for testability; returns the ranked items the
 * recall pipeline produced, plus whatever it reports about the run. The probe
 * measures the real pipeline, so it passes the same project context a live
 * turn would (tz-10 C10.4).
 */
export type ProbeSearchFn = (
  query: string,
  projectId: string,
) => Promise<{ items: RecallItem[]; diagnostics?: RecallDiagnostic[] }>;

// ============================
// Corpus loading (fail-open)
// ============================

/** Non-empty trimmed strings out of an unknown JSON field. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim())
    : [];
}

/** The value when it is one of the allowed literals, else undefined. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

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
      const qq = q as {
        id?: unknown;
        query?: unknown;
        expected?: unknown;
        projectId?: unknown;
        foreignExpected?: unknown;
        expectedRecordIds?: unknown;
        expectedType?: unknown;
        scopeRelation?: unknown;
        origin?: unknown;
      };
      if (typeof qq.id !== "string" || typeof qq.query !== "string" || !qq.query.trim()) continue;
      const expected = strings(qq.expected);
      // A query with no positive answer is dropped: precision has no meaning
      // for it. A pure foreign-negative entry therefore never enters the corpus
      // — pair the negative with the positive it must not outrank.
      if (expected.length === 0) continue;
      queries.push({
        id: qq.id,
        query: qq.query,
        expected,
        projectId: typeof qq.projectId === "string" ? qq.projectId : undefined,
        foreignExpected: strings(qq.foreignExpected),
        expectedRecordIds: strings(qq.expectedRecordIds),
        expectedType: oneOf(qq.expectedType, ["instruction", "persona", "episodic"] as const),
        scopeRelation: oneOf(qq.scopeRelation, ["own", "foreign"] as const),
        origin: oneOf(qq.origin, ["store-derived", "owner-task"] as const),
      });
    }
    return queries.length > 0 ? { queries } : null;
  } catch {
    return null;
  }
}

// ============================
// Precision computation (pure)
// ============================

/**
 * Hits in the first `k` retrieved items: how many DISTINCT expected record ids
 * came back. Counting ids (not substring matches) is the whole point of tz-04
 * C2 — one retrieved row can contain several expected substrings, and one
 * expected substring can appear in several rows.
 */
export function hitsAtK(
  items: Array<{ memoryId: string }>,
  expectedRecordIds: string[],
  k: number,
): number {
  const expected = new Set(expectedRecordIds);
  const seen = new Set<string>();
  for (const item of items.slice(0, k)) {
    if (expected.has(item.memoryId)) seen.add(item.memoryId);
  }
  return seen.size;
}

/**
 * precision@k = hits/k, recall@k = hits/|expected| (tz-04 C2). `k` is the
 * cut-off, NOT the number of rows actually returned: a short answer list must
 * not earn a free 1.0. `|expected|` counts distinct ids, so a duplicated id in
 * the corpus cannot deflate recall.
 */
export function metricsFor(
  items: Array<{ memoryId: string }>,
  expectedRecordIds: string[],
): ProbeMetrics {
  const expectedCount = new Set(expectedRecordIds).size;
  const at = (k: number): { p: number; r: number } => {
    const hits = hitsAtK(items, expectedRecordIds, k);
    return { p: hits / k, r: expectedCount > 0 ? hits / expectedCount : 0 };
  };
  const five = at(5);
  const ten = at(10);
  return {
    precisionAt5: five.p,
    precisionAt10: ten.p,
    recallAt5: five.r,
    recallAt10: ten.r,
  };
}

/** Mean of each metric over the queries; zero queries → all zeros. */
export function meanMetrics(all: ProbeMetrics[]): ProbeMetrics {
  const n = all.length;
  const mean = (pick: (m: ProbeMetrics) => number): number =>
    n === 0 ? 0 : all.reduce((sum, m) => sum + pick(m), 0) / n;
  return {
    precisionAt5: mean((m) => m.precisionAt5),
    precisionAt10: mean((m) => m.precisionAt10),
    recallAt5: mean((m) => m.recallAt5),
    recallAt10: mean((m) => m.recallAt10),
  };
}

/**
 * A one-line fingerprint of the scoring that produced a measurement. Built from
 * the ACTUAL config values, never hardcoded: a baseline number is meaningless
 * without knowing which knobs stood behind it (tz-04 C2).
 */
export function scoringVersionOf(cfg: MemoryTdaiConfig): string {
  const r = cfg.recall;
  const weights = Object.entries(r.typeWeights ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, weight]) => `${type}=${weight}`)
    .join(",");
  return [
    `strategy=${r.strategy ?? "hybrid"}`,
    `threshold=${r.scoreThreshold ?? 0.2}`,
    `maxResults=${r.maxResults ?? 5}`,
    `crossProject=${r.crossProject ?? "hidden"}`,
    `crossProjectDecay=${r.crossProjectDecay ?? "-"}`,
    `defaultCrossProjectMultiplier=${r.defaultCrossProjectMultiplier ?? "-"}`,
    `typeWeights=${weights || "-"}`,
  ].join(" ");
}

/** The stratum a corpus entry belongs to, or "" when it is not stratified. */
export function stratumOf(q: ProbeQuery): StratumKey | "" {
  return q.expectedType && q.scopeRelation ? `${q.expectedType}/${q.scopeRelation}` : "";
}

/** Is a retrieved content "the answer" for the expected list? */
export function isRelevant(retrievedContent: string, expected: string[]): boolean {
  const haystack = retrievedContent.trim();
  if (!haystack) return false;
  return expected.some((e) => haystack.includes(e));
}

/**
 * Compute precision@k, top1 hit rate and foreign-project leakage over a corpus
 * using an injected search. `topK` = retrieval window per query (cfg.probe.topK).
 *
 * Leakage is averaged only over queries carrying BOTH a projectId and foreign
 * negatives: a query asked without project context measures something else and
 * stays a separate baseline (tz-10 C10.4).
 */
export async function computeProbeResults(
  corpus: ProbeCorpus,
  topK: number,
  search: ProbeSearchFn,
  meta: { scoringVersion?: string; at?: string } = {},
): Promise<ProbeResult> {
  const scoringVersion = meta.scoringVersion ?? "unknown";
  const at = meta.at ?? new Date().toISOString();
  const evaluated: ProbePerQuery[] = [];
  const diagnostics: RecallDiagnostic[] = [];
  let totalHits = 0;
  let top1Hits = 0;
  let leakageQueries = 0;
  let leakingQueries = 0;
  const measured: ProbeMetrics[] = [];
  const byStratum: Partial<Record<StratumKey, ProbeMetrics[]>> = {};
  const k = topK > 0 ? topK : 3;

  for (const q of corpus.queries) {
    const projectId = q.projectId ?? "";
    let items: RecallItem[] = [];
    try {
      const result = await search(q.query, projectId);
      items = (result.items ?? []).slice(0, k);
      for (const d of result.diagnostics ?? []) diagnostics.push(d);
    } catch (err) {
      // A single query failing is a probe failure for that query — count 0
      // hits, but say so instead of pretending the memory was empty.
      diagnostics.push({
        stage: "repo",
        code: "probe-query-failed",
        message: `${q.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const probeItems = items.map((item) => toProbeItem(item, q));
    const top = probeItems.map((i) => i.content);
    const hits = probeItems.filter((i) => i.relevant).length;
    const foreignHits = probeItems.filter((i) => i.foreign).length;
    const denom = Math.min(k, q.expected.length);
    totalHits += denom > 0 ? hits / denom : 0;
    if (probeItems.length > 0 && probeItems[0]!.relevant) top1Hits += 1;
    if (projectId && (q.foreignExpected?.length ?? 0) > 0) {
      leakageQueries += 1;
      if (foreignHits > 0) leakingQueries += 1;
    }
    // The id-based metrics only exist for entries carrying `expectedRecordIds`.
    // A legacy substring-only entry gets zeros here and is excluded from the
    // aggregate below — otherwise it would silently deflate every number.
    const expectedIds = q.expectedRecordIds ?? [];
    const metrics = metricsFor(items, expectedIds);
    const stratum = stratumOf(q);
    if (expectedIds.length > 0) {
      measured.push(metrics);
      if (stratum) (byStratum[stratum] ??= []).push(metrics);
    }
    evaluated.push({ id: q.id, stratum, metrics, projectId, top, hits, items: probeItems, foreignHits });
  }

  const queries = corpus.queries.length;
  const leakageRate = leakageQueries > 0 ? leakingQueries / leakageQueries : null;
  const strata: Partial<Record<StratumKey, ProbeStratum>> = {};
  for (const [key, all] of Object.entries(byStratum) as Array<[StratumKey, ProbeMetrics[]]>) {
    strata[key] = { ...meanMetrics(all), queries: all.length };
  }
  const metrics = meanMetrics(measured);
  if (queries === 0) {
    return { status: "skipped", queries: 0, topK: k, precisionAtK: null, top1HitRate: null, leakageRate, evaluated, metrics, strata, scoringVersion, at, diagnostics, reason: "empty corpus" };
  }

  return {
    status: "ok",
    queries,
    topK: k,
    precisionAtK: totalHits / queries,
    top1HitRate: top1Hits / queries,
    leakageRate,
    evaluated,
    metrics,
    strata,
    scoringVersion,
    at,
    diagnostics,
  };
}

/** Record what the pipeline returned, and how it relates to this query. */
function toProbeItem(item: RecallItem, q: ProbeQuery): ProbeItem {
  return {
    memoryId: item.memoryId,
    content: item.content,
    projectId: item.scope.projectId,
    scope: item.scope.scope,
    raw: item.score.raw,
    final: item.score.final,
    reasons: item.score.reasons,
    relevant: isRelevant(item.content, q.expected),
    foreign: isRelevant(item.content, q.foreignExpected ?? []),
  };
}

// ============================
// Real search (recall pipeline)
// ============================

/**
 * Default search = the actual recall pipeline (strategy + typeWeights), asked
 * with the query's own project context. Passing no projectId (as this did
 * before tz-10a) makes the probe blind to project isolation: every
 * cross-project row looks equally allowed.
 */
async function searchViaRecall(
  query: string,
  projectId: string,
  deps: {
    dataDir: string;
    cfg: MemoryTdaiConfig;
    logger?: Logger;
    vectorStore?: IMemoryStore;
    embeddingService?: EmbeddingService;
  },
): Promise<{ items: RecallItem[]; diagnostics: RecallDiagnostic[] }> {
  const { dataDir, cfg, logger, vectorStore, embeddingService } = deps;
  const result = await searchMemoriesWithDetails(
    query,
    dataDir,
    cfg,
    logger,
    (cfg.recall.strategy ?? "hybrid") as "keyword" | "embedding" | "hybrid",
    vectorStore,
    embeddingService,
    projectId,
  );
  return { items: result.items, diagnostics: result.diagnostics };
}

/**
 * The config the MEASURER runs with: the retrieval window is widened to
 * `probe.topK`. With the live `recall.maxResults` (5) the pipeline would hand
 * back five candidates and `@10` could never exceed 0.5 — a measurement
 * artefact, not a recall property. The live config is copied, never mutated.
 */
export function measuringConfig(cfg: MemoryTdaiConfig): MemoryTdaiConfig {
  const maxResults = cfg.recall.maxResults ?? 5;
  return cfg.probe.topK > maxResults
    ? { ...cfg, recall: { ...cfg.recall, maxResults: cfg.probe.topK } }
    : cfg;
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
      leakageRate: null,
      evaluated: [],
      metrics: meanMetrics([]),
      strata: {},
      scoringVersion: scoringVersionOf(cfg),
      at: new Date().toISOString(),
      diagnostics: [],
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
      leakageRate: null,
      evaluated: [],
      metrics: meanMetrics([]),
      strata: {},
      scoringVersion: scoringVersionOf(cfg),
      at: new Date().toISOString(),
      diagnostics: [],
      reason: "vector store or embedding service unavailable",
    };
  }

  const measuringCfg = measuringConfig(cfg);
  const search =
    opts.search ??
    ((query: string, projectId: string) =>
      searchViaRecall(query, projectId, {
        dataDir,
        cfg: measuringCfg,
        logger,
        vectorStore,
        embeddingService,
      }));
  return computeProbeResults(corpus, cfg.probe.topK, search, {
    scoringVersion: scoringVersionOf(measuringCfg),
  });
}
