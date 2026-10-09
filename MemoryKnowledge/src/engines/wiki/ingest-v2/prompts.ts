/**
 * prompts.ts — 摄取提示词（分析 / 系统 / 生成）。
 *
 * 描述角色（wiki 维护者）、页面类型与目录约定（OKF type）、FILE 块输出协议、
 * wikilink 约定、去重更新策略、输出语言策略。依据本仓库 PRD/INTERFACE。
 *
 * 支持两种摄取流程（PRD §4.2）：
 *   - 单阶段：源全文 + 模板 + 已有页清单 → 直接产出 FILE 块（buildGeneratePrompt）。
 *   - 两阶段（OQ-4）：先「分析」(buildAnalysisPrompt) 产出结构化抽取计划，
 *     再「生成」(buildGenerateFromAnalysisPrompt) 依据分析产出 FILE 块。
 *     好处：把"抽什么"与"落盘格式"解耦，质量更稳、格式更规整。
 */

import type { WikiTemplate } from "./template.js";

/** 已存在页的精简信息，用于让 LLM 感知"已有知识"并决定新建/更新。 */
export interface ExistingPageInfo {
  /** wiki 相对路径，如 wiki/entities/redis.md */
  relPath: string;
  title: string;
  type: string;
  description?: string;
}

/** 需要被更新的已存在页（命中 dedup 且未锁定），把原文给 LLM 做合并。 */
export interface PageForUpdate {
  relPath: string;
  content: string;
}

/** 把已有页清单格式化为列表文本（供分析/生成阶段复用）。 */
function formatExistingPages(existingPages: ExistingPageInfo[]): string {
  return existingPages.length > 0
    ? existingPages
        .map((p) => `- [${p.type}] ${p.relPath}${p.title ? ` — ${p.title}` : ""}${p.description ? `（${p.description}）` : ""}`)
        .join("\n")
    : "(wiki is empty — this is the first source)";
}

// ─── 阶段 A：分析 ────────────────────────────────────────────

/** 分析阶段系统提示词：扮演"抽取规划者"，只产出结构化分析，不写页面。 */
export function buildAnalysisSystemPrompt(template: WikiTemplate): string {
  return `You are a knowledge base analyst. Your job is to read a source document and plan how to integrate it into
the existing wiki. You do NOT write final pages — you only produce a structured "extraction plan" for the
next (generation) stage.

## Wiki Purpose
${template.purpose}

## Extraction Schema
${template.schema}

## Your Analysis Output (markdown, structured, concise)
1. **Source Summary**: Summarize this source in 2–4 sentences.
2. **Entities**: Concrete entities (people, products, systems, organizations, etc.) in the source. For each, give a name and a one-sentence key point.
3. **Concepts**: Abstract concepts (theories, methods, mechanisms, etc.) in the source. For each, give a name and a one-sentence key point.
4. **Relationship to Existing Pages**: Which entities/concepts already appear in the existing page list (update/merge rather than create new), and which are brand new.
5. **Suggested Cross-References**: Which entity/concept pairs should be connected via [[wikilink]].

## Granularity

Decide whether a subject deserves its own page by asking:

1. **Independent identity** — can this subject be defined and understood on its own, without relying on its parent context?
2. **Distinct relationships** — does it have meaningful relationships to other entities/concepts beyond just belonging to its parent?
3. **Substantial content** — is there enough to say about it to fill more than a one-sentence stub?

→ If all three are true, create a dedicated page.
→ If the subject is merely a member, sub-operation, or property that has no identity outside its parent, list it as a subsection or list item within the parent's page instead.

Output only the analysis itself — no FILE blocks, no final page content. Match the source document's primary language.`;
}

/** 构造分析阶段用户提示词。 */
export function buildAnalysisPrompt(args: {
  sourceName: string;
  sourceText: string;
  existingPages: ExistingPageInfo[];
}): string {
  const { sourceName, sourceText, existingPages } = args;
  return `## Existing wiki pages (for deciding what to update vs. create)
${formatExistingPages(existingPages)}

## Source to analyze: ${sourceName}

## Source Document
${sourceText}

---
Produce the structured extraction plan following the rules above.`;
}

// ─── 系统提示词（生成阶段共用：格式契约 + 输出协议） ──────────

