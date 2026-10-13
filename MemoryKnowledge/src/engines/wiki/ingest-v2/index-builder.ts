/**
 * index-builder.ts — 维护 wiki/index.md（OKF §6 渐进式披露 / llm-wiki「先看目录再钻取」）。
 *
 * ingest 写盘后调用：扫描 wiki/ 下所有页的 frontmatter，按页类型分组，
 * 生成 `* [标题](relPath) - 描述` 列表，覆盖写入 wiki/index.md。
 *
 * 设计取舍：
 *   - index.md 是结构性文件（page/write/rm 禁改），但 ingest 可维护它（PRD §3.7-2）。
 *   - 用标准 markdown 链接（OKF 推荐 bundle-relative `/path`），不影响 [[wikilink]] 图谱。
 *   - 分组顺序固定（sources → entities → concepts → 其它 type），同组按标题排序，输出稳定。
 *   - 宽容：坏页/缺 frontmatter 跳过，不抛错。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/** 结构性文件不列入 index。 */
const STRUCTURAL = new Set(["index.md", "schema.md", "purpose.md", "log.md", "overview.md"]);

/** 分组展示顺序与中文小节标题。未知 type 归到「其它」。 */
const GROUP_ORDER: Array<{ type: string; heading: string }> = [
  { type: "source", heading: "Sources" },
  { type: "entity", heading: "Entities" },
  { type: "concept", heading: "Concepts" },
  { type: "comparison", heading: "Comparisons" },
  { type: "synthesis", heading: "Synthesis" },
];

interface IndexEntry {
  title: string;
  relPath: string; // bundle-relative，以 / 开头（OKF 推荐）
  description: string;
  type: string;
}

/** 扫描 wiki/ 收集所有非结构性页的索引条目。 */
function collectEntries(wikiDir: string): IndexEntry[] {
  const out: IndexEntry[] = [];
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
      const { frontmatter, hasFrontmatter } = parseFrontmatter(content);
      if (!hasFrontmatter) continue;
      const title =
        typeof frontmatter.title === "string" && frontmatter.title.trim()
          ? frontmatter.title.trim()
          : entry.replace(/\.md$/, "");
      const description =
        typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
      out.push({ title, relPath: `/${rel}`, description, type: frontmatter.type });
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

/**
 * 根据当前 wiki/ 内容渲染 index.md 文本（OKF 渐进式披露格式，无 frontmatter）。
 * 导出以便单测。
 */
export function renderIndex(entries: IndexEntry[]): string {
  const byType = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const arr = byType.get(e.type) ?? [];
    arr.push(e);
    byType.set(e.type, arr);
  }

  const sections: string[] = ['---\nokf_version: "0.2"\n---\n', "# Index", ""];
  const emitted = new Set<string>();

  const emitGroup = (type: string, heading: string) => {
    const items = byType.get(type);
    if (!items || items.length === 0) return;
    emitted.add(type);
    items.sort((a, b) => a.title.localeCompare(b.title));
    sections.push(`## ${heading}`, "");
    for (const it of items) {
      sections.push(`* [${it.title}](${it.relPath})${it.description ? ` - ${it.description}` : ""}`);
    }
    sections.push("");
  };

  for (const { type, heading } of GROUP_ORDER) emitGroup(type, heading);

  // 其它未列出的 type 归到「Other」，保证不漏页（OKF 容忍未知 type）。
  const otherTypes = [...byType.keys()].filter((t) => !emitted.has(t)).sort();
  for (const t of otherTypes) emitGroup(t, t.charAt(0).toUpperCase() + t.slice(1));

  return sections.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * 重建并覆盖写入 wiki/index.md。
 * @returns 写入的条目数（用于日志）。
 */
export function rebuildIndexFile(projectPath: string): number {
  const wikiDir = join(projectPath, "wiki");
  if (!existsSync(wikiDir)) return 0;
  const entries = collectEntries(wikiDir);
  const text = renderIndex(entries);
  writeFileSync(join(wikiDir, "index.md"), text, "utf-8");
  return entries.length;
}
