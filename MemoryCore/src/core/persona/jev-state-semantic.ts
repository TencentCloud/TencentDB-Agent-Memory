/**
 * Semantic JEV state overflow handling.
 *
 * `trim` shrinks an oversized JEV payload positionally: it chops the largest
 * scene in half and keeps the head and tail. The cut lands wherever the byte
 * budget runs out, so the paragraphs the decision most needs can be the ones
 * that disappear — and the decision then reasons over a mutilated scene.
 *
 * This module takes a different route: it asks a model to rewrite the
 * oversized scene into a shorter but semantically faithful version — stale or
 * superseded facts dropped, repeated narration collapsed, every still-valid
 * fact kept — and re-serializes the payload with the rewritten content.
 *
 * The result is lossy in *content* rather than in *position*: what survives is
 * still a true description of the scene, so the decision sees real
 * information instead of a chopped middle.
 *
 * The model call is injected as a plain function so this module stays testable
 * without a network, and so the caller can decide which runner/provider to
 * use. Everything here is side-effect free: nothing is written back to disk —
 * the gate only needs a smaller payload for the *current* decision.
 *
 * Env knobs (all optional; defaults preserve upstream behavior):
 *   JEV_SEMANTIC_MAX_TOKENS     max tokens for the rewrite call, default 16000
 *   JEV_SEMANTIC_TIMEOUT_MS      timeout for the rewrite call, default 120000
 *   JEV_SEMANTIC_MIN_RATIO       minimum fraction of the original that must
 *                                survive, default 0.2 — guards against a
 *                                model that returns an empty or stub answer
 *   JEV_SEMANTIC_MAX_SCENES      how many scenes to compress per pass,
 *                                default 4 — larger sets are handled by
 *                                repeated passes
 *   JEV_SEMANTIC_CHUNK_CHARS     maximum characters per rewrite request,
 *                                default 3000 — the body is rewritten in
 *                                pieces of this size
 */

import type { JevStatePayload } from "./jev-state-trim.js";

export const JEV_SEMANTIC_MAX_TOKENS_DEFAULT = 16_000;
export const JEV_SEMANTIC_TIMEOUT_MS_DEFAULT = 120_000;
export const JEV_SEMANTIC_MIN_RATIO_DEFAULT = 0.2;
export const JEV_SEMANTIC_MAX_SCENES_DEFAULT = 4;
export const JEV_SEMANTIC_CHUNK_CHARS_DEFAULT = 3_000;
/** Chunks below this size are kept as they are instead of being rewritten. */
export const JEV_SEMANTIC_MIN_CHUNK_CHARS_DEFAULT = 200;
/**
 * Target length of a rewritten chunk, as a fraction of the original.
 *
 * Without a target a model treats "shorter" as a light edit and returns
 * something barely smaller than the input, which does not free enough room
 * to matter.
 */
export const JEV_SEMANTIC_TARGET_RATIO_DEFAULT = 0.5;

export function resolveJevSemanticTargetRatio(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEV_SEMANTIC_TARGET_RATIO?.trim();
  if (raw && /^[0-9]*\.?[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0 && parsed < 1) return parsed;
  }
  return JEV_SEMANTIC_TARGET_RATIO_DEFAULT;
}

/**
 * Maximum size of one rewrite request, in characters.
 *
 * The chunk size is what keeps the rewrite usable in practice: a request with
 * a large body is either rejected by a gateway wall clock (504) or answered by
 * a reasoning model that spends the whole token budget thinking and returns no
 * body. Sections are rewritten in pieces of this size instead.
 */
export function resolveJevSemanticChunkChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEV_SEMANTIC_CHUNK_CHARS?.trim();
  if (raw && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed >= 200) return parsed;
  }
  return JEV_SEMANTIC_CHUNK_CHARS_DEFAULT;
}

export function resolveJevSemanticMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEV_SEMANTIC_MAX_TOKENS?.trim();
  if (raw && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0) return parsed;
  }
  return JEV_SEMANTIC_MAX_TOKENS_DEFAULT;
}

export function resolveJevSemanticTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEV_SEMANTIC_TIMEOUT_MS?.trim();
  if (raw && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0) return parsed;
  }
  return JEV_SEMANTIC_TIMEOUT_MS_DEFAULT;
}

