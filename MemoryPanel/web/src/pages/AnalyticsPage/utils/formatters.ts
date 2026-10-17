/**
 * 可观测页数值格式化 —— 页面与各展示组件共用。
 *
 * 统一以 '—' 表示「无数据」，与 Panel 其他页面保持一致；
 * 非有限数（NaN / Infinity）同样按无数据处理，避免把 CH 异常值直接呈现给用户。
 */

const PLACEHOLDER = '—';

function isBlank(v: number | null | undefined): boolean {
  return v === null || v === undefined || !Number.isFinite(v);
}

/** 整数（千分位）。 */
export function fmtInt(v: number | null | undefined): string {
  return isBlank(v) ? PLACEHOLDER : Math.round(v as number).toLocaleString();
}

/** 百分比数值（不含 % 号，供 MetricsBoard 的 unit 承载单位）。 */
export function fmtPctValue(v: number | null | undefined): string {
  return isBlank(v) ? PLACEHOLDER : (v as number).toFixed(2);
}

/** 百分比（含 % 号），用于表格 / 条形图等行内展示。 */
export function fmtPct(v: number | null | undefined): string {
  return isBlank(v) ? PLACEHOLDER : `${(v as number).toFixed(2)}%`;
}

/** 小数（默认 2 位）。 */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  return isBlank(v) ? PLACEHOLDER : (v as number).toFixed(digits);
}

/** `YYYY-MM-DD` → `MM-DD`（趋势图轴标签用，节省横向空间）。 */
export function fmtShortDay(day: string): string {
  const m = /^\d{4}-(\d{2}-\d{2})$/.exec(day);
  return m ? m[1] : day;
}

/**
 * 大数紧凑显示（token 量级常达千万，完整千分位会挤爆卡片）。
 * 1234 → 1.2K；48000000 → 48.0M；1.2e9 → 1.2B
 */
export function fmtCompact(v: number | null | undefined): string {
  if (isBlank(v)) return PLACEHOLDER;
  const n = v as number;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

/** credit 金额：保留 2 位小数并加千分位。 */
export function fmtCredit(v: number | null | undefined): string {
  if (isBlank(v)) return PLACEHOLDER;
  return (v as number).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export { PLACEHOLDER };
