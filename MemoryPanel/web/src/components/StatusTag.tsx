/**
 * StatusTag —— 通用「状态标签」组件。
 *
 * 此前 Wiki（WikiStatusBadge）与 Code（statusLabel）各自实现 status → Tea Tag
 * 的渲染（theme + variant="soft" + 可选 hint），结构完全一致。这里统一收口，
 * 各资产页只负责提供「status → label/theme」的业务映射。
 */
import { Tag } from 'tea-component';

export type StatusTheme = 'default' | 'success' | 'warning' | 'error';

export function StatusTag({
  label,
  theme = 'default',
  hint,
  className,
}: {
  /** 已翻译的状态文案（或原始 status 兜底） */
  label: string;
  /** Tea Tag 语义主题（soft 变体） */
  theme?: StatusTheme;
  /** 可选的状态补充说明（如 processing 时的“处理中，可能需要几分钟”） */
  hint?: string;
  /** 外层容器 class（默认 _asset-status） */
  className?: string;
}) {
  return (
    <span className={className ?? '_asset-status'}>
      <Tag theme={theme} variant="soft" size="sm">
        {label}
      </Tag>
      {hint && <span className="_asset-status-hint">{hint}</span>}
    </span>
  );
}