export function resolveJevSemanticMinRatio(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEV_SEMANTIC_MIN_RATIO?.trim();
  if (!raw) return JEV_SEMANTIC_MIN_RATIO_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return JEV_SEMANTIC_MIN_RATIO_DEFAULT;
  return parsed;
}

export function resolveJevSemanticMaxScenes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEV_SEMANTIC_MAX_SCENES?.trim();
  if (raw && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0) return parsed;
  }
  return JEV_SEMANTIC_MAX_SCENES_DEFAULT;
}

/**
 * A model call that rewrites one scene body. Returns the rewritten body, or
 * an empty string / null when the model produced nothing usable.
 */
export type SemanticRewriteFn = (input: {
  filename: string;
  content: string;
  maxTokens: number;
  timeoutMs: number;
}) => Promise<string | null | undefined>;

export interface JevSemanticResult {
  /** Re-serialized state payload after the semantic pass. */
  state: string;
  /** Serialized length before the semantic pass. */
  originalChars: number;
  /** Serialized length after the semantic pass. */
  finalChars: number;
  /** Chars saved by the semantic pass. */
  savedChars: number;
  /** Scenes whose body was rewritten. */
  compressedScenes: string[];
  /** Scenes left untouched (already small, or the rewrite failed). */
  skippedScenes: string[];
}

export interface JevSemanticOutcome {
  /**
   * The compressed payload, or `null` when the payload still does not fit —
   * the caller then falls back to the positional trim policy.
   */
  result: JevSemanticResult | null;
  /** Per-scene failure reasons, reported even when the pass did not succeed. */
  failures: Array<{ filename: string; reason: string }>;
  /** Scenes that were rewritten successfully. */
  compressedScenes: string[];
  /** Scenes left untouched (already small, or the rewrite failed). */
  skippedScenes: string[];
}

/** Serialized size of a payload, using the same JSON shape the gate sends. */
export function measureJevState(payload: JevStatePayload): number {
  return JSON.stringify(payload).length;
}

/**
 * Strip a model answer down to the rewritten body.
 *
 * Models wrap answers in markdown fences, prepend preambles, or append
 * trailing commentary. A preamble is not scene content and would pollute the
 * payload the decision reads, so it is removed. If the answer cannot be
 * recognized as content at all, the original is kept.
 */
export function normalizeRewrittenBody(raw: string): string {
  let text = raw.trim();
  if (!text) return "";
  // Remove a leading fenced block, keeping the content inside it.
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/;
  const fenced = text.match(fence);
  if (fenced) text = fenced[1].trim();
  // Drop a leading "here is the compressed version" style preamble: a first
  // line that is prose rather than a markdown heading.
  const lines = text.split("\n");
  if (lines.length > 1 && !lines[0].trimStart().startsWith("#")) {
    const headingIdx = lines.findIndex((l) => l.trimStart().startsWith("#"));
    if (headingIdx > 0) text = lines.slice(headingIdx).join("\n").trim();
  }
  return text.trim();
}

/**
 * Check that a rewritten body is plausible: non-empty, big enough relative to
 * the original, and not obviously truncated mid-sentence.
 *
 * A model that hits its token limit returns `finish_reason: length` and the
 * body ends mid-word; that must be rejected rather than sent to the decision
 * provider, otherwise the decision reads a half-scene.
 */
export function validateRewrittenBody(
  rewritten: string,
  original: string,
  minRatio: number,
): { ok: true } | { ok: false; reason: string } {
  if (!rewritten) return { ok: false, reason: "empty_output" };
  if (rewritten.length < Math.floor(original.length * minRatio)) {
    return { ok: false, reason: "too_small" };
  }
  if (rewritten.length >= original.length) {
    return { ok: false, reason: "not_shrunk" };
  }
  // A body cut mid-sentence usually ends without terminal punctuation.
  const tail = rewritten.slice(-24).trim();
  if (tail.length > 0 && !/[.!?。！？：:;；)\]}】」』"'\`]$/.test(tail)) {
    return { ok: false, reason: "possibly_truncated" };
  }
  return { ok: true };
}

