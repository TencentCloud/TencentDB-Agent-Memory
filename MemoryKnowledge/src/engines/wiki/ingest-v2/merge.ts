/**
 * merge.ts — 页面合并 / 去重（dedup 的"合并内容"部分，PRD FR-4）。
 *
 * 当本次生成的页命中一个已存在的同 slug 页时：
 *   - 目标页 locked:true（用户经 page/write 手工编辑）→ 跳过，绝不覆盖（§3.7-1 硬约束）。
 *   - 未锁定 → 合并。
 *
 * 合并策略（OQ-1 token 优化，按旧页大小分档）：
 *   1. 规则判重：候选正文已被旧页覆盖（同源重复摄取）→ 不调 LLM，仅更新 sources 并集。
 *   2. 小页（旧正文 ≤ 阈值）→ 整页重写（质量最佳，旧页小，重写成本可接受）。
 *   3. 大页（旧正文 > 阈值）→ 追加模式：只让 LLM 产出"增量片段"并追加到旧页，
 *      旧页正文原样保留。省掉重新生成整页的 output token，并避免重写时丢失旧事实。
 *
 * 合并后会重算 frontmatter 的 sources 为「旧 sources ∪ 新 sources」并集，
 * 保证 raw/rm 级联清理可用（§3.7-3）。
 */

import type { LlmClient } from "./llm.js";
import { parseFrontmatter, buildPage, sourceEntries, mergeSources, type SourceEntry } from "./frontmatter.js";

export type MergeDecision =
  | { action: "write"; content: string }   // 新建或重写
  | { action: "skip"; reason: string };     // locked，跳过

export interface MergeOptions {
  /**
   * 旧页正文字符数超过此阈值则走「追加模式」（省 output token）；
   * 否则走整页重写（质量优先）。默认 4000。
   */
  fullRewriteMaxChars?: number;
}

/** 旧页正文超过此长度切到追加模式。 */
export const DEFAULT_FULL_REWRITE_MAX_CHARS = 4000;

/** 合并两个 sources 列表为去重并集。 */
export function unionSources(oldSources: string[], newSources: string[]): string[] {
  const set = new Set<string>();
  for (const s of [...oldSources, ...newSources]) {
    if (typeof s === "string" && s.trim()) set.add(s.trim());
  }
  return [...set];
}

