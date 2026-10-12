/**
 * TrendLines — 多线趋势折线（零图表依赖的轻量 SVG 实现）。
 *
 * 归一化到 viewBox 100×H 后用 preserveAspectRatio="none" 横向拉伸铺满容器。
 *
 * 两个必须保留的实现约束（改动前先读完）：
 *
 * 1. **必须渲染数据点标记，不能只画 polyline。**
 *    时序按自然日聚合，`days=1` 时通常只返回 1~2 行；而单个点的 `<polyline>`
 *    没有线段、不产生任何可见图形 —— 只画折线会让"最近 1 天"的图表整片空白
 *    （KPI 有数值、趋势图却什么都没有）。点标记是该场景下唯一的可见元素。
 *
 * 2. **点标记用「零长度 line + round linecap + non-scaling-stroke」，不能用 `<circle>`。**
 *    preserveAspectRatio="none" 会把 viewBox 的 100 个横向单位拉伸到容器实际宽度
 *    （常见 8 倍以上），`<circle>` 会被压成扁椭圆。而描边宽度不受几何变换影响，
 *    零长度子路径配 round cap 按 SVG 规范渲染为正圆，是拉伸场景下唯一稳定的画点方式。
 */
import { StatusTip, Text } from 'tea-component';
import { fmtInt, fmtShortDay } from '../utils/formatters';

const VIEW_HEIGHT = 180;
const PAD_TOP = 8;
const PAD_BOTTOM = 16;
/** 点标记直径（px，non-scaling-stroke 下不随容器缩放）。 */
const DOT_SIZE = 5;
/** 超过该点数不再画点标记，否则密集点会糊成一片（90 天窗口）。 */
const MAX_DOTS = 31;
/** 不超过该点数时 X 轴逐点标注日期，否则只标首末。 */
const MAX_FULL_AXIS = 3;

export interface TrendLineConfig<T> {
  key: keyof T & string;
  label: string;
  color: string;
}

export function TrendLines<T extends { day: string }>({
  rows,
  lines,
  emptyText,
  maxLabel,
  singlePointHint,
}: {
  rows: T[];
  lines: Array<TrendLineConfig<T>>;
  emptyText: string;
  /** 峰值说明文案（由页面经 i18n 传入，组件内不硬编码文案）。 */
  maxLabel: (max: string) => string;
  /** 仅 1 个数据点时的说明文案（无法形成趋势对比）。 */
  singlePointHint: string;
}) {
  if (rows.length === 0) {
    return <StatusTip status="empty" emptyText={emptyText} />;
  }

  const valueAt = (row: T, key: keyof T & string): number => {
    const v = Number(row[key]);
    return Number.isFinite(v) ? v : 0;
  };

  const max = Math.max(1, ...rows.flatMap((r) => lines.map((l) => valueAt(r, l.key))));
  const n = rows.length;
  // 单点时居中（贴左边缘会被 Y 轴侧裁切、观感像渲染失败）
  const xAt = (i: number): number => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const yAt = (v: number): number => PAD_TOP + (1 - v / max) * (VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM);

  const showDots = n <= MAX_DOTS;
  const axisDays =
    n <= MAX_FULL_AXIS ? rows.map((r) => fmtShortDay(r.day)) : [fmtShortDay(rows[0].day), fmtShortDay(rows[n - 1].day)];

  return (
    <div className="_an-trend">
      <svg
        viewBox={`0 0 100 ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="_an-trend-svg"
      >
        {lines.map((l) => (
          <g key={l.key}>
            {n > 1 && (
              <polyline
                fill="none"
                stroke={l.color}
                strokeWidth="0.6"
                vectorEffect="non-scaling-stroke"
                points={rows
                  .map((r, i) => `${xAt(i).toFixed(2)},${yAt(valueAt(r, l.key)).toFixed(2)}`)
                  .join(' ')}
              >
                <title>{l.label}</title>
              </polyline>
            )}
            {showDots &&
              rows.map((r, i) => {
                const v = valueAt(r, l.key);
                const x = xAt(i).toFixed(2);
                const y = yAt(v).toFixed(2);
                return (
                  <line
                    key={`${l.key}-${r.day}-${i}`}
                    x1={x}
                    y1={y}
                    x2={x}
                    y2={y}
                    stroke={l.color}
                    strokeWidth={DOT_SIZE}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{`${r.day} · ${l.label}: ${fmtInt(v)}`}</title>
                  </line>
                );
              })}
          </g>
        ))}
      </svg>

      <div className={`_an-trend-axis${n === 1 ? ' _an-trend-axis--single' : ''}`}>
        {axisDays.map((day, i) => (
          <span key={`${day}-${i}`}>{day}</span>
        ))}
      </div>

      <div className="_an-trend-legend">
        {lines.map((l) => (
          <span className="_an-trend-legend-item" key={l.key}>
            <i style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
        <span className="_an-trend-max">{maxLabel(fmtInt(max))}</span>
      </div>

      {n === 1 && (
        <Text theme="label" className="_an-trend-hint">
          {singlePointHint}
        </Text>
      )}
    </div>
  );
}
