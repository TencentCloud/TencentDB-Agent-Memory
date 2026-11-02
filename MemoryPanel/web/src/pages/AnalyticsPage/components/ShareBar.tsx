/**
 * ShareBar — 占比横向条（零图表依赖）。
 *
 * 泛型 + 取值函数：调用方显式提供 label / value 的读取方式，写错字段名在编译期
 * 即报错（此前用 `valueKey: string` 字符串魔法值，字段名写错只会静默显示 0）。
 */
import { StatusTip } from 'tea-component';
import { fmtInt, fmtPct } from '../utils/formatters';

export interface ShareBarRow {
  /** 占比（0–100），由内核 SQL round(…,2) 给出。 */
  pct: number;
}

export function ShareBar<T extends ShareBarRow>({
  rows,
  labelOf,
  valueOf,
  emptyText,
}: {
  rows: T[];
  labelOf: (row: T) => string;
  valueOf: (row: T) => number;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <StatusTip status="empty" emptyText={emptyText} />;
  }

  // 以最大占比为满格基准：单项占比偏低时也能看出相对差异。
  const max = Math.max(...rows.map((r) => r.pct || 0), 1);

  return (
    <div className="_an-sharebar">
      {rows.map((row, index) => {
        const label = labelOf(row);
        const pct = row.pct || 0;
        return (
          // label 可能为空串（CH 中该维度为空值），故与 index 组合成稳定 key
          <div className="_an-sharebar-row" key={`${label}#${index}`}>
            <span className="_an-sharebar-label" title={label}>
              {label}
            </span>
            <div className="_an-sharebar-track">
              <div className="_an-sharebar-fill" style={{ width: `${(pct / max) * 100}%` }} />
            </div>
            <span className="_an-sharebar-value">
              {fmtPct(pct)} <em>({fmtInt(valueOf(row))})</em>
            </span>
          </div>
        );
      })}
    </div>
  );
}
