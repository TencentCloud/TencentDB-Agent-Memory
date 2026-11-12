/**
 * auto-recall hook (v3): injects relevant memories + persona into agent context
 * before the agent starts processing.
 *
 * - Searches L1 memories using configurable strategy (keyword / embedding / hybrid)
 *   - keyword: FTS5 BM25 (requires FTS5; returns empty if unavailable)
 *   - embedding: VectorStore cosine similarity
 *   - hybrid: keyword + embedding merged with RRF
 * - L3 persona injection
 * - L2 scene navigation (full injection, LLM decides relevance)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { formatForLLM } from "../../utils/time.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import type { MemoryRecord } from "../record/l1-reader.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService, EmbeddingCallOptions } from "../store/embedding.js";
import { sanitizeText } from "../../utils/sanitize.js";
import type { Logger } from "../types.js";
import { RecallCachePolicy, stableHash, type RecallItem } from "./recall-cache-policy.js";

const TAG = "[memory-tdai] [recall]";
const RECALL_TRUNCATION_SUFFIX = "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;
const RECALL_LINE_SEPARATOR = "\n";

/**
 * Memory tools usage guide — injected at the end of memory context so the
 * main agent knows how to actively retrieve deeper information.
 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **tdai_memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。
- **tdai_conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。
- **read_file**（Scene Navigation 中的路径）：当已定位到相关情境，且需要该场景的完整画像、事件经过或阶段结论时使用。

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。
</memory-tools-guide>`

/** A single recalled L1 memory with its search score and type. */
export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
}

/** Diagnostics describing what the prompt-cache stability policy did this turn. */
export interface RecallCacheDiagnostics {
  /** 1-based recall turn index within the session. */
  turn: number;
  /** Reason code from `RecallCachePolicy.resolveSystemContext`. */
  systemContextReason: string;
  /** True when a newer system context was deliberately withheld to keep the prefix stable. */
  systemContextWithheld: boolean;
  /** Number of recalled memories skipped because they were already injected this session. */
  dedupSkipped: number;
  /** Number of memories actually injected after dedup + budget. */
  injected: number;
}

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (persona, scene nav, tools guide — cacheable) */
  appendSystemContext?: string;

  // ── Metric payload (for pendingRecallCache in index.ts) ──
  /** L1 memories that were recalled (with scores), for metric reporting */
  recalledL1Memories?: RecalledMemory[];
  /** L3 Persona raw content loaded during recall (null if none) */
  recalledL3Persona?: string | null;
  /** Effective search strategy used */
  recallStrategy?: string;
  /** Prompt-cache stability policy diagnostics (undefined when the policy is off) */
  cacheDiagnostics?: RecallCacheDiagnostics;
}

export interface AutoRecallParams {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  /**
   * Prompt-cache stability policy. Owned by the caller (TdaiCore) so state
   * survives across turns. Omit to keep the legacy inject-everything behaviour.
   */
  cachePolicy?: RecallCachePolicy;
}

/**
 * Guard shared between the recall body and its timeout race.
 *
 * When the race is lost, the (still running) inner call must not commit
 * de-duplication bookkeeping: the host already discarded the result, so those
 * memories were never shown and must remain eligible for a later turn.
 */
interface AbandonToken {
  abandoned: boolean;
}

