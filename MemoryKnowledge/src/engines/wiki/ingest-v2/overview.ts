/**
 * overview.ts — 生成 wiki/overview.md 全局综述页（llm-wiki synthesis 思想，OQ-9）。
 *
 * 在一批源全部摄取完成后调用一次：把当前 wiki 的所有页（标题 + 描述）喂给 LLM，
 * 让它写一篇把各实体/概念串成叙事的全局综述，帮助人类与 LLM 快速建立整体认知。
 *
 * overview.md 带 frontmatter（type: overview），正文鼓励用 [[wikilink]] 指向各页。
 * 失败不影响摄取主流程（调用方 try/catch）。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { LlmClient } from "./llm.js";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-overview");

/** 结构性文件不纳入综述输入，也不被综述覆盖。 */
const STRUCTURAL = new Set(["index.md", "schema.md", "purpose.md", "log.md", "overview.md"]);

interface PageBrief {
  title: string;
  type: string;
  description: string;
}

function collectBriefs(wikiDir: string): PageBrief[] {
  const out: PageBrief[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry !== "media") walk(full);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const rel = relative(wikiDir, full).replace(/\\/g, "/");
      if (STRUCTURAL.has(rel) || ["index.md", "log.md"].includes(entry)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const { frontmatter } = parseFrontmatter(content);
      out.push({
        title:
          typeof frontmatter.title === "string" && frontmatter.title.trim()
            ? frontmatter.title.trim()
            : entry.replace(/\.md$/, ""),
        type: frontmatter.type,
        description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
      });
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

const OVERVIEW_SYSTEM = `You are a knowledge base maintainer. Given a list of all current wiki pages (title + type + description),
write a concise "global overview" that weaves these entities and concepts into a coherent narrative,
helping readers quickly build a holistic mental model.
Requirements:
- 2–5 paragraphs, clearly structured. Do not list items one by one — organize and summarize themes and their relationships.
- Use [[Page Title]] wikilinks to point to specific pages (title only, no paths or suffixes).
- Output only the overview body (markdown) — no frontmatter, no FILE blocks, no extra commentary.`;

/**
 * 生成/更新 wiki/overview.md。页太少（<2）时跳过（综述意义不大）。
 *
 * @returns 是否写入了 overview。
 */
export async function generateOverview(projectPath: string, llm: LlmClient): Promise<boolean> {
  const wikiDir = join(projectPath, "wiki");
  const briefs = collectBriefs(wikiDir);
  if (briefs.length < 2) {
    log.debug("页面太少，跳过 overview 生成", { pages: briefs.length });
    return false;
  }

  const list = briefs
    .map((b) => `- ${b.title} [${b.type}]`)
    .join("\n");
  const prompt = `## Wiki Pages\n${list}\n\nWrite a global overview.`;

  const body = (await llm.chat({ system: OVERVIEW_SYSTEM, prompt, label: "overview" })).trim();
  if (!body) {
    log.warn("overview generated empty, skip writing");
    return false;
  }

  const content = buildPage(
    { type: "overview", title: "Overview", description: "A global overview of this wiki", generated: { by: "wiki-ingest/2", at: new Date().toISOString() } },
    body,
  );
  writeFileSync(join(wikiDir, "overview.md"), content, "utf-8");
  log.info("overview.md written", { pages: briefs.length, bytes: content.length });
  return true;
}