/**
 * Split a scene body into independently rewritable chunks.
 *
 * A whole-scene rewrite is one large request, which two things break in
 * practice: a reasoning model spends its token budget thinking and returns no
 * body at all, and a gateway with a per-request wall clock answers 504 before
 * the model is done. Chunking by markdown section keeps every request small
 * enough for both, and it also lets a partially failed chunk stay as the
 * original text instead of losing the whole scene.
 *
 * Sections are split on markdown headings; a section that is still too long
 * is cut on blank lines, and the pieces keep the heading of the section they
 * belong to, so the reassembled body keeps its outline.
 */
export function splitSceneBody(body: string, maxChunkChars: number, minChunkChars = 200): string[] {
  const limit = Math.max(minChunkChars, Math.floor(maxChunkChars));
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  // Split into markdown sections, keeping the heading with its content.
  const sections: string[] = [];
  let current = "";
  for (const line of trimmed.split("\n")) {
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading && current.trim()) {
      sections.push(current.trim());
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current.trim()) sections.push(current.trim());

  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= limit) {
      chunks.push(section);
      continue;
    }
    // Too long: cut on blank lines, keeping the heading on the first piece.
    const headingMatch = section.match(/^(#{1,6}\s.*)\n/);
    const heading = headingMatch ? headingMatch[1] : "";
    const rest = headingMatch ? section.slice(headingMatch[0].length) : section;
    let buffer = heading ? heading + "\n\n" : "";
    for (const para of rest.split(/\n{2,}/)) {
      const candidate = buffer ? `${buffer}\n\n${para}` : para;
      if (candidate.length > limit && buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = para;
      } else {
        buffer = candidate;
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
  }
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Build the rewrite prompt. Kept separate so it can be asserted in tests.
 *
 * The body arrives one section at a time, so the prompt asks for a section
 * rather than a whole document, and it names a target length: without one, a
 * model treats "shorter" as a light edit and returns something barely smaller
 * than the input, which defeats the whole point of the pass.
 */
export function buildSemanticRewritePrompt(
  filename: string,
  content: string,
  opts: { targetRatio?: number } = {},
): string {
  const targetRatio = opts.targetRatio ?? 0.5;
  const targetChars = Math.max(200, Math.round(content.length * targetRatio));
  return [
    "你是一个记忆库整理器。下面是某个用户某个主题的记忆文档中的一个章节。",
    "",
    `任务：把这一节改写成**更短但信息不丢**的版本，目标长度约 ${targetChars} 字符（原文约 ${content.length} 字符）。`,
    "",
    "必须遵守：",
    "1. **删除过时/已被推翻的内容**：已被后续状态取代的旧事实、已完成的临时任务记录、重复的复述流水、只记热度的元记录。",
    "2. **保留当前仍然成立的**：硬事实、规则/铁律、当前架构与状态、偏好、未决的问题。",
    "3. **保留章节结构**：保留原文的 markdown 标题层级，不要凭空新增章节。",
    "4. **演变轨迹**类章节只留关键转变点（3-8 条），不要留流水账。",
    "5. **不要发明原文没有的事实**。",
    "6. 输出**只有改写后的正文**，不要任何前言、解释、代码块围栏。",
    "7. 结尾必须是完整句子，不要在句子中间截断。",
    "",
    `原文件：${filename}`,
    "",
    "原文：",
    "---",
    content,
  ].join("\n");
}

/**
 * Compress the payload until it fits `limit` by rewriting scene bodies.
 *
 * Scenes are compressed largest-first, because the largest bodies carry the
 * most redundancy. Every scene keeps its filename, summary and updated stamp;
 * only the body is replaced. When a rewrite fails or produces something
 * implausible, that scene is left as-is and the failure is recorded — a
 * partial result is still better than dropping the whole payload.
 *
 * Returns `null` only when the payload cannot be brought under the limit at
 * all; the caller then falls back to the positional trim policy.
 */
export async function compressJevStateSemantically(
  payload: JevStatePayload,
  limit: number,
  rewrite: SemanticRewriteFn,
  opts: {
    maxTokens?: number;
    timeoutMs?: number;
    minRatio?: number;
    maxScenes?: number;
    chunkChars?: number;
    minChunkChars?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<JevSemanticOutcome> {
  const env = opts.env ?? process.env;
  const maxTokens = opts.maxTokens ?? resolveJevSemanticMaxTokens(env);
  const timeoutMs = opts.timeoutMs ?? resolveJevSemanticTimeoutMs(env);
  const minRatio = opts.minRatio ?? resolveJevSemanticMinRatio(env);
  const maxScenes = opts.maxScenes ?? resolveJevSemanticMaxScenes(env);
  const chunkChars = opts.chunkChars ?? resolveJevSemanticChunkChars(env);
  // A chunk below this size is kept as it is: rewriting it costs a request
  // and a wait, and it cannot free enough room to matter.
  const minChunkChars = opts.minChunkChars ?? JEV_SEMANTIC_MIN_CHUNK_CHARS_DEFAULT;

  const original = measureJevState(payload);
  const scenes = payload.changed_scenes.map((scene) => ({ ...scene }));
  const working: JevStatePayload = { ...payload, changed_scenes: scenes };
  const compressed: string[] = [];
  const skipped: string[] = [];
  const failures: Array<{ filename: string; reason: string }> = [];

  if (original <= limit) {
    return {
      result: {
        state: JSON.stringify(working),
        originalChars: original,
        finalChars: original,
        savedChars: 0,
        compressedScenes: [],
        skippedScenes: [],
      },
      failures,
      compressedScenes: [],
      skippedScenes: [],
    };
  }

  // Largest body first — it holds the most redundancy and buys the most room.
  const order = scenes
    .map((scene, index) => ({ index, len: scene.content.length }))
    .sort((a, b) => b.len - a.len)
    .map((entry) => entry.index);

  for (const index of order) {
    if (measureJevState(working) <= limit) break;
    if (compressed.length >= maxScenes) break;
    const scene = scenes[index];
    if (!scene.content || scene.content.length === 0) continue;

    // Rewrite the body chunk by chunk. A chunk that cannot be rewritten keeps
    // its original text, so a partial failure still yields a usable scene.
    const chunks = splitSceneBody(scene.content, chunkChars);
    const rewrittenChunks: string[] = [];
    let chunkFailures = 0;
    // Net characters saved by the chunks that were rewritten. Comparing the
    // reassembled lengths instead would count the join separators, and a body
    // whose chunks barely shrank would look unchanged even though it did.
    let savedChars = 0;
    for (const chunk of chunks) {
      // A chunk that is already tiny costs a request and a wait but cannot
      // shrink much; it is kept as it is.
      if (chunk.length < minChunkChars) {
        rewrittenChunks.push(chunk);
        continue;
      }
      let rewritten: string | null | undefined;
      try {
        rewritten = await rewrite({
          filename: scene.filename,
          content: chunk,
          maxTokens,
          timeoutMs,
        });
      } catch (error) {
        chunkFailures += 1;
        failures.push({
          filename: scene.filename,
          reason: `chunk_error:${error instanceof Error ? error.message : String(error)}`,
        });
        rewrittenChunks.push(chunk);
        continue;
      }
      const body = normalizeRewrittenBody(typeof rewritten === "string" ? rewritten : "");
      const verdict = validateRewrittenBody(body, chunk, minRatio);
      if (!verdict.ok) {
        chunkFailures += 1;
        failures.push({ filename: scene.filename, reason: `chunk_${verdict.reason}` });
        rewrittenChunks.push(chunk);
        continue;
      }
      savedChars += chunk.length - body.length;
      rewrittenChunks.push(body);
    }

    const rewrittenBody = rewrittenChunks.join("\n\n");
    // A scene where nothing was rewritten, or where the rewrite did not make
    // the body smaller, is left as it was.
    if (chunkFailures >= chunks.length || savedChars <= 0) {
      failures.push({ filename: scene.filename, reason: "no_effective_compression" });
      skipped.push(scene.filename);
      continue;
    }
    scene.content = rewrittenBody;
    compressed.push(scene.filename);
  }

  const state = JSON.stringify(working);
  const finalChars = state.length;
  // A payload that still does not fit is reported with `result: null` so the
  // caller can fall back to the positional trim policy. The failure detail is
  // still reported, so a partially successful pass is diagnosable.
  if (finalChars > limit) {
    return { result: null, failures, compressedScenes: compressed, skippedScenes: skipped };
  }
  return {
    result: {
      state,
      originalChars: original,
      finalChars,
      savedChars: original - finalChars,
      compressedScenes: compressed,
      skippedScenes: skipped,
    },
    failures,
    compressedScenes: compressed,
    skippedScenes: skipped,
  };
}