export async function performAutoRecall(params: AutoRecallParams): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const timeoutMs = cfg.recall.timeoutMs ?? 5000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const token: AbandonToken = { abandoned: false };

  return Promise.race([
    performAutoRecallInner(params, token).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        token.abandoned = true;
        logger?.warn?.(
          `${TAG} ⚠️ Recall timed out after ${timeoutMs}ms — skipping memory injection to avoid blocking the user`,
        );
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
}

async function performAutoRecallInner(
  params: AutoRecallParams,
  token: AbandonToken = { abandoned: false },
): Promise<RecallResult | undefined> {
  const { userText, sessionKey, cfg, pluginDataDir, logger, vectorStore, embeddingService, cachePolicy } = params;
  const tRecallStart = performance.now();

  const policyActive = !!cachePolicy && cachePolicy.options.enabled;
  const turnIndex = policyActive ? cachePolicy!.beginTurn(sessionKey) : 0;

  // Search relevant memories (L1 layer) — skip only when userText is empty/undefined
  const tSearchStart = performance.now();
  let memoryItems: RecallItem[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let searchTiming: SearchTiming = { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 };
  let dedupSkipped = 0;
  if (!userText || userText.length === 0) {
    logger?.debug?.(`${TAG} User text empty/undefined, skipping memory search (persona/scene still injected)`);
  } else {
    effectiveStrategy = cfg.recall.strategy ?? "hybrid";
    const searchResult = await searchMemories(userText, pluginDataDir, cfg, logger, effectiveStrategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService);
    memoryItems = searchResult.items;
    searchTiming = searchResult.timing;

    // Session-level de-duplication runs *before* the character budget so the
    // budget is spent on genuinely new information rather than on repeats.
    if (policyActive) {
      const decision = cachePolicy!.filterMemories(sessionKey, memoryItems);
      dedupSkipped = decision.skippedIds.length;
      memoryItems = decision.kept;
    }

    memoryItems = applyRecallBudget(memoryItems, cfg.recall, logger);

    // Only what survived dedup + budget is recorded as "already shown".
    if (policyActive && !token.abandoned) {
      cachePolicy!.commitInjected(sessionKey, memoryItems.map((m) => m.id));
    }

    // Structured payload for metric reporting — taken straight from the search
    // results instead of re-parsing the rendered line with a regex.
    recalledL1Memories = memoryItems.map((m) => ({ content: m.content, score: 0, type: m.type }));
  }
  const tSearchEnd = performance.now();

  // Read persona (L3 layer)
  const tPersonaStart = performance.now();
  let personaContent: string | undefined;
  try {
    const personaPath = path.join(pluginDataDir, "persona.md");
    const raw = await fs.readFile(personaPath, "utf-8");
    personaContent = stripSceneNavigation(raw).trim();
    if (!personaContent) personaContent = undefined;
    logger?.debug?.(`${TAG} Persona loaded: ${personaContent ? `${personaContent.length} chars` : "empty"}`);
  } catch {
    logger?.debug?.(`${TAG} No persona file found (expected for new users)`);
  }
  const tPersonaEnd = performance.now();

  // Load full scene navigation (L2 layer)
  const tSceneStart = performance.now();
  let sceneNavigation: string | undefined;
  try {
    const sceneIndex = await readSceneIndex(pluginDataDir);
    if (sceneIndex.length > 0) {
      sceneNavigation = generateSceneNavigation(sceneIndex, pluginDataDir, {
        stable: policyActive && cachePolicy!.options.stabilizeSceneNavigation,
      });
      logger?.debug?.(`${TAG} Scene navigation generated: ${sceneIndex.length} scenes`);
    }
  } catch {
    logger?.debug?.(`${TAG} No scene index found`);
  }
  const tSceneEnd = performance.now();

  // Nothing fresh to inject. Bail out *unless* the session already holds a
  // frozen system context: a transient read failure (persona.md being rewritten
  // by the L3 pipeline, scene index mid-write) must not silently drop the
  // cached prefix, which would cost a full re-prefill on the next turn.
  const hasFrozen = policyActive && cachePolicy!.hasFrozenSystemContext(sessionKey);
  if (memoryItems.length === 0 && !personaContent && !sceneNavigation && !hasFrozen) {
    const totalMs = performance.now() - tRecallStart;
    logger?.info(
      `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
      `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryItems.length},` +
      `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
      `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
      `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms, ` +
      `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms — no context to inject`,
    );
    logger?.debug?.(`${TAG} No memories/persona/scenes to inject`);
    return undefined;
  }

  // Split recall context into stable and dynamic parts to optimize prompt caching.
  //
  // appendSystemContext (system prompt end — stable, cacheable):
  //   persona, scene navigation, memory tools guide
  //   These change infrequently; when content is identical across turns,
  //   providers with prompt caching (Anthropic/OpenAI) can cache this region.
  //
  // prependContext (user prompt prefix — dynamic, per-turn):
  //   L1 relevant memories — different every turn, moved out of system prompt
  //   so it doesn't bust the system prompt cache.
  const stableParts: string[] = [];
  if (personaContent) {
    stableParts.push(`<user-persona>\n${personaContent}\n</user-persona>`);
  }
  if (sceneNavigation) {
    stableParts.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);
  }

  // Dynamic part: L1 relevant memories (changes every turn) → prependContext (user prompt)
  let prependContext: string | undefined;
  if (memoryItems.length > 0) {
    const lines = memoryItems.map((m) => m.line).join(RECALL_LINE_SEPARATOR);
    prependContext =
      `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${lines}\n</relevant-memories>`;
  }

  // Append memory tools usage guide to the stable part so the agent knows
  // how to actively retrieve deeper context when the injected snippets
  // are not enough. This is static content and benefits from caching.
  //
  // Under the cache policy the guide is attached whenever *any* stable part
  // exists, independent of this turn's dynamic recall: making its presence
  // depend on `prependContext` would toggle the system-prompt tail on and off
  // between turns, which is exactly the churn we are trying to remove.
  const attachGuide = policyActive
    ? stableParts.length > 0
    : stableParts.length > 0 || !!prependContext;
  if (attachGuide) {
    stableParts.push(MEMORY_TOOLS_GUIDE);
  }

  const freshSystemContext = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;

  // Freeze the stable block for the session so background L2/L3 pipeline writes
  // cannot invalidate the provider's prefix cache mid-conversation.
  let appendSystemContext = freshSystemContext;
  let systemContextReason = "policy-off";
  let systemContextWithheld = false;
  if (policyActive) {
    const decision = cachePolicy!.resolveSystemContext(sessionKey, freshSystemContext);
    appendSystemContext = decision.text;
    systemContextReason = decision.reason;
    systemContextWithheld = decision.withheld;
  }

  const totalMs = performance.now() - tRecallStart;
  logger?.info(
    `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
    `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryItems.length},` +
    `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
    `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
    `persona=${(tPersonaEnd - tPersonaStart).toFixed(0)}ms(${personaContent ? `${personaContent.length}chars` : "none"}), ` +
    `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms(${sceneNavigation ? "loaded" : "none"})` +
    (policyActive
      ? `, cache(turn=${turnIndex},sys=${systemContextReason},dedupSkipped=${dedupSkipped},` +
        `sysHash=${appendSystemContext ? stableHash(appendSystemContext) : "none"})`
      : ""),
  );

  if (!appendSystemContext && !prependContext) {
    return undefined;
  }

  return {
    prependContext,
    appendSystemContext,
    recalledL1Memories,
    recalledL3Persona: personaContent ?? null,
    recallStrategy: effectiveStrategy,
    cacheDiagnostics: policyActive
      ? {
          turn: turnIndex,
          systemContextReason,
          systemContextWithheld,
          dedupSkipped,
          injected: memoryItems.length,
        }
      : undefined,
  };
}

// ============================
// Multi-strategy search dispatcher
// ============================

interface ScoredRecord {
  record: MemoryRecord;
  score: number;
}

/** Timing breakdown from memory search */
interface SearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

interface SearchResult {
  items: RecallItem[];
  timing: SearchTiming;
}

/**
 * Build the injectable item for a recalled record.
 *
 * `id` is the store's record id — the de-duplication key.  When a backend does
 * not supply one we fall back to a content hash, which is still stable enough
 * to detect a repeat of the same memory within a session.
 */
function toRecallItem(id: string | undefined, m: FormatableMemory): RecallItem {
  return {
    id: id && id.length > 0 ? id : `h:${stableHash(`${m.type}\u0000${m.content}`)}`,
    type: m.type,
    content: m.content,
    line: formatMemoryLine(m),
  };
}

/**
 * Search memories using the configured strategy.
 *
 * - "keyword": JSONL keyword-based (Jaccard similarity) — no embedding needed
 * - "embedding": VectorStore cosine similarity — requires vectorStore + embeddingService
 * - "hybrid": merge both keyword and embedding results with RRF (Reciprocal Rank Fusion)
 *
 * Falls back to keyword if embedding resources are unavailable.
 */
async function searchMemories(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<SearchResult> {
  const emptyResult: SearchResult = { items: [], timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 } };
  // Strip gateway-injected inbound metadata (Sender, timestamps, media markers,
  // base64 image data, etc.) so FTS / embedding queries are based on pure user intent.
  const cleanText = sanitizeText(userText);

  if (cleanText.length < 2) {
    logger?.debug?.(`${TAG} Query too short for memory search (raw=${userText.length}, clean=${cleanText.length})`);
    return emptyResult;
  }

  if (cleanText.length !== userText.length) {
    logger?.debug?.(
      `${TAG} userText sanitized: ${userText.length} → ${cleanText.length} chars`,
    );
  }

  const maxResults = cfg.recall.maxResults ?? 5;
  const threshold = cfg.recall.scoreThreshold ?? 0.3;

  const embeddingAvailable = !!vectorStore && !!embeddingService;

  logger?.debug?.(
    `${TAG} [searchMemories] strategy=${strategy}, embeddingAvailable=${embeddingAvailable}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}, ` +
    `maxResults=${maxResults}, threshold=${threshold}`,
  );

  // Determine effective strategy (fall back to keyword if embedding not available)
  let effectiveStrategy = strategy;
  if ((strategy === "embedding" || strategy === "hybrid") && !embeddingAvailable) {
    logger?.warn?.(
      `${TAG} Strategy "${strategy}" requested but EmbeddingService not available, falling back to keyword`,
    );
    effectiveStrategy = "keyword";
  }

  logger?.debug?.(`${TAG} Search strategy: ${effectiveStrategy} (configured: ${strategy})`);

  // Resolve per-call embedding timeout for recall path.
  // Falls back to global embedding.timeoutMs when recallTimeoutMs is not configured.
  const recallEmbeddingTimeoutMs = cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  const embeddingCallOpts: EmbeddingCallOptions = { timeoutMs: recallEmbeddingTimeoutMs };

  try {
    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const items = await searchByKeyword(cleanText, pluginDataDir, maxResults, threshold, logger, vectorStore);
      return { items, timing: { ftsMs: performance.now() - tFts, embeddingMs: 0, ftsHits: items.length, embeddingHits: 0 } };
    }

    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const items = await searchByEmbedding(cleanText, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts);
      return { items, timing: { ftsMs: 0, embeddingMs: performance.now() - tEmb, ftsHits: 0, embeddingHits: items.length } };
    }

    // Hybrid: if the store natively supports hybrid search (e.g. TCVDB does
    // server-side dense + sparse + RRF in a single API call), short-circuit
    // to avoid a redundant second HTTP request and a wasted local embed().
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      const results = await vectorStore.searchL1Hybrid({ query: cleanText, topK: maxResults });
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(`${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms`);
      const items = results.map((r) => toRecallItem(r.record_id, vectorResultToFormatable(r)));
      return { items, timing: { ftsMs: 0, embeddingMs: nativeMs, ftsHits: 0, embeddingHits: results.length } };
    }

    // Fallback: run keyword + embedding in parallel, merge with client-side RRF (SQLite path)
    return await searchHybrid(cleanText, pluginDataDir, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts);
  } catch (err) {
    logger?.warn?.(`${TAG} Memory search failed (strategy=${effectiveStrategy}): ${err instanceof Error ? err.message : String(err)}`);
    return emptyResult;
  }
}

