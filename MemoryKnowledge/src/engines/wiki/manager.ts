/**
 * Wiki Source Manager — 管理文档源的注册、扫描、索引、查询生命周期
 *
 * 摄取走 ingest-v2/ 引擎。
 *
 * 索引存储（设计 006）：BM25 全文检索、知识图谱、页元数据不再常驻内存，改存每个
 * wiki 私有的 `index.db`（SQLite：wiki_fts + page_meta + graph_edge）。写走独立事务连接
 * （重建三表），读走 LRU 连接池；内存与 wiki 总数解耦，根治 MiniSearch 全量常驻的 OOM。
 * 图谱小，查询时从 graph_edge 临时构建内存 graphology 实例做多跳 BFS（复用现有算法）。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, basename, relative } from "path";
import Graph from "graphology";
import type DatabaseType from "better-sqlite3";
import pLimit, { type LimitFunction } from "p-limit";
import type {
  WikiPage,
  WikiSourceConfig,
  WikiSourceState,
  GraphNode,
  GraphEdge,
  CommunityInfo,
  SearchResult,
  SearchResponse,
  RelatedPage,
  ResultLink,
} from "./types.js";
import { graphMultiHopSearch } from "./graph-search.js";
import {
  initIndexDb,
  getReadDb,
  withWriteDb,
  evictWikiDb,
  readSourceStates,
  recordSourceIngestResult,
  deleteSources,
  classifySources,
  sha256,
  type SourceStatus,
} from "./index-db.js";
import { createLogger } from "../../logger.js";
import { withSpan } from "../../telemetry.js";
import { getIngestConcurrency } from "../../config.js";
import { slugify } from "./ingest-v2/slug.js";
import { DEFAULT_SCHEMA, DEFAULT_PURPOSE } from "./ingest-v2/template.js";

const log = createLogger("wiki-mgr");

// ── 内联 frontmatter/wikilink 解析（不依赖外部模块，确保可编译） ──

function extractFrontmatter(content: string): { title: string; type: string; sources: string[]; description: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const sources: string[] = [];
  const sourcesBlockMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (sourcesBlockMatch) {
    for (const line of sourcesBlockMatch[1].split("\n")) {
      const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
      if (itemMatch) sources.push(itemMatch[1]);
    }
  } else {
    const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      for (const item of inlineMatch[1].split(",")) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "");
        if (trimmed) sources.push(trimmed);
      }
    }
  }
  let title = titleMatch ? titleMatch[1].trim() : "";
  if (!title) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    title = headingMatch ? headingMatch[1].trim() : "";
  }
  return {
    title,
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "other",
    sources,
    description: descMatch ? descMatch[1].trim() : "",
  };
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

// ── Manager Interface ──

export interface SearchOptions {
  /** Multi-hop expansion depth (PRD FR-3). 0 = pure BM25. Range 0~5. */
  hop?: number;
  /** Per-hop score decay factor (0~1). */
  decay?: number;
  /** Minimum score threshold; nodes below this are dropped. */
  minScore?: number;
}

/** ingest 进度回调载荷（KS → Panel）。 */
export interface IngestProgress {
  phase: "extracting" | "merging" | "indexing";
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  percent: number;
}

export type ProgressFn = (progress: IngestProgress) => void;

/** extracting 同阶段节流间隔；阶段切换（merging/indexing）始终立即上报。 */
export const PROGRESS_THROTTLE_MS = 500;

/**
 * 节流 onProgress：阶段切换立即发；同阶段仅在 percent 上升且距上次 ≥ minIntervalMs
 * （或已到 extracting 末段 percent≥90）时发送，避免多源并发打爆 Panel。
 */
export function createThrottledProgressFn(
  onProgress: ProgressFn | undefined,
  minIntervalMs: number = PROGRESS_THROTTLE_MS,
): ProgressFn | undefined {
  if (!onProgress) return undefined;
  let lastPhase: IngestProgress["phase"] | undefined;
  let lastPercent = -1;
  let lastEmitAt = 0;
  return (p) => {
    const now = Date.now();
    const phaseChanged = p.phase !== lastPhase;
    if (!phaseChanged) {
      if (p.percent <= lastPercent) return;
      const nearExtractEnd = p.phase === "extracting" && p.percent >= 90;
      if (!nearExtractEnd && now - lastEmitAt < minIntervalMs) return;
    }
    lastPhase = p.phase;
    lastPercent = p.percent;
    lastEmitAt = now;
    onProgress(p);
  };
}

export interface IngestExecOptions {
  onProgress?: ProgressFn;
  globalLlmLimit?: LimitFunction;
}

export interface WikiSourceManager {
  register(config: WikiSourceConfig): WikiSourceState;
  sync(name: string): WikiSourceState;
  get(name: string): WikiSourceState | undefined;
  list(): WikiSourceState[];
  remove(name: string): void;
  search(name: string, query: string, limit?: number, options?: SearchOptions): SearchResponse;
  graph(name: string): { nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] };
  readPage(name: string, relPath: string): string | null;
  getPages(name: string): WikiPage[];
  init(config: WikiSourceConfig): WikiSourceState;
  ingest(name: string, llmConfig: any, opts?: IngestExecOptions): Promise<any[]>;
}

