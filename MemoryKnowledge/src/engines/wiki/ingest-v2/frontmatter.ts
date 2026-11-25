/**
 * frontmatter.ts — YAML frontmatter 的解析与构造。
 *
 * 产出页必须带合法 YAML frontmatter（被现有 manager scanWikiDir/BM25/graph 依赖）：
 *   type(必填) / title / sources(我方扩展) / description / tags / timestamp(OKF 推荐)
 *
 * 这里提供：
 *   - parseFrontmatter：从页内容拆出 frontmatter 对象 + 正文（用于合并/读 locked）。
 *   - buildPage：把 frontmatter 字段 + 正文拼成合规页内容（产出/重写时用）。
 *   - isLocked / readSources：合并逻辑用到的便捷读取。
 *
 * 用仓库已有的 `yaml` 依赖解析，宽容消费（坏 frontmatter 不抛错，按空处理）。
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface PageFrontmatter {
  type: string;
  title?: string;
  description?: string;
  sources?: string[];
  tags?: string[];
  timestamp?: string;
  locked?: boolean;
  /** 保留任何额外字段，round-trip 时不丢（OKF 宽容消费精神）。 */
  [key: string]: unknown;
}

export interface ParsedPage {
  frontmatter: PageFrontmatter;
  body: string;
  /** 是否成功解析到 frontmatter 块。 */
  hasFrontmatter: boolean;
}

const FM_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 拆分页内容为 frontmatter + 正文。无 frontmatter 时返回 `{type:"other"}` 占位。
 * 解析失败（坏 YAML）时宽容降级，不抛错。
 */
export function parseFrontmatter(content: string): ParsedPage {
  const text = content ?? "";
  const m = text.match(FM_RE);
  if (!m) {
    return { frontmatter: { type: "other" }, body: text, hasFrontmatter: false };
  }
  const yamlText = m[1];
  const body = text.slice(m[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  if (!parsed || typeof parsed !== "object") {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  const fm = parsed as Record<string, unknown>;
  const type = typeof fm.type === "string" && fm.type.trim() ? fm.type : "other";
  return { frontmatter: { ...fm, type } as PageFrontmatter, body, hasFrontmatter: true };
}

/** 目标页是否被用户手工锁定（page/write 注入 locked:true）。锁定页 ingest 必须跳过。 */
export function isLocked(content: string): boolean {
  const { frontmatter } = parseFrontmatter(content);
  return frontmatter.locked === true;
}

/** 读取页声明的 sources 列表（raw/rm 级联依赖）。 */
export function readSources(content: string): string[] {
  const { frontmatter } = parseFrontmatter(content);
  const s = frontmatter.sources;
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * 把 frontmatter + 正文拼成合规页内容。
 *
 * - `type` 必填；缺失时填 "other"（OKF：consumer 容忍未知 type）。
 * - 永不写 `locked` 字段（仅 page/write 注入；自研产出页不带 locked）。
 * - 字段顺序固定（type→title→description→sources→tags→timestamp→其它），可读性更稳。
 */
export function buildPage(frontmatter: PageFrontmatter, body: string): string {
  const fm: Record<string, unknown> = {};
  fm.type = (frontmatter.type ?? "other").toString();
  if (frontmatter.title != null) fm.title = frontmatter.title;
  if (frontmatter.description != null) fm.description = frontmatter.description;
  if (frontmatter.sources != null) fm.sources = frontmatter.sources;
  if (frontmatter.tags != null) fm.tags = frontmatter.tags;
  if (frontmatter.timestamp != null) fm.timestamp = frontmatter.timestamp;
  // 透传其它自定义字段（排除 locked / 已处理字段）
  for (const [k, v] of Object.entries(frontmatter)) {
    if (["type", "title", "description", "sources", "tags", "timestamp", "locked"].includes(k)) continue;
    if (v != null) fm[k] = v;
  }

  const yamlText = stringifyYaml(fm).trimEnd();
  const cleanBody = (body ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
}
