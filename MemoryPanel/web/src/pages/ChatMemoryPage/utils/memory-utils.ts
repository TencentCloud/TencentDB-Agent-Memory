/**
 * memory-utils —— Chat Memory 页的常量、纯工具函数与类型。
 * 从 ChatMemoryPanel.tsx 拆出。
 */
import { ApiError, type ChatMemoryLayerItem } from '@/lib/teamApi';
import type { MemoryBlock, MemoryLayer } from '../constants/types';

export const LAYER_PAGE_SIZE: Record<MemoryLayer, number> = { L0: 20, L1: 20, L2: 50, L3: 50 };
export function layerPageSize(layer: MemoryLayer): number {
  return LAYER_PAGE_SIZE[layer];
}

/** 详情页时间筛选器范围，start / end 为 ISO8601 字符串 */
export interface TimeRange {
  start: string;
  end: string;
}

/** 详情页时间筛选器默认范围：当前时间 ~ 前一天 */
export function defaultTimeRange(): TimeRange {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** 后端探测到「筛选范围过大，VDB 无法支撑」时返回的业务错误 */
export function isRangeTooLargeError(e: unknown): boolean {
  return e instanceof ApiError && e.message === 'RANGE_TOO_LARGE';
}

export function mapLayerItem(i: ChatMemoryLayerItem) {
  return {
    id: i.id,
    title: i.title,
    body: i.body,
    refs: i.refs,
    tags: i.tags,
    created_at: i.created_at,
  };
}

/**
 * 剥掉 scenario（L2）markdown 的 META 头。
 * scenario/read 返回的正文带 `-----META-START-----...-----META-END-----`
 * 系统字段头；编辑框只展示纯正文，写回时后端会用现有 META 自动重建。
 */
export function stripScenarioMeta(content: string): string {
  return content
    .replace(/^-----META-START-----\n[\s\S]*?\n-----META-END-----\n?/, '')
    .replace(/^\n+/, '');
}

// 由列表接口的 layer_counts 构造初始 layerCounts：只保留 >0 的真实计数，
// 其余留 undefined＝「未知」。徽章据此显示占位，避免把「未加载」误显示成「0」，
// 也不再为拿计数而预请求。后端 layer_counts 落地真实值后此处会自动直接采用。
export function buildInitialLayerCounts(lc: {
  L0_messages: number;
  L1: number;
  L2: number;
  L3: number;
}): MemoryBlock['layerCounts'] {
  const out: MemoryBlock['layerCounts'] = {};
  if (lc.L0_messages > 0) out.L0 = lc.L0_messages;
  if (lc.L1 > 0) out.L1 = lc.L1;
  if (lc.L2 > 0) out.L2 = lc.L2;
  if (lc.L3 > 0) out.L3 = lc.L3;
  return out;
}

/**
 * 复制文本到剪贴板，返回是否成功。
 *
 * navigator.clipboard 仅在安全上下文（HTTPS / localhost）可用；面板若经
 * http:// + 内网 IP 访问，navigator.clipboard 为 undefined，会导致复制失败。
 * 因此优先用 Clipboard API，不可用时降级到 document.execCommand('copy')
 * 的临时 textarea 方案，兼容非安全上下文。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 优先：安全上下文下的 Clipboard API
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 落到下方 execCommand 兜底
    }
  }
  // 兜底：非安全上下文（http + IP）用 execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 移出视口、避免滚动与聚焦跳动
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
