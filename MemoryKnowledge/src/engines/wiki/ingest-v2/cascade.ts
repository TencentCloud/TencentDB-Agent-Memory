/**
 * cascade.ts — 删除级联（raw/rm 与 page/rm 的下游清理）。
 *
 * 行为契约见 PRD §3.7-3 与 wiki-service.ts 的调用签名。
 *
 *  - deleteSourceFiles：删 raw 源文件，并按各 page 的 frontmatter `sources` 级联——
 *      独占该源的 page → 删除；共享的 page → 重写去掉该源。
 *  - cascadeDeleteWikiPagesWithRefs：删 wiki page 文件，并清理其它 page 正文中
 *      指向已删页的 [[wikilink]]（悬空链接）。
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { parseFrontmatter, buildPage, sourceEntries, rawSourceKey } from "./frontmatter.js";
import { slugify } from "./slug.js";

export interface DeleteSourceFilesResult {
  /** 被级联删除的 wiki page 绝对路径。 */
  deletedWikiPaths: string[];
  /** 被重写（去掉某源）的 wiki page 数量。 */
  rewrittenSourcePages: number;
}

export interface DeleteSourceFilesOptions {
  /** 仅用于日志标记，便于审计。 */
  logReason?: string;
}

/** 递归收集 wiki/ 下所有 .md 页的绝对路径（跳过 media 目录）。 */
function collectWikiPages(wikiDir: string): string[] {
  const out: string[] = [];
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
      } else if (entry.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

/** 结构性文件不参与级联删除/重写。 */
function isStructural(relFromWiki: string): boolean {
  return ["index.md", "log.md"].includes(basename(relFromWiki)) || relFromWiki === "schema.md" || relFromWiki === "purpose.md";
}

/**
 * 删除 raw 源文件并级联清理引用它们的 wiki page。
 *
 * @param projectPath wiki 项目根
 * @param sourceFullPaths 要删除的 raw 源文件绝对路径列表
 */
export async function deleteSourceFiles(
  projectPath: string,
  sourceFullPaths: string[],
  _opts: DeleteSourceFilesOptions = {},
): Promise<DeleteSourceFilesResult> {
  // 待删源的文件名集合（page 的 sources 里记的是文件名）。
  const deletedNames = new Set<string>();
  for (const p of sourceFullPaths) {
    deletedNames.add(relative(join(projectPath, "raw", "sources"), p).replace(/\\/g, "/"));
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {
      /* 删除失败忽略：可能已被删 */
    }
  }

  const wikiDir = join(projectPath, "wiki");
  const deletedWikiPaths: string[] = [];
  let rewrittenSourcePages = 0;

  for (const pagePath of collectWikiPages(wikiDir)) {
    const relFromWiki = relative(wikiDir, pagePath).replace(/\\/g, "/");
    if (isStructural(relFromWiki)) continue;

    let content: string;
    try {
      content = readFileSync(pagePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content);
    if (parsed.frontmatter.locked || parsed.frontmatter.type === "Attested Computation") continue;

    const sources = sourceEntries(parsed.frontmatter.sources);
    if (sources.length === 0) continue;

    const remaining = sources.filter((s) => !deletedNames.has(rawSourceKey(s) ?? ""));
    if (remaining.length === sources.length) continue; // 本页不引用被删源

    if (remaining.length === 0) {
      // 独占被删源 → 删页
      try {
        rmSync(pagePath, { force: true });
        deletedWikiPaths.push(pagePath);
      } catch {
        /* ignore */
      }
    } else {
      // 共享 → 重写去掉被删源并更新时间戳
      try {
        const fm = { ...parsed.frontmatter, sources: remaining };
        fm.generated = { by: "wiki-cascade/1", at: new Date().toISOString() };
        const rewritten = buildPage(fm, parsed.body);
        writeFileSync(pagePath, rewritten, "utf-8");
        rewrittenSourcePages++;
      } catch {
        /* ignore */
      }
    }
  }

  return { deletedWikiPaths, rewrittenSourcePages };
}

export interface CascadeDeletePagesResult {
  /** 实际删除的 wiki page 绝对路径。 */
  deletedPaths: string[];
  /** 被重写（清理悬空 wikilink）的 page 数量。 */
  rewrittenFiles: number;
}

/** 从一个页路径与内容推导出它可能被 [[wikilink]] 引用的标识符（小写归一）。 */
function linkAliasesFor(pagePath: string, content: string): Set<string> {
  const aliases = new Set<string>();
  const base = basename(pagePath, ".md");
  aliases.add(base.toLowerCase());
  aliases.add(slugify(base).toLowerCase());
  const { frontmatter } = parseFrontmatter(content);
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    aliases.add(frontmatter.title.trim().toLowerCase());
    aliases.add(slugify(frontmatter.title).toLowerCase());
  }
  return aliases;
}

/** 归一化一个 wikilink 目标（去 |label、trim、小写）。 */
function normalizeLinkTarget(raw: string): string {
  const target = raw.split("|")[0].trim();
  return target.toLowerCase();
}

/**
 * 删除 wiki page 文件，并清理其它 page 正文中指向已删页的 [[wikilink]]。
 *
 * @param projectPath wiki 项目根
 * @param pageFullPaths 要删除的 wiki page 绝对路径列表
 */
export async function cascadeDeleteWikiPagesWithRefs(
  projectPath: string,
  pageFullPaths: string[],
): Promise<CascadeDeletePagesResult> {
  const wikiDir = join(projectPath, "wiki");

  // 删除前先收集被删页的 wikilink 别名，用于后续悬空链接清理。
  const deletedAliases = new Set<string>();
  const toDelete = new Set(pageFullPaths.map((p) => p));
  for (const p of pageFullPaths) {
    let content = "";
    try {
      content = readFileSync(p, "utf-8");
    } catch {
      /* 可能不存在 */
    }
    for (const a of linkAliasesFor(p, content)) deletedAliases.add(a);
  }

  // 执行删除。
  const deletedPaths: string[] = [];
  for (const p of pageFullPaths) {
    try {
      if (existsSync(p)) {
        rmSync(p, { force: true });
        deletedPaths.push(p);
      }
    } catch {
      /* ignore */
    }
  }

  // 清理剩余 page 中指向已删页的 [[wikilink]]：把 [[X]] / [[X|label]] 替换为其展示文本。
  let rewrittenFiles = 0;
  const linkRe = /\[\[([^\]]+?)\]\]/g;
  for (const pagePath of collectWikiPages(wikiDir)) {
    if (toDelete.has(pagePath)) continue;
    let content: string;
    try {
      content = readFileSync(pagePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content);
    if (parsed.frontmatter.locked || parsed.frontmatter.type === "Attested Computation") continue;

    let changed = false;
    const nextBody = parsed.body.replace(linkRe, (whole, inner: string) => {
      const target = normalizeLinkTarget(inner);
      if (deletedAliases.has(target)) {
        changed = true;
        // 保留可读文本：有 |label 用 label，否则用原目标名。
        const parts = String(inner).split("|");
        return (parts[1] ?? parts[0]).trim();
      }
      return whole;
    });
    if (changed) {
      try {
        const fm = { ...parsed.frontmatter };
        fm.generated = { by: "wiki-cascade/1", at: new Date().toISOString() };
        const rewritten = buildPage(fm, nextBody);
        writeFileSync(pagePath, rewritten, "utf-8");
        rewrittenFiles++;
      } catch {
        /* ignore */
      }
    }
  }

  return { deletedPaths, rewrittenFiles };
}