/** 图谱中不参与建边/展示的页类型（如内部 query 页）。 */
const HIDDEN_TYPES = new Set(["query"]);

// ── 图谱缓存结构（读时从 index.db 的 graph_edge 临时构建） ──

export interface PageGraph {
  /** Public view (filtered, with linkCount/community). */
  view: { nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] };
  /** graphology instance — undirected, no multi-edges. Used for multi-hop BFS. */
  graph: Graph;
  /** Per-page directed wikilink adjacency (id -> outgoing target ids). */
  outAdj: Map<string, Set<string>>;
  /** Per-page reverse adjacency (id -> ids whose page links into this one). */
  inAdj: Map<string, Set<string>>;
  /** Degree (= linkCount in nodes view). */
  degree: Map<string, number>;
}

/** 页元数据（读模型；正文不在库，snippet 为写入时预生成的静态摘要）。 */
interface PageMeta {
  id: string;
  title: string;
  type: string;
  relPath: string;
  snippet: string;
}

/**
 * 解析页间 wikilink，产出有向边（source → target）用于写入 graph_edge。
 * 只在 visible（非 hidden 类型）页之间建边，过滤自环与无法解析的坏链接，(source,target) 去重。
 */
function resolveEdges(pages: WikiPage[]): Array<{ source: string; target: string }> {
  const visible = pages.filter((p) => !HIDDEN_TYPES.has(p.type));
  const out: Array<{ source: string; target: string }> = [];
  if (visible.length === 0) return out;

  const nodeIds = new Set(visible.map((p) => p.id));
  // title 的 slug → page id 映射：支持 wikilink 以页面标题（而非文件名）引用。
  const titleSlugToId = new Map<string, string>();
  for (const p of visible) {
    const ts = slugify(p.title);
    if (ts && !titleSlugToId.has(ts)) titleSlugToId.set(ts, p.id);
  }

  const seen = new Set<string>();
  for (const page of visible) {
    for (const targetRaw of page.links) {
      const targetId = resolveTarget(targetRaw, nodeIds, titleSlugToId);
      if (!targetId || targetId === page.id) continue;
      const key = `${page.id}\u0000${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source: page.id, target: targetId });
    }
  }
  return out;
}

/**
 * 从 page_meta + graph_edge 构建内存 PageGraph（读路径）。
 * 节点 = 非 hidden 类型的页；边 = graph_edge 有向边，公共 view 无向去重。
 */
function buildPageGraphFromDb(
  metaById: Map<string, PageMeta>,
  edgeRows: Array<{ source_id: string; target_id: string }>,
): PageGraph {
  const graph = new Graph({ multi: false, type: "undirected" });
  const outAdj = new Map<string, Set<string>>();
  const inAdj = new Map<string, Set<string>>();
  const degree = new Map<string, number>();

  const visible: PageMeta[] = [];
  for (const m of metaById.values()) {
    if (!HIDDEN_TYPES.has(m.type)) visible.push(m);
  }

  for (const m of visible) {
    outAdj.set(m.id, new Set());
    inAdj.set(m.id, new Set());
    degree.set(m.id, 0);
    graph.addNode(m.id, { label: m.title, type: m.type, path: m.relPath });
  }

  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const { source_id: s, target_id: t } of edgeRows) {
    // 端点必须都是 visible 节点（写库时已保证；读侧防御坏数据）。
    if (!outAdj.has(s) || !inAdj.has(t)) continue;
    outAdj.get(s)!.add(t);
    inAdj.get(t)!.add(s);
    const key = [s, t].sort().join(":::");
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source: s, target: t, weight: 1 });
    if (!graph.hasEdge(s, t)) graph.addEdge(s, t, { weight: 1 });
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }

  const nodes: GraphNode[] = visible.map((m) => ({
    id: m.id,
    label: m.title,
    type: m.type,
    path: m.relPath,
    linkCount: degree.get(m.id) ?? 0,
    community: 0,
  }));

  return { view: { nodes, edges, communities: [] }, graph, outAdj, inAdj, degree };
}

function resolveTarget(
  raw: string,
  nodeIds: Set<string>,
  titleSlugToId: Map<string, string>,
): string | null {
  if (nodeIds.has(raw)) return raw;

  // wikilink 目标可能是各种花式写法（带 .md 后缀、带斜杠路径、中英混合、大小写不一）。
  // 统一用与文件名同源的 slugify 归一后比对 page id 的 basename（单一事实源，
  // 避免在此重复造一套归一逻辑）。slugify 把 `/`、空格、标点都当段边界，
  // 故 "/v3/wiki/create 接口" 与 "v3-wiki-create-接口" 归一后一致。
  const target = slugify(raw.replace(/\.md$/i, ""));
  if (!target) return null;

  const rawLower = raw.toLowerCase();
  for (const id of nodeIds) {
    if (id.toLowerCase() === rawLower) return id;
    const idBasename = id.split("/").pop() ?? id;
    if (slugify(idBasename) === target) return id;
  }
  // 回退：按页面标题的 slug 命中（wikilink 用页面标题而非文件名引用时）。
  const byTitle = titleSlugToId.get(target);
  if (byTitle) return byTitle;
  return null;
}

// ── Search Engine (SQLite FTS5) ──

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
]);

const SNIPPET_CONTEXT = 80;

/**
 * 预生成页摘要（写入 page_meta.snippet）：优先 frontmatter description，
 * 否则取正文（去 frontmatter/标题）前 SNIPPET_CONTEXT 个字符。
 * 正文不入库，检索时直接返回该静态摘要（消费者主要是 AI，无需按 query 动态高亮）。
 */
function makeSnippet(page: WikiPage): string {
  if (page.description) return page.description;
  const body = page.content
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/^#+\s+.*$/gm, "")
    .trim();
  return [...body].slice(0, SNIPPET_CONTEXT).join("").replace(/\n/g, " ").trim();
}

/**
 * 分词器：中英文混合处理。
 * - 英文：按空格/标点切分，保留完整单词，过滤 stop words
 * - 中文：bigram + 单字
 *
 * 导出供 FTS5 预分词复用（006）与 bm25 评测：写入 FTS5 时把 content/title
 * 经此函数分词后以空格拼接存入，查询时对 query 用同一分词，保证中文逻辑一致。
 */
export function tokenize(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
    const hasLatin = /[a-z]/.test(token);

    if (hasCJK && hasLatin) {
      // 混合 token（如 "l0录入"）：拆分中英文部分分别处理
      const parts = token.split(/(?<=[a-z0-9])(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[\u4e00-\u9fff]/.test(part) && part.length > 1) {
          const chars = [...part];
          for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
          result.push(part);
        } else if (part.length > 0 && !STOP_WORDS.has(part)) {
          result.push(part);
        }
      }
    } else if (hasCJK && token.length > 1) {
      // 纯中文：bigram
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
      result.push(token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      // 纯英文/数字：保留完整 token
      result.push(token);
    }
  }
  return result;
}

/**
 * FTS5 检索：query → tokenize → 每 token 加 `*` 前缀 → OR 连接 → MATCH。
 * bm25() 越负越相关，取负转成"越大越相关"的正分，供图扩展的 decay/minScore 使用。
 * title_tok 权重 5.0、content_tok 1.0（对齐原 MiniSearch boost title×5）。
 */
function ftsSearch(db: DatabaseType.Database, query: string, limit: number): Array<{ id: string; score: number }> {
  const toks = tokenize(query);
  if (toks.length === 0) return [];
  const expr = toks.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
  const rows = db
    .prepare(
      "SELECT page_id, bm25(wiki_fts, 5.0, 1.0) AS score FROM wiki_fts WHERE wiki_fts MATCH ? ORDER BY score LIMIT ?",
    )
    .all(expr, limit) as Array<{ page_id: string; score: number }>;
  return rows.map((r) => ({ id: r.page_id, score: -r.score }));
}

/** 事务内重建三张索引表（wiki_fts + page_meta + graph_edge）。由 withWriteDb 调用。 */
function writeIndex(db: DatabaseType.Database, pages: WikiPage[]): void {
  db.prepare("DELETE FROM wiki_fts").run();
  db.prepare("DELETE FROM page_meta").run();
  db.prepare("DELETE FROM graph_edge").run();

  const insFts = db.prepare("INSERT INTO wiki_fts(page_id, title_tok, content_tok) VALUES (?,?,?)");
  const insMeta = db.prepare(
    "INSERT INTO page_meta(page_id, title, type, rel_path, snippet) VALUES (?,?,?,?,?)",
  );
  const insEdge = db.prepare("INSERT OR IGNORE INTO graph_edge(source_id, target_id) VALUES (?,?)");

  for (const p of pages) {
    // wiki_fts + page_meta 收录所有页（含 hidden 类型，供检索）。
    insFts.run(p.id, tokenize(p.title).join(" "), tokenize(p.content).join(" "));
    insMeta.run(p.id, p.title, p.type, p.relPath, makeSnippet(p));
  }
  // graph_edge 只在 visible 页间。
  for (const e of resolveEdges(pages)) insEdge.run(e.source, e.target);
}

/** 从读连接加载读模型：页元数据表 + 图（graph_edge 构建的内存图）。 */
function loadReadModel(db: DatabaseType.Database): { pg: PageGraph; metaById: Map<string, PageMeta> } {
  const metaRows = db
    .prepare("SELECT page_id, title, type, rel_path, snippet FROM page_meta ORDER BY page_id")
    .all() as Array<{ page_id: string; title: string | null; type: string | null; rel_path: string | null; snippet: string | null }>;
  const metaById = new Map<string, PageMeta>();
  for (const r of metaRows) {
    metaById.set(r.page_id, {
      id: r.page_id,
      title: r.title ?? "",
      type: r.type ?? "other",
      relPath: r.rel_path ?? "",
      snippet: r.snippet ?? "",
    });
  }
  const edgeRows = db.prepare("SELECT source_id, target_id FROM graph_edge").all() as Array<{
    source_id: string;
    target_id: string;
  }>;
  const pg = buildPageGraphFromDb(metaById, edgeRows);
  return { pg, metaById };
}

// ── Search Constants & Helpers ──

const HOP_LIMIT = 5;
const DEFAULT_LIMIT = 20;
const DEFAULT_HOP = 0;
const DEFAULT_DECAY = 0.5;
const DEFAULT_MIN_SCORE = 0.1;
const RELATED_CAP = 10;
const EXPANSION_CAP = 200;

/**
 * Build the `related` field for one result page (PRD FR-1).
 *
 * Out-link (this → other), in-link (other → this), or both. Same neighbour
 * keeps a single entry. Sort by neighbour degree descending, cap at RELATED_CAP.
 */
function buildRelated(
  pageId: string,
  pg: PageGraph,
  metaById: Map<string, PageMeta>,
): RelatedPage[] {
  const out = pg.outAdj.get(pageId) ?? new Set<string>();
  const inn = pg.inAdj.get(pageId) ?? new Set<string>();
  const all = new Set<string>([...out, ...inn]);
  const items: RelatedPage[] = [];
  for (const nbId of all) {
    const nbMeta = metaById.get(nbId);
    if (!nbMeta) continue;
    const isOut = out.has(nbId);
    const isIn = inn.has(nbId);
    const direction: RelatedPage["direction"] = isOut && isIn ? "both" : isOut ? "out" : "in";
    items.push({ title: nbMeta.title, path: nbMeta.relPath, type: nbMeta.type, direction });
  }
  items.sort((a, b) => {
    const da = pg.degree.get(idFromPath(a.path)) ?? 0;
    const db = pg.degree.get(idFromPath(b.path)) ?? 0;
    return db - da;
  });
  return items.slice(0, RELATED_CAP);
}

function idFromPath(relPath: string): string {
  return relPath.replace(/^wiki\//, "").replace(/\.md$/, "");
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Build inter-result wikilink edges (PRD FR-2).
 *
 * Only edges where both endpoints are in `resultIds`. Undirected dedup
 * via sorted-pair key. Self-loops were already excluded at graph-build time.
 */
function buildResultLinks(resultIds: string[], pg: PageGraph, metaById: Map<string, PageMeta>): ResultLink[] {
  const inResults = new Set(resultIds);
  const seen = new Set<string>();
  const links: ResultLink[] = [];
  for (const id of resultIds) {
    const meta = metaById.get(id);
    if (!meta) continue;
    const out = pg.outAdj.get(id) ?? new Set<string>();
    for (const target of out) {
      if (!inResults.has(target)) continue;
      const key = [id, target].sort().join(":::");
      if (seen.has(key)) continue;
      seen.add(key);
      const targetMeta = metaById.get(target);
      links.push({
        source: meta.relPath,
        target: targetMeta ? targetMeta.relPath : target,
        weight: 1,
      });
    }
  }
  return links;
}

// ── 初始化模板 ──

function initWikiProject(projectPath: string): void {
  const dirs = ["raw/sources", "wiki/entities", "wiki/concepts", "wiki/sources", "wiki/comparisons", "wiki/synthesis", ".llm-wiki"];
  for (const dir of dirs) mkdirSync(join(projectPath, dir), { recursive: true });
  const defaultFiles: [string, string][] = [
    ["wiki/schema.md", `---\ntype: schema\ntitle: Wiki Schema\n---\n\n${DEFAULT_SCHEMA}\n`],
    ["wiki/purpose.md", `---\ntype: purpose\ntitle: Wiki Purpose\n---\n\n${DEFAULT_PURPOSE}\n`],
    ["wiki/index.md", "---\ntype: index\ntitle: Index\n---\n\n# Index\n\n## Entities\n\n## Concepts\n\n## Sources\n"],
  ];
  for (const [rel, content] of defaultFiles) {
    const full = join(projectPath, rel);
    if (!existsSync(full)) writeFileSync(full, content, "utf-8");
  }
}

// ── Ingest（ingest-v2；增量抽取见设计 003） ──

/** 单源抽取结果（用于事务内登记 source.status）。 */
interface ProcessedSource {
  filename: string;
  sha256: string;
  size: number;
  ok: boolean;
  error: string | null;
}

interface IngestOutcome {
  /** 兼容旧返回：每个被抽取源的 {source, filesWritten, error}。 */
  results: any[];
  /** 本次尝试抽取的源结果（登记 source 状态用）。 */
  processed: ProcessedSource[];
  /** 表中有但磁盘已无 → 待删 source 行。 */
  deletedSources: string[];
}

/**
 * 增量抽取（设计 003 §3.6 + wiki-ingest-optimization）：
 * 阶段1 并行 LLM 抽取 → 已删源级联清理 → 阶段2 串行 merge 落盘 → overview。
 * 不在此更新 source 表 / 不重建索引——那些交由 ingest() 在同一事务内完成（强一致）。
 * 全部失败检测不在此 throw，由上层 WikiSourceManager.ingest 写事务后判定。
 *
 * 导出供编排层单测（进度相位 / skipped / 全失败不 throw）。
 */
export async function runIngestIncremental(
  projectPath: string,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
  llmConfig: any,
  onProgress?: ProgressFn,
  globalLlmLimit?: LimitFunction,
): Promise<IngestOutcome> {
  const { extractSource, commitCandidates, scanExistingPages } = await import("./ingest-v2/index.js");
  const report = createThrottledProgressFn(onProgress);
  const sourcesDir = join(projectPath, "raw", "sources");
  if (!existsSync(sourcesDir)) {
    log.warn("runIngest: raw/sources 不存在，跳过", { projectPath });
    return { results: [], processed: [], deletedSources: [...oldStates.keys()] };
  }

  // 扫描磁盘源，算 sha。filename = 相对 sourcesDir 的 posix 路径（与 rawWrite 的 filename 对齐）。
  const disk = findMdFiles(sourcesDir).map((abs) => {
    const content = readFileSync(abs, "utf-8");
    return {
      abs,
      filename: relative(sourcesDir, abs).replace(/\\/g, "/"),
      sha256: sha256(content),
      size: Buffer.byteLength(content, "utf-8"),
    };
  });

  const { toIngest, skipped, deleted } = classifySources(disk, oldStates);
  const skippedCount = skipped.length;
  const toIngestSet = new Set(toIngest);
  const toIngestDisk = disk.filter((d) => toIngestSet.has(d.filename));
  log.info("runIngest 增量分类", {
    projectPath,
    disk: disk.length,
    toIngest: toIngest.length,
    skipped: skipped.length,
    deleted: deleted.length,
  });

  const existingPages = scanExistingPages(projectPath);
  const concurrency = getIngestConcurrency();
  const wikiLimit = pLimit(concurrency);

  // ── 阶段1：并行 LLM 抽取 ──
  report?.({
    phase: "extracting",
    total: toIngestDisk.length,
    completed: 0,
    failed: 0,
    skipped: skippedCount,
    percent: 0,
  });

  let completed = 0;
  let failed = 0;

  const tasks = toIngestDisk.map((d) =>
    wikiLimit(async () => {
      const t0 = Date.now();
      try {
        const candidates = await withSpan("ingest-source", async (span) => {
          span.setAttribute("source.name", d.filename);
          const run = () => extractSource(projectPath, d.abs, llmConfig, existingPages);
          return globalLlmLimit ? globalLlmLimit(run) : run();
        });
        completed++;
        report?.({
          phase: "extracting",
          total: toIngestDisk.length,
          completed,
          failed,
          skipped: skippedCount,
          percent: Math.round(((completed + failed) / Math.max(toIngestDisk.length, 1)) * 90),
        });
        log.info("runIngest 单源抽取完成", {
          source: d.filename,
          candidates: candidates.size,
          ms: Date.now() - t0,
        });
        return { ...d, ok: true as const, candidates, error: null };
      } catch (err) {
        failed++;
        report?.({
          phase: "extracting",
          total: toIngestDisk.length,
          completed,
          failed,
          skipped: skippedCount,
          percent: Math.round(((completed + failed) / Math.max(toIngestDisk.length, 1)) * 90),
        });
        log.error("runIngest 单源抽取失败", {
          source: d.filename,
          ms: Date.now() - t0,
          error: String(err),
        });
        return {
          ...d,
          ok: false as const,
          candidates: new Map<string, string>(),
          error: String(err),
        };
      }
    }),
  );

  const extractResults = await Promise.all(tasks);

  // ── 已删源级联清理（与现有逻辑对齐）──
  if (deleted.length > 0) {
    try {
      const { deleteSourceFiles } = await import("./ingest-v2/cascade.js");
      await deleteSourceFiles(
        projectPath,
        deleted.map((fn) => join(sourcesDir, fn)),
        { logReason: "wiki/ingest/removed-source" },
      );
    } catch (err) {
      log.warn("已删源级联清理失败", { error: String(err) });
    }
  }

  // ── 阶段2：串行落盘合并 ──
  report?.({
    phase: "merging",
    total: toIngestDisk.length,
    completed,
    failed,
    skipped: skippedCount,
    percent: 90,
  });

  const successResults = extractResults.filter((r) => r.ok);
  const allCandidates = successResults.map((r) => ({
    sourceFilename: r.filename,
    candidates: r.candidates,
  }));

  // B-1：仅在有候选需 merge/overview 时建 client；失败不 throw，保证上层仍能写 source 状态。
  // 纯 no-op（toIngest=0）或抽取全失败时不建 client（commit 只 rebuild index，不调 LLM）。
  let llm: import("./ingest-v2/llm.js").LlmClient | undefined;
  if (allCandidates.length > 0) {
    try {
      const { createLlmClient } = await import("./ingest-v2/llm.js");
      llm = createLlmClient(llmConfig);
    } catch (err) {
      log.error("创建 LLM client 失败（阶段2 merge/overview 将降级，source 状态仍会落库）", {
        error: String(err),
      });
    }
  }

  // 无成功抽取时仍可能需要在级联删除后重建 index.md；skipLog 避免空 batch 日志
  const { written, mergeErrors } = await commitCandidates(projectPath, allCandidates, llm, {
    globalLlmLimit,
    skipLog: allCandidates.length === 0,
  });

  if (mergeErrors.length > 0) {
    log.warn("阶段2 合并部分页失败", { count: mergeErrors.length, errors: mergeErrors });
  }

  // ── 源状态判定（必须在 commitCandidates 之后）──
  const processed: ProcessedSource[] = extractResults.map((r) => {
    if (!r.ok) {
      return { filename: r.filename, sha256: r.sha256, size: r.size, ok: false, error: r.error };
    }
    const sourcePages = [...r.candidates.keys()];
    const allMergeFailed =
      sourcePages.length > 0 &&
      sourcePages.every((p) => mergeErrors.some((e) => e.source === r.filename && e.relPath === p)) &&
      !sourcePages.some((p) => written.includes(p));
    return {
      filename: r.filename,
      sha256: r.sha256,
      size: r.size,
      ok: !allMergeFailed,
      error: allMergeFailed ? "all candidates merge failed" : null,
    };
  });

  // ── 阶段3：overview（FTS 索引由上层 ingest 写事务完成）──
  report?.({
    phase: "indexing",
    total: toIngestDisk.length,
    completed,
    failed,
    skipped: skippedCount,
    percent: 98,
  });

  if (successResults.length > 0) {
    if (!llm) {
      log.warn("overview 跳过：LLM client 不可用（不影响摄取）");
    } else {
      try {
        const { generateOverview } = await import("./ingest-v2/overview.js");
        const runOverview = () => generateOverview(projectPath, llm);
        await (globalLlmLimit ? globalLlmLimit(runOverview) : runOverview());
      } catch (err) {
        log.warn("overview 生成失败（不影响摄取）", { error: String(err) });
      }
    }
  }

  const results = extractResults.map((r) => {
    if (!r.ok) return { source: r.filename, filesWritten: [] as string[], error: r.error };
    const sourcePages = [...r.candidates.keys()];
    const filesWritten = sourcePages.filter((p) => written.includes(p));
    return { source: r.filename, filesWritten, error: null };
  });

  const okCount = processed.filter((p) => p.ok).length;
  log.info("runIngest 全部完成", {
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    written: written.length,
  });

  // 全部失败检测：不在此处 throw（由上层写事务后判定，保证 source 状态已持久化）。
  return { results, processed, deletedSources: deleted };
}

function findMdFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...findMdFiles(full));
    else if (entry.endsWith(".md") || entry.endsWith(".txt")) files.push(full);
  }
  return files;
}

// ── Factory ──

export function createWikiSourceManager(dataDir: string): WikiSourceManager {
  const sources = new Map<string, WikiSourceState>();
  const stateFile = join(dataDir, "wiki-sources.json");

  mkdirSync(dataDir, { recursive: true });

  function persist() {
    writeFileSync(stateFile, JSON.stringify(Object.fromEntries(sources.entries()), null, 2), "utf-8");
  }

  function loadState() {
    if (!existsSync(stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
      for (const [name, state] of Object.entries<any>(raw)) {
        if (state.status === "scanning") { state.status = "error"; state.error = "Restart"; }
        sources.set(name, state);
      }
    } catch { /* fresh start */ }
  }

  function scanWikiDir(projectPath: string): WikiPage[] {
    const wikiDir = join(projectPath, "wiki");
    if (!existsSync(wikiDir)) throw new Error(`wiki/ not found: ${wikiDir}`);
    const pages: WikiPage[] = [];
    scanRecursive(wikiDir, wikiDir, pages);
    return pages;
  }

  function scanRecursive(baseDir: string, dir: string, pages: WikiPage[]) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) { if (entry !== "media") scanRecursive(baseDir, full, pages); }
      else if (entry.endsWith(".md")) {
        try {
          const content = readFileSync(full, "utf-8");
          const rel = full.slice(baseDir.length + 1);
          const id = rel.replace(/\.md$/, "").replace(/\\/g, "/");
          const fm = extractFrontmatter(content);
          pages.push({ id, title: fm.title || basename(entry, ".md").replace(/-/g, " "), type: fm.type, path: full, relPath: `wiki/${rel}`, content, sources: fm.sources, links: extractWikilinks(content), description: fm.description });
        } catch { /* skip */ }
      }
    }
  }

  /** 重建 wiki 的 index.db 索引（幂等建库 → 事务重建三表 → 驱逐读连接防 stale）。 */
  function rebuildIndex(name: string, pages: WikiPage[]) {
    const state = sources.get(name);
    if (!state) throw new Error(`rebuildIndex: unknown wiki ${name}`);
    initIndexDb(state.path); // 幂等：首次注册即建库+4表；已存在则无操作
    withWriteDb(state.path, (db) => writeIndex(db, pages));
    evictWikiDb(name); // 丢弃可能持有旧快照的读连接，下次查询重开
  }

  function searchInternal(name: string, query: string, limit: number, options: SearchOptions): SearchResponse {
    const state = sources.get(name);
    if (!state) return { results: [], links: [], count: 0 };

    let db: DatabaseType.Database;
    try {
      db = getReadDb(name, state.path);
    } catch {
      // 库不存在（wiki 未 ingest/未建索引）→ 返回空，与旧"无引擎"行为一致。
      return { results: [], links: [], count: 0 };
    }

    const hop = clamp(options.hop ?? DEFAULT_HOP, 0, HOP_LIMIT);
    const decay = clamp(options.decay ?? DEFAULT_DECAY, 0, 1);
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const finalLimit = limit > 0 ? limit : DEFAULT_LIMIT;

    // Pull a slightly oversized seed pool so graph expansion still has something
    // to walk from when `limit` is small but `hop>0` is requested.
    const seedPoolSize = Math.max(finalLimit, hop > 0 ? finalLimit * 2 : finalLimit);
    const rawSeeds = ftsSearch(db, query, seedPoolSize);
    if (rawSeeds.length === 0) {
      return { results: [], links: [], count: 0 };
    }

    const { pg, metaById } = loadReadModel(db);

    let hits: { id: string; score: number; hop: number; via?: string }[];
    if (hop === 0) {
      hits = rawSeeds.slice(0, finalLimit).map((s) => ({ id: s.id, score: s.score, hop: 0 }));
    } else {
      hits = graphMultiHopSearch(pg.graph, rawSeeds, { hop, decay, minScore, maxNodes: EXPANSION_CAP });
      hits = hits.slice(0, finalLimit);
    }

    const results: SearchResult[] = [];
    const resultIds: string[] = [];
    for (const hit of hits) {
      const meta = metaById.get(hit.id);
      if (!meta) continue;
      const result: SearchResult = {
        path: meta.relPath,
        title: meta.title,
        snippet: meta.snippet,
        score: hit.score,
        type: meta.type,
        hop: hit.hop,
        related: buildRelated(meta.id, pg, metaById),
      };
      if (hit.hop > 0 && hit.via) result.via = hit.via;
      results.push(result);
      resultIds.push(meta.id);
    }

    const links = buildResultLinks(resultIds, pg, metaById);
    return { results, links, count: results.length };
  }

  loadState();
  // 启动时恢复 BM25 搜索索引（重建每个 ready wiki 的 index.db / pagesMap / searchEngines）。
  // loadState 只恢复元数据（sources map）；索引数据虽持久，但为对齐磁盘正文并避免
  // search / pages / graph 在重启后返回空，仍从磁盘扫描重建一次。
  log.info("Restoring wiki indexes", { count: sources.size });
  let restored = 0;
  let failed = 0;
  for (const [name, state] of sources.entries()) {
    if (state.status !== "ready") {
      log.debug("Skip non-ready wiki source", { name, status: state.status });
      continue;
    }
    const wikiDir = join(state.path, "wiki");
    if (!existsSync(wikiDir)) {
      log.warn("Wiki dir missing on disk; mark error and skip restore", { name, path: state.path });
      state.status = "error";
      state.error = `wiki dir not found: ${wikiDir}`;
      failed++;
      continue;
    }
    try {
      const pages = scanWikiDir(state.path);
      rebuildIndex(name, pages);
      restored++;
      log.info("Restored wiki index", { name, pageCount: pages.length });
    } catch (err) {
      failed++;
      log.error("Failed to restore wiki index", { name, error: err instanceof Error ? err.message : String(err) });
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }
  log.info("Wiki restore complete", { restored, failed, total: sources.size });

  function register(config: WikiSourceConfig): WikiSourceState {
    const existing = sources.get(config.name);
    if (existing) return existing;
    const state: WikiSourceState = { name: config.name, path: config.path, status: "scanning" };
    sources.set(config.name, state);
    try {
      const pages = scanWikiDir(config.path);
      rebuildIndex(config.name, pages);
      state.status = "ready"; state.pageCount = pages.length; state.lastSyncAt = new Date().toISOString();
    } catch (err) { state.status = "error"; state.error = String(err); }
    persist();
    return state;
  }

  function sync(name: string): WikiSourceState {
    const state = sources.get(name);
    if (!state) throw new Error(`Not found: ${name}`);
    state.status = "scanning";
    const t0 = Date.now();
    try {
      const pages = scanWikiDir(state.path);
      rebuildIndex(name, pages);
      state.status = "ready"; state.pageCount = pages.length; state.lastSyncAt = new Date().toISOString(); state.error = undefined;
      log.info("sync 完成（索引已重建）", { name, pageCount: pages.length, ms: Date.now() - t0 });
    } catch (err) {
      state.status = "error"; state.error = String(err);
      log.error("sync 失败", { name, path: state.path, error: String(err) });
    }
    persist();
    return state;
  }

  function init(config: WikiSourceConfig): WikiSourceState {
    initWikiProject(config.path);
    return register(config);
  }

  async function ingest(name: string, llmConfig: any, opts?: IngestExecOptions): Promise<any[]> {
    const state = sources.get(name);
    if (!state) throw new Error(`Not found: ${name}`);
    const projectPath = state.path;
    initIndexDb(projectPath); // 确保 index.db 存在（register 通常已建，幂等）

    // 读上次 source 状态（增量判断基线）——须在抽取前读取。
    let oldStates = new Map<string, { sha256: string; status: SourceStatus }>();
    try {
      oldStates = readSourceStates(getReadDb(name, projectPath));
    } catch {
      /* 库刚建 / 无 source 行 → 全部视为新增 */
    }

    const outcome = await withSpan("wiki-ingest", async (span) => {
      span.setAttribute("wiki.name", name);
      return runIngestIncremental(
        projectPath,
        oldStates,
        llmConfig,
        opts?.onProgress,
        opts?.globalLlmLimit,
      );
    });

    // 重建索引 + 登记 source 状态 + 删已删源行：**同一写事务**（设计 003 §3.6 step 6，强一致）。
    state.status = "scanning";
    const t0 = Date.now();
    try {
      const pages = scanWikiDir(projectPath);
      withWriteDb(projectPath, (db) => {
        writeIndex(db, pages);
        for (const p of outcome.processed) recordSourceIngestResult(db, p);
        if (outcome.deletedSources.length > 0) deleteSources(db, outcome.deletedSources);
      });
      evictWikiDb(name); // 丢弃可能持旧快照的读连接

      const attempted = outcome.processed.length;
      const failed = outcome.processed.filter((p) => !p.ok);
      if (attempted > 0 && failed.length === attempted) {
        const first = failed[0];
        throw new Error(
          `all source documents failed to ingest${first ? `; first failure: ${first.filename}: ${first.error ?? "unknown"}` : ""}`,
        );
      }

      state.status = "ready";
      state.pageCount = pages.length;
      state.lastSyncAt = new Date().toISOString();
      state.error = undefined;
      log.info("ingest 完成（增量抽取 + 索引/源状态同事务重建）", {
        name,
        pageCount: pages.length,
        extracted: outcome.processed.length,
        failed: failed.length,
        ms: Date.now() - t0,
      });
    } catch (err) {
      state.status = "error";
      state.error = String(err);
      log.error("ingest 失败", { name, path: projectPath, error: String(err) });
      persist();
      throw err;
    }
    persist();
    return outcome.results;
  }

  return {
    register, sync, init, ingest,
    get: (name) => sources.get(name),
    list: () => [...sources.values()],
    remove: (name) => {
      const state = sources.get(name);
      sources.delete(name);
      // 先关读连接（内部 checkpoint+close），目录 rmSync 由调用方（wiki-service/route）负责。
      evictWikiDb(name);
      if (state) { /* index.db 随目录删除一并清理 */ }
      persist();
    },
    search: (name, query, limit, options) => searchInternal(name, query, limit ?? DEFAULT_LIMIT, options ?? {}),
    graph: (name) => {
      const state = sources.get(name);
      if (!state) return { nodes: [], edges: [], communities: [] };
      try {
        const db = getReadDb(name, state.path);
        return loadReadModel(db).pg.view;
      } catch {
        return { nodes: [], edges: [], communities: [] };
      }
    },
    readPage: (name, relPath) => {
      const state = sources.get(name);
      if (!state) return null;

      // 支持 raw/ 前缀：直接从项目根读取
      if (relPath.startsWith("raw/")) {
        const fullPath = join(state.path, relPath);
        if (!fullPath.startsWith(join(state.path, "raw"))) return null; // 防路径穿越
        try { return readFileSync(fullPath, "utf-8"); } catch {}
        if (!relPath.endsWith(".md")) {
          try { return readFileSync(fullPath + ".md", "utf-8"); } catch {}
        }
        return null;
      }

      // 支持多种格式：
      //   "wiki/concepts/l0-录入.md" → 完整 relPath
      //   "concepts/l0-录入.md"      → 去掉 wiki/ 前缀
      //   "concepts/l0-录入"         → id 格式（不带 .md）
      const cleanPath = relPath.replace(/^wiki\//, "");
      const base = join(state.path, "wiki");
      let fullPath = join(base, cleanPath);
      if (!fullPath.startsWith(base)) return null;
      // 先直接尝试，再补 .md
      try { return readFileSync(fullPath, "utf-8"); } catch {}
      if (!cleanPath.endsWith(".md")) {
        try { return readFileSync(fullPath + ".md", "utf-8"); } catch {}
      }
      return null;
    },
    getPages: (name) => {
      const state = sources.get(name);
      if (!state) return [];
      try { return scanWikiDir(state.path); } catch { return []; }
    },
  };
}
