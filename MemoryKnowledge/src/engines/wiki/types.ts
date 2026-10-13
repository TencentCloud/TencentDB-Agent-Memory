import type { OkfMetadata } from "./okf.js";
/**
 * Wiki 类型定义
 */

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

export interface WikiPage {
  id: string;
  title: string;
  type: string;
  path: string;       // 绝对路径
  relPath: string;    // wiki/ 相对路径
  content: string;
  sources: string[];
  links: string[];    // outbound [[wikilinks]]
  /** Optional frontmatter `description` — used as snippet fallback for graph-expanded hits. */
  description?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  path: string;
  linkCount: number;
  community: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface CommunityInfo {
  id: number;
  nodeCount: number;
  cohesion: number;
  topNodes: string[];
}

export interface RelatedPage {
  title: string;
  path: string;
  type: string;
  direction: "out" | "in" | "both";
}

export interface ResultLink {
  source: string;
  target: string;
  weight: number;
}

export interface SearchResult {
  /** Advisory OKF provenance, freshness and trust; never an authorization decision. */
  okf?: OkfMetadata;
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
  /** Min hop distance from a BM25 seed. 0 = direct BM25 hit, >0 = graph-expanded. */
  hop?: number;
  /** Title of the previous-hop page on the shortest path (only when hop > 0). */
  via?: string;
  /** Wikilink neighbours (out + in), de-duplicated and capped. */
  related?: RelatedPage[];
}

export interface SearchResponse {
  results: SearchResult[];
  /** Wikilink edges where both endpoints are in `results`. */
  links: ResultLink[];
  count: number;
}

export interface WikiSourceConfig {
  /** 名称（唯一标识） */
  name: string;
  /** wiki 目录的绝对路径（里面应该有 wiki/ 子目录） */
  path: string;
}

export interface WikiSourceState {
  name: string;
  path: string;
  status: "scanning" | "ready" | "error";
  error?: string;
  pageCount?: number;
  lastSyncAt?: string;
}

export const GENERATION_WIKI_TYPES = [
  "source", "entity", "concept", "comparison",
  "query", "synthesis", "thesis", "methodology", "finding",
] as const;
