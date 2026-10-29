/**
 * wiki-constants —— Wiki 资产页的常量、类型与纯工具函数。
 * 从 WikiSourcesPanel.tsx 拆出，供主面板 / 详情视图 / hooks 复用。
 *
 * 通用资产类型与 formatShortTime 已收敛到 @/lib/asset-common，此处 re-export
 * 保持原有 import 路径不变。
 */
import type { WikiDetail, WikiFileFormat } from '@/lib/api/knowledge-api';
export type { WikiFileFormat } from '@/lib/api/knowledge-api';
export type { SubView, ViewMode, StatusFilter } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/**
 * 兜底清单：**仅在后端接口不可用时使用**。
 *
 * 正常路径是启动时拉取 `formats`（见 `wiki-format-store.ts`）。
 * 这里保留一份快照是为了接口失败时不至于完全无法上传，
 * 但与后端注册表可能不同步 —— 接口恢复后以接口为准。
 */
export const FALLBACK_FORMATS: WikiFileFormat[] = [
  { ext: 'md', sizeTier: 'text', preview: 'markdown', converter: 'passthrough' },
  { ext: 'markdown', sizeTier: 'text', preview: 'markdown', converter: 'passthrough' },
  { ext: 'txt', sizeTier: 'text', preview: 'native', converter: 'passthrough' },
  { ext: 'html', sizeTier: 'text', preview: 'native', converter: 'passthrough' },
  { ext: 'htm', sizeTier: 'text', preview: 'native', converter: 'passthrough' },
  { ext: 'csv', sizeTier: 'text', preview: 'converted', converter: 'officeparser' },
  { ext: 'docx', sizeTier: 'binary', preview: 'client', converter: 'officeparser' },
  { ext: 'xlsx', sizeTier: 'binary', preview: 'client', converter: 'officeparser' },
  { ext: 'pdf', sizeTier: 'binary', preview: 'native', converter: 'officeparser' },
  { ext: 'pptx', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'odt', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'ods', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'odp', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'odg', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'rtf', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
  { ext: 'epub', sizeTier: 'binary', preview: 'converted', converter: 'officeparser' },
];

/**
 * 原始文档预览失败错误码 → i18n key。
 *
 * 错误码由 KS 转换层（document-converter/errors.ts）给出，此处只做展示映射。
 * 未收录的码回落到通用失败文案。
 */
export const RAW_PREVIEW_ERROR_KEYS: Record<string, string> = {
  UNSUPPORTED_FILE_TYPE: 'wiki.rawPreview.unsupported',
  FILE_TYPE_MISMATCH: 'wiki.rawPreview.mismatch',
  ENCRYPTED_FILE: 'wiki.rawPreview.encrypted',
  SCANNED_PDF_UNSUPPORTED: 'wiki.rawPreview.scannedPdf',
  CONVERTER_NOT_READY: 'wiki.rawPreview.notReady',
  CONVERT_TIMEOUT: 'wiki.rawPreview.timeout',
  CONVERT_FAILED: 'wiki.rawPreview.failed',
};

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

export type WikiScopeTab = 'all' | 'team' | 'fixed' | 'scope';
export const SCOPE_LABEL_KEYS: Record<WikiScopeTab, string> = {
  all: 'wiki.scope.all',
  team: 'wiki.scope.team',
  fixed: 'wiki.scope.fixed',
  scope: 'wiki.scope.scope',
};

export type DetailTab = 'overview' | 'graph' | 'pages' | 'search';

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
