/**
 * wiki-constants —— Wiki 资产页的常量、类型与纯工具函数。
 * 从 WikiSourcesPanel.tsx 拆出，供主面板 / 详情视图 / hooks 复用。
 */
import type { WikiDetail } from '@/lib/knowledge-api';

/** Wiki 仅允许上传 Markdown 类文件（.md / .markdown / .txt）。 */
export const WIKI_ALLOWED_FILE_RE = /\.(md|txt|markdown)$/i;

// Wiki 状态徽章：draft=建壳未加工（待用户点 ingest）；pending=排队；processing=加工中；ready=就绪；failed=失败；missing=KS 数据丢失。
// 走 Tea Tag 的语义 theme（soft 变体），随主题响应，不用硬编码调色板色。
export const WIKI_STATUS_THEME: Record<WikiDetail['status'], 'warning' | 'success' | 'error' | 'default'> = {
  draft: 'warning',
  pending: 'warning',
  processing: 'warning',
  ready: 'success',
  failed: 'error',
  missing: 'error',
};
export const WIKI_STATUS_KEY: Record<WikiDetail['status'], string> = {
  draft: 'wiki.status.draft',
  pending: 'wiki.status.pending',
  processing: 'wiki.status.processing',
  ready: 'wiki.status.ready',
  failed: 'wiki.status.failed',
  missing: 'wiki.status.missing',
};

export type SubView = 'list' | 'detail';
export type DetailTab = 'overview' | 'graph' | 'pages' | 'search';
export type ViewMode = 'card' | 'list';
export type StatusFilter = 'all' | 'ready' | 'processing';

export function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
}

export const TYPE_COLORS: Record<string, string> = {
  entity: 'var(--tea-color-bg-brand-default)',
  concept: 'var(--tea-color-bg-warning-default)',
  source: 'var(--tea-color-bg-amber-default)',
  query: 'var(--tea-color-bg-success-default)',
  synthesis: 'var(--tea-color-bg-error-default)',
  overview: 'var(--tea-color-bg-yellow-default)',
  comparison: 'var(--tea-color-bg-secondary-active)',
  finding: 'var(--tea-color-bg-warning-default)',
  thesis: 'var(--tea-color-bg-error-default)',
  methodology: 'var(--tea-color-bg-success-default)',
  other: 'var(--tea-color-bg-tertiary-default)',
  raw: 'var(--tea-color-bg-secondary-default)',
};
export const TYPE_COLOR_FALLBACK = 'var(--tea-color-text-tertiary)';

export type WikiScopeTab = 'all' | 'team' | 'fixed' | 'scope';
export const SCOPE_LABEL_KEYS: Record<WikiScopeTab, string> = {
  all: 'wiki.scope.all',
  team: 'wiki.scope.team',
  fixed: 'wiki.scope.fixed',
  scope: 'wiki.scope.scope',
};
