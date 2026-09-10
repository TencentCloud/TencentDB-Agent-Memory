/**
 * DeltaBadge — 环比增量徽标。
 *
 * 正向 ↑（success 色）/ 负向 ↓（error 色）/ 持平 ≈（次要色）。
 * 阈值 0.005：低于该幅度视为持平，避免 CH round(…,2) 的尾差被渲染成"变化"。
 */

const FLAT_THRESHOLD = 0.005;

export function DeltaBadge({
  value,
  unit,
}: {
  value: number | null | undefined;
  unit: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  const up = value > FLAT_THRESHOLD;
  const down = value < -FLAT_THRESHOLD;
  const cls = up ? '_an-delta--up' : down ? '_an-delta--down' : '_an-delta--flat';
  const sign = up ? '↑' : down ? '↓' : '≈';
  const magnitude = up || down ? Math.abs(value).toFixed(2) : '0';

  return (
    <span className={`_an-delta ${cls}`}>
      {`${sign} ${magnitude}${unit}`}
    </span>
  );
}
