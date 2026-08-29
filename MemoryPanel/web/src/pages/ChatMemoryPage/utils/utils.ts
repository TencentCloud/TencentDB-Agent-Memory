import type { MemoryBlock, MemoryLayer } from '../constants/types';
import i18n from '@/i18n';

/**
 * ISO 时间字符串 → 面板展示格式（本地时区，'YYYY-MM-DD HH:MM'）。
 * 输入非法或空 → 返空串，caller 用短路（`t && <span>...</span>`）跳过展示。
 */
export function formatDisplayTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 紧凑时间：今天 HH:MM，昨天「昨天」，更早 MM-DD。 */
export function formatShortTime(ms: number): string {
  const now = new Date();
  const d = new Date(ms);
  const sameDay =
    now.getFullYear() === d.getFullYear() && now.getMonth() === d.getMonth() && now.getDate() === d.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    yesterday.getFullYear() === d.getFullYear() &&
    yesterday.getMonth() === d.getMonth() &&
    yesterday.getDate() === d.getDate()
  ) return i18n.t('common.yesterday');
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 去除 @ 提及，保留纯对话内容。 */
export function stripAtMention(text: string): string {
  return text.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim();
}

/** 从后端显式 role 字段提取 L0 角色；仅对旧数据回退解析 title 的 @ 前缀。 */
export function extractRole(roleOrTitle: string): string {
  const raw = roleOrTitle.split('@')[0]?.trim().toLowerCase() || '';
  if (raw === 'user') return 'user';
  if (raw === 'assistant') return 'assistant';
  if (raw === 'system') return 'system';
  if (raw === 'tool') return 'tool';
  return raw || 'message';
}

/** 某层的展示条数：优先 layerCounts，回退到本地估算。 */
export function getLayerCount(block: MemoryBlock, l: MemoryLayer): number {
  const real = block.layerCounts[l];
  if (real !== undefined) return real;
  return l === 'L0' ? block.layers.L0.length : block.layers[l].length;
}