/** 构造系统提示词：角色、格式契约、输出协议。 */
export function buildSystemPrompt(template: WikiTemplate): string {
  return `You are a meticulous knowledge base (wiki) maintainer. Your job is to read source documents
provided by the user and integrate their knowledge into a persistent, cumulative markdown wiki —
extracting entities and concepts, building cross-references, and updating existing pages, rather than
simply paraphrasing the source.

## Wiki Purpose
${template.purpose}

## Extraction Schema
${template.schema}

## Page Format (MUST be followed strictly)
Each wiki page is "YAML frontmatter + markdown body". Frontmatter is wrapped in \`---\` at the top:
- type: REQUIRED. Values: source | entity | concept | comparison | synthesis, etc. Determines the page's directory.
- title: Human-readable title.
- description: One-sentence summary (used for index and search snippets).
- sources: Array of raw source filenames this page draws from (e.g. ["redis.md"]). Must be accurate.
- tags: Optional, short cross-category labels.
- timestamp: Optional, ISO 8601 last-modified time.
- Do NOT output a \`locked\` field.

Body guidelines:
- Link between entities/concepts using [[wikilink]], e.g. [[Redis]], [[Cache]]. Use these liberally.
- **Wikilink consistency**: Inside the brackets, write only the target page's title (e.g. [[Gateway]],
  [[Consistent Hashing]]). Do NOT include \`.md\` suffix, \`wiki/\` or slash paths, or filename slugs.
  When referencing an existing page, use its title.
- Use structured sections where applicable: # Schema / # Examples / # Citations, lists, and tables.
- **Consistent language**: Use the same primary language as the source document throughout (title, body,
  wikilinks, descriptions). Avoid mixing languages.

## Output Protocol (FILE blocks, MUST be followed strictly)
You cannot write files directly. Wrap each page to be written in the following boundary markers:

<<<FILE path="wiki/<dir>/<slug>.md">>>
---
type: ...
title: ...
---

body...
<<<END>>>

Directory conventions (use plural directory names):
- source → wiki/sources/
- entity → wiki/entities/
- concept → wiki/concepts/
- comparison → wiki/comparisons/
- synthesis → wiki/synthesis/

Rules:
- A single reply may contain multiple FILE blocks.
- path must be inside wiki/. Use stable slugs for filenames (lowercase, spaces→hyphens).
- You MUST produce at least one type: source summary page.
- For notable entities/concepts in the source, produce or update corresponding entity/concept pages.
- Do NOT output any explanatory text outside of FILE blocks.`;
}

/** 构造生成提示词（单阶段）：源全文 + 已有页清单 + 待更新页原文。 */
export function buildGeneratePrompt(args: {
  sourceName: string;
  sourceText: string;
  existingPages: ExistingPageInfo[];
  pagesToUpdate?: PageForUpdate[];
}): string {
  const { sourceName, sourceText, existingPages, pagesToUpdate } = args;

  const existingList = formatExistingPages(existingPages);

  const updateSection =
    pagesToUpdate && pagesToUpdate.length > 0
      ? `\n## Pages to Update (preserve existing facts while merging new information — output the merged full page)\n` +
        pagesToUpdate
          .map((p) => `### ${p.relPath}\n\`\`\`\n${p.content}\n\`\`\``)
          .join("\n\n")
      : "";

  return `## Existing wiki pages (for deciding what to create vs. update, to avoid duplicates)
${existingList}
${updateSection}

## Source to ingest: ${sourceName}

## Source Document
${sourceText}

---
Read the source, follow the format and protocol in the system prompt, and output FILE blocks:
1. MUST include one type: source summary page (path like wiki/sources/<slug>.md).
2. For key entities/concepts in the source, produce or update corresponding entity/concept pages.
3. If an entity already appears in the existing page list, reuse its path for merging — do NOT create a near-duplicate page.
4. Use [[wikilink]] generously between pages.
Output ONLY FILE blocks — no extra commentary.`;
}

// ─── 阶段 B：基于分析的生成（OQ-4） ──────────────────────────

/**
 * 构造"生成阶段"用户提示词（两阶段流程）：以分析结果为主输入，
 * 仍附源全文供查证细节。让 LLM 据此产出 FILE 块。
 */
export function buildGenerateFromAnalysisPrompt(args: {
  sourceName: string;
  sourceText: string;
  analysis: string;
  existingPages: ExistingPageInfo[];
}): string {
  const { sourceName, sourceText, analysis, existingPages } = args;
  return `## Existing wiki pages (reuse paths for merging — avoid duplicates)
${formatExistingPages(existingPages)}

## Source to ingest: ${sourceName}

## Extraction Plan (from analysis stage — generate pages based on this)
${analysis}

## Source Document (for detail verification)
${sourceText}

---
Based on the Extraction Plan above, follow the format and protocol in the system prompt, and output FILE blocks:
1. MUST include one type: source summary page (path like wiki/sources/<slug>.md).
2. For the entities/concepts listed in the extraction plan, produce or update corresponding entity/concept pages.
3. Items marked as "already exist" in the plan should reuse their existing paths for merging — do NOT create near-duplicates.
4. Follow the cross-reference suggestions in the plan — use [[wikilink]] generously.
Output ONLY FILE blocks — no extra commentary.`;
}