// ============================
// Strategy: Keyword (FTS5 BM25, no in-memory fallback)
// ============================

async function searchByKeyword(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  logger?: Logger,
  vectorStore?: IMemoryStore,
): Promise<RecallItem[]> {
  // Prefer FTS5 if available
  if (vectorStore?.isFtsAvailable()) {
    const ftsQuery = buildFtsQuery(userText);
    if (ftsQuery) {
      logger?.debug?.(`${TAG} [keyword-fts] Using FTS5 BM25 search: query="${ftsQuery}"`);
      const ftsResults = await vectorStore.searchL1Fts(ftsQuery, maxResults * 2);
      if (ftsResults.length > 0) {
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 raw results (${ftsResults.length}): ` +
          ftsResults.map((r) => `id=${r.record_id} score=${r.score.toFixed(6)}`).join(", "),
        );
        const filtered = ftsResults
          .filter((r) => r.score >= threshold)
          .slice(0, maxResults);

        if (filtered.length > 0) {
          logger?.debug?.(`${TAG} [keyword-fts] FTS5 found ${filtered.length} results (from ${ftsResults.length} raw, threshold=${threshold})`);
          return filtered.map((r) => toRecallItem(r.record_id, ftsResultToFormatable(r)));
        }

        // BM25 absolute scores are unreliable when the document set is very
        // small (e.g. 1–3 records) because IDF approaches 0.  In that case,
        // trust FTS5's MATCH + rank ordering and return the top results anyway.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(
            `${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} ` +
            `but document set is small — returning all matched results`,
          );
          return ftsResults.slice(0, maxResults).map((r) => toRecallItem(r.record_id, ftsResultToFormatable(r)));
        }
        logger?.debug?.(`${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`);
      }
    }
  }

  // FTS5 not available or returned no results — skip in-memory fallback to avoid O(N) full scan
  logger?.debug?.(`${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`);
  return [];
}

// ============================
// Strategy: Embedding (VectorStore cosine)
// ============================

async function searchByEmbedding(
  userText: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
): Promise<RecallItem[]> {
  logger?.debug?.(
    `${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`,
  );
  const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  // Retrieve more candidates for subsequent filtering
  const vecResults: L1SearchResult[] = await vectorStore.searchL1Vector(queryEmbedding, maxResults * 2);

  if (vecResults.length === 0) {
    logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`);
    return [];
  }

  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, filtering by threshold=${threshold}`);
  for (const r of vecResults) {
    logger?.debug?.(
      `${TAG} [embedding-search] candidate id=${r.record_id}, score=${r.score.toFixed(4)}, ` +
      `type=${r.type}, content="${r.content.slice(0, 60)}..."`,
    );
  }

  const filtered = vecResults
    .filter((r) => r.score >= threshold)
    .slice(0, maxResults);

  if (filtered.length > 0) {
    logger?.debug?.(`${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`);
    return filtered.map((r) => toRecallItem(r.record_id, vectorResultToFormatable(r)));
  }

  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return [];
}

// ============================
// Strategy: Hybrid (Keyword + Embedding + RRF)
// ============================

/**
 * Hybrid search: run keyword (FTS5) and embedding in parallel, merge with
 * Reciprocal Rank Fusion (RRF) to combine rank lists.
 *
 * RRF score for a record at rank r = 1 / (k + r), where k=60 is a constant.
 * If a record appears in both lists, its RRF scores are summed.
 *
 * If FTS5 is unavailable, the keyword side returns empty and RRF uses
 * embedding results only.
 */
async function searchHybrid(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  _threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
): Promise<SearchResult> {
  // Run keyword and embedding searches in parallel
  const candidateK = maxResults * 3; // retrieve more for merging

  const [keywordResult, embeddingResult] = await Promise.all([
    // Keyword search: FTS5 only (no in-memory fallback)
    (async () => {
      const tStart = performance.now();
      try {
        // Try FTS5 first
        if (vectorStore.isFtsAvailable()) {
          const ftsQuery = buildFtsQuery(userText);
          if (ftsQuery) {
            const ftsResults = await vectorStore.searchL1Fts(ftsQuery, candidateK);
            if (ftsResults.length > 0) {
              logger?.debug?.(`${TAG} [hybrid-keyword-fts] FTS5 found ${ftsResults.length} candidates`);
              // Convert FtsSearchResult to ScoredRecord for RRF merge
              const records = ftsResults.map((r): ScoredRecord => ({
                record: {
                  id: r.record_id,
                  content: r.content,
                  type: r.type as MemoryRecord["type"],
                  priority: r.priority,
                  scene_name: r.scene_name,
                  source_message_ids: [],
                  metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
                  timestamps: [r.timestamp_str].filter(Boolean),
                  createdAt: "",
                  updatedAt: "",
                  sessionKey: r.session_key,
                  sessionId: r.session_id,
                },
                score: r.score,
              }));
              return { records, ms: performance.now() - tStart };
            }
          }
        }
        // FTS5 not available or returned no results — skip in-memory fallback
        logger?.debug?.(`${TAG} [hybrid-keyword] FTS5 unavailable or no results, skipping keyword part`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: keyword part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      }
    })(),
    // Embedding search
    (async () => {
      const tStart = performance.now();
      try {
        logger?.debug?.(`${TAG} [hybrid-embedding] Generating query embedding...`);
        const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
        logger?.debug?.(
          `${TAG} [hybrid-embedding] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const results = await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText);
        logger?.debug?.(`${TAG} [hybrid-embedding] Got ${results.length} candidates`);
        return { results, ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { results: [] as L1SearchResult[], ms: performance.now() - tStart };
      }
    })(),
  ]);

  const keywordResults = keywordResult.records;
  const embeddingResults = embeddingResult.results;
  const timing: SearchTiming = {
    ftsMs: keywordResult.ms,
    embeddingMs: embeddingResult.ms,
    ftsHits: keywordResults.length,
    embeddingHits: embeddingResults.length,
  };

  if (keywordResults.length === 0 && embeddingResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: both strategies returned 0 results`);
    return { items: [], timing };
  }

  // RRF merge: k=60 is a standard constant from the RRF paper
  const RRF_K = 60;

  // Map: record_id → { rrfScore, formatable }
  const mergedMap = new Map<string, { rrfScore: number; formatable: FormatableMemory }>();

  // Process keyword results
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank];
    const id = r.record.id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      mergedMap.set(id, { rrfScore, formatable: recordToFormatable(r.record) });
    }
  }

  // Process embedding results
  for (let rank = 0; rank < embeddingResults.length; rank++) {
    const r = embeddingResults[rank];
    const id = r.record_id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      mergedMap.set(id, { rrfScore, formatable: vectorResultToFormatable(r) });
    }
  }

  // Sort by combined RRF score and take top results
  const sorted = [...mergedMap.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
    .slice(0, maxResults);

  if (sorted.length > 0) {
    logger?.debug?.(
      `${TAG} Hybrid search found ${sorted.length} results ` +
      `(keyword=${keywordResults.length}, embedding=${embeddingResults.length})`,
    );
    return { items: sorted.map(([id, { formatable }]) => toRecallItem(id, formatable)), timing };
  }

  logger?.debug?.(`${TAG} Hybrid search: no results after merge`);
  return { items: [], timing };
}

// ============================
// Unified memory line formatter
// ============================

/**
 * Format a single memory record into a rich natural-language line for prompt injection.
 *
 * Time semantics:
 *   - timestamp (点时间): when the activity/event happened, e.g. "2025-03-01 mentioned something"
 *   - activity_start_time / activity_end_time (段时间): activity time range, e.g. "trip from 2025-05-01 to 2025-05-10"
 *   - All three time fields may be empty/undefined — handled gracefully.
 *
 * Output examples:
 *   - [persona] 用户叫王小明，30岁，是一名软件工程师。
 *   - [episodic|旅行计划] 用户计划五月去日本旅行。(活动时间: 2025-05-01 ~ 2025-05-10)
 *   - [episodic] 用户今天加班到很晚。(活动时间: 2025-03-01)
 *   - [instruction] 用户要求回答时使用中文，保持简洁。
 */
interface FormatableMemory {
  type: string;
  content: string;
  scene_name?: string;
  /** Activity time range start (段时间 start), may be empty */
  activity_start_time?: string;
  /** Activity time range end (段时间 end), may be empty */
  activity_end_time?: string;
  /** Activity point-in-time (点时间: when it happened), may be empty */
  timestamp?: string;
}

function formatMemoryLine(m: FormatableMemory): string {
  // 1. Type tag + optional scene name
  const tag = m.scene_name ? `${m.type}|${m.scene_name}` : m.type;

  // 2. Content (core)
  let line = `- [${tag}] ${m.content}`;

  // 3. Time info — prefer activity_start/end range; fall back to timestamp as point-in-time
  const start = formatTimestamp(m.activity_start_time);
  const end = formatTimestamp(m.activity_end_time);
  const point = formatTimestamp(m.timestamp);

  if (start && end) {
    // 段时间: both start and end
    line += ` (活动时间: ${start} ~ ${end})`;
  } else if (start) {
    // 段时间: only start
    line += ` (活动时间: ${start}起)`;
  } else if (end) {
    // 段时间: only end
    line += ` (活动时间: 至${end})`;
  } else if (point) {
    // 点时间: single timestamp
    line += ` (活动时间: ${point})`;
  }
  // If all three are empty → no time info appended (graceful)

  return line;
}

function applyRecallBudget(
  items: RecallItem[],
  recall: MemoryTdaiConfig["recall"],
  logger?: Logger,
): RecallItem[] {
  const maxCharsPerMemory = normalizeBudgetLimit(recall.maxCharsPerMemory);
  const maxTotalRecallChars = normalizeBudgetLimit(recall.maxTotalRecallChars);

  if (!maxCharsPerMemory && !maxTotalRecallChars) {
    return items;
  }

  const budgeted: RecallItem[] = [];
  let usedChars = 0;
  let truncatedCount = 0;
  let droppedCount = 0;

  const withLine = (item: RecallItem, line: string): RecallItem =>
    line === item.line ? item : { ...item, line };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const line = item.line;
    const perMemoryBounded = maxCharsPerMemory
      ? truncateRecallLine(line, maxCharsPerMemory)
      : line;
    let wasTruncated = perMemoryBounded !== line;

    if (!maxTotalRecallChars) {
      budgeted.push(withLine(item, perMemoryBounded));
      if (wasTruncated) truncatedCount++;
      continue;
    }

    const separatorChars = budgeted.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
    const remainingChars = maxTotalRecallChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      droppedCount += items.length - i;
      break;
    }

    if (perMemoryBounded.length > remainingChars) {
      const canFit = remainingChars >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) {
        const totalBounded = truncateRecallLine(perMemoryBounded, remainingChars);
        budgeted.push(withLine(item, totalBounded));
        usedChars += separatorChars + totalBounded.length;
        wasTruncated ||= totalBounded !== perMemoryBounded;
        if (wasTruncated) truncatedCount++;
      }
      droppedCount += items.length - i - (canFit ? 1 : 0);
      break;
    }

    budgeted.push(withLine(item, perMemoryBounded));
    usedChars += separatorChars + perMemoryBounded.length;
    if (wasTruncated) truncatedCount++;
  }

  if (truncatedCount > 0 || droppedCount > 0) {
    logger?.debug?.(
      `${TAG} Recall budget applied: input=${items.length}, output=${budgeted.length}, ` +
      `truncated=${truncatedCount}, dropped=${droppedCount}, ` +
      `maxCharsPerMemory=${recall.maxCharsPerMemory}, maxTotalRecallChars=${recall.maxTotalRecallChars}`,
    );
  }

  return budgeted;
}

function normalizeBudgetLimit(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function truncateRecallLine(line: string, maxChars: number): string {
  // Count and slice by code point, not UTF-16 code unit, so a cut never lands
  // between the halves of a surrogate pair (which would corrupt a non-BMP
  // character to U+FFFD when the line is UTF-8 encoded for the request).
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length) {
    return cps.slice(0, maxChars).join("");
  }
  return `${cps.slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length).join("").trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}

/**
 * Format an ISO 8601 timestamp to a concise, timezone-aware string for display.
 * Uses the configured timezone (via time module).
 * - If the time part is 00:00:00 → show date only (e.g. "2025-03-01")
 * - Otherwise → show full ISO 8601 with offset (e.g. "2025-03-01T14:30:00+08:00")
 * - Returns undefined for empty/invalid inputs.
 */
function formatTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return undefined;

  // Check if time part is midnight UTC (date-only semantics)
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?/);
  if (match) {
    const timePart = match[2];
    if (!timePart || timePart === "00:00") {
      return match[1]; // date-only, no timezone conversion needed
    }
  }

  return formatForLLM(ts);
}

/**
 * Build a FormatableMemory from a full MemoryRecord (keyword search path).
 * Handles empty metadata, empty timestamps array gracefully.
 */
function recordToFormatable(record: MemoryRecord): FormatableMemory {
  const meta = record.metadata as { activity_start_time?: string; activity_end_time?: string } | undefined;
  return {
    type: record.type,
    content: record.content,
    scene_name: record.scene_name || undefined,
    activity_start_time: meta?.activity_start_time || undefined,
    activity_end_time: meta?.activity_end_time || undefined,
    timestamp: (record.timestamps && record.timestamps.length > 0) ? record.timestamps[0] : undefined,
  };
}

/**
 * Build a FormatableMemory from a VectorSearchResult (embedding search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function vectorResultToFormatable(r: L1SearchResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}

/**
 * Build a FormatableMemory from an FtsSearchResult (FTS5 keyword search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function ftsResultToFormatable(r: L1FtsResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}