/** 归一化正文用于规则判重：折叠空白、trim。 */
function normalizeForCompare(body: string): string {
  return (body ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 规则判重：候选正文是否已被旧页完全覆盖（无新增信息）。
 * 保守策略——仅当归一化后的候选正文非空且整体是旧页正文的子串时才判为冗余，
 * 避免误跳过真实新信息。典型命中：同一源未改动被重复摄取。
 */
export function isCandidateRedundant(oldBody: string, candidateBody: string): boolean {
  const cand = normalizeForCompare(candidateBody);
  if (!cand) return true; // 候选无正文 → 无新增
  const old = normalizeForCompare(oldBody);
  return old.includes(cand);
}

/**
 * 决定一个生成页面对一个已存在页应如何落盘。
 *
 * @param existingContent 已存在页的磁盘内容（null = 不存在，直接写）
 * @param candidateContent LLM 本次生成的候选页内容
 * @param llm 用于合并的客户端
 * @param options 合并行为（阈值等）
 */
export async function mergePage(
  existingContent: string | null,
  candidateContent: string,
  llm: LlmClient,
  options: MergeOptions = {},
): Promise<MergeDecision> {
  // 目标页不存在 → 直接写新页。
  if (existingContent == null) {
    return { action: "write", content: candidateContent };
  }

  // locked → 跳过，保护用户手工编辑。
  const oldParsed = parseFrontmatter(existingContent);
  if (oldParsed.frontmatter.locked === true) {
    return { action: "skip", reason: "目标页 locked，跳过合并" };
  }

  const candParsed = parseFrontmatter(candidateContent);
  if (oldParsed.frontmatter.type === "Attested Computation" || candParsed.frontmatter.type === "Attested Computation") {
    return { action: "skip", reason: "Attested computation contracts require explicit edits; LLM merge disabled" };
  }
  const union = mergeSources(sourceEntries(oldParsed.frontmatter.sources), sourceEntries(candParsed.frontmatter.sources));

  // OQ-1 优化①：规则判重——候选已被旧页覆盖，不调 LLM，仅更新 sources 并集。
  if (isCandidateRedundant(oldParsed.body, candParsed.body)) {
    return {
      action: "write",
      content: buildPage({ ...candParsed.frontmatter, ...oldParsed.frontmatter, verified: oldParsed.frontmatter.verified, sources: union }, oldParsed.body),
    };
  }

  const threshold = options.fullRewriteMaxChars ?? DEFAULT_FULL_REWRITE_MAX_CHARS;

  // OQ-1 优化②：大页走追加模式，省 output token 且不丢旧事实。
  if (oldParsed.body.length > threshold) {
    const merged = await appendMerge(oldParsed, candParsed, union, llm);
    return { action: "write", content: merged };
  }

  // 小页 → 整页重写（质量优先）。
  const merged = await rewriteMerge(existingContent, candidateContent, llm);
  return { action: "write", content: merged };
}

const MERGE_SYSTEM = `You are a knowledge base maintainer. Merge two markdown pages on the same topic into one.
Merge principles:
- Preserve facts from the old page that still hold true — do not lose information.
- Incorporate new information from the new page.
- If old and new conflict, keep both and explicitly note the disagreement.
- Maintain YAML frontmatter format (type is required). Do NOT output a \`locked\` field.
- Preserve and merge [[wikilink]] cross-references in the body.
- Output the complete merged page directly (including frontmatter) — no extra commentary, no FILE blocks.`;

const APPEND_SYSTEM = `You are a knowledge base maintainer. Given an [existing page body] and [new material],
output only the incremental information that the existing page does NOT yet contain,
written as a concise markdown fragment (may include [[wikilink]]).
Requirements:
- Do not repeat content already in the existing page.
- Do not paraphrase or rewrite the entire page — only produce the "new" part.
- Do not output frontmatter, FILE blocks, or any explanation.
- If the new material adds nothing beyond what the existing page already covers, return an empty string.`;

/** 调 LLM 做整页重写合并，并强制 sources 取旧 ∪ 新 并集。 */
async function rewriteMerge(
  existingContent: string,
  candidateContent: string,
  llm: LlmClient,
): Promise<string> {
  const prompt = `## Existing page (preserve its facts)
\`\`\`
${existingContent}
\`\`\`

## New page (merge its additions)
\`\`\`
${candidateContent}
\`\`\`

Output the merged complete page.`;

  const out = await llm.chat({ system: MERGE_SYSTEM, prompt, label: "merge-rewrite" });

  // 兜底：若 LLM 返回空或无 frontmatter，退回候选页，避免丢页。
  const mergedParsed = parseFrontmatter(out);
  if (!out.trim() || !mergedParsed.hasFrontmatter) {
    const old = parseFrontmatter(existingContent);
    const candidate = parseFrontmatter(candidateContent);
    return reconcileSources(existingContent, candidateContent,
      buildPage(old.frontmatter, `${old.body.trimEnd()}\n\n${candidate.body}`));
  }
  return reconcileSources(existingContent, candidateContent, out);
}

/**
 * 追加模式合并（大页省 token）：只让 LLM 产出增量片段，旧页正文原样保留并在末尾追加。
 *
 * @param oldParsed   旧页解析结果（frontmatter + body）
 * @param candidateBody 候选页正文
 * @param union       已算好的 sources 并集
 */
async function appendMerge(
  oldParsed: ReturnType<typeof parseFrontmatter>,
  candidate: ReturnType<typeof parseFrontmatter>,
  union: SourceEntry[],
  llm: LlmClient,
): Promise<string> {
  const prompt = `## Existing page body
${oldParsed.body}

## New material
${candidate.body}

Output only the incremental information not already in the existing page. If nothing is new, output an empty string.`;

  const fragment = (await llm.chat({ system: APPEND_SYSTEM, prompt, label: "merge-append" })).trim();

  // 无新增 → 仅更新 sources 并集，正文不变。
  if (!fragment) {
    return buildPage({ ...oldParsed.frontmatter, sources: union }, oldParsed.body);
  }

  const newBody = `${oldParsed.body.trimEnd()}\n\n${fragment}`;
  const fm = { ...candidate.frontmatter, ...oldParsed.frontmatter, sources: union };
  fm.verified = oldParsed.frontmatter.verified;
  return buildPage(markGenerated(fm, true), newBody);
}

/** 把合并结果页的 sources 重写为「旧 ∪ 新」并集。 */
function reconcileSources(existingContent: string, candidateContent: string, mergedContent: string): string {
  const oldSrc = sourceEntries(parseFrontmatter(existingContent).frontmatter.sources);
  const newSrc = sourceEntries(parseFrontmatter(candidateContent).frontmatter.sources);
  const merged = parseFrontmatter(mergedContent);
  const union = mergeSources(oldSrc, newSrc);
  const old = parseFrontmatter(existingContent);
  // Model output is not authoritative for lifecycle, verification or extension fields.
  const candidate = parseFrontmatter(candidateContent);
  const fm = { ...candidate.frontmatter, ...old.frontmatter, sources: union };
  fm.verified = old.frontmatter.verified;
  return buildPage(markGenerated(fm, old.body !== merged.body), merged.body);
}

function markGenerated(fm: import("./frontmatter.js").PageFrontmatter, changed: boolean) {
  if (!changed) return fm;
  const next = { ...fm, generated: { by: "wiki-ingest/2", at: new Date().toISOString() } };
  // Keep historical verification events as specified by OKF; do not fabricate new ones.
  return next;
}
