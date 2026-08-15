/**
 * 公共展示型小组件：
 *   - Mounted：Agent 卡片上的「已挂载资产」计数 chip
 *   - LightField：轻量表单字段（label + hint + children）
 *   - CollapseGroup：可折叠分组（skills / code_graph / llm_wiki / chat_memory 复选列表容器）
 *   - AssetCheckList：分组渲染的资产复选框列表
 *
 * 均为纯展示组件，不含业务逻辑 / 数据请求。
 */

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from 'tea-component';
import { ChevronRightIcon } from 'tea-icons-react';
import type { MountableAsset } from './types';

export function Mounted({ label, count, loading = false }: { label: string; count: number; loading?: boolean }) {
  // counts 还在加载时，单独把数字区换成骨架占位，不动 label。
  // 让 agent 卡片主体立刻可见（避免「4 骨架 → 1 真实卡」的突兀跳变），
  // 只把不确定的计数数据占位起来，比整个网格保留骨架更平滑。
  return (
    <div className={`_memory-mounted-chip${loading ? ' _memory-mounted-chip--loading' : ''}`}>
      <span className="_memory-mounted-chip-label">{label}</span>
      {loading ? (
        <span className="_memory-mounted-chip-count _memory-mounted-chip-count--loading" aria-label="loading" />
      ) : (
        <span className="_memory-mounted-chip-count">{count}</span>
      )}
    </div>
  );
}

export function LightField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="_memory-light-field">
      <div className="_memory-light-field-label">{label}</div>
      {hint && <div className="_memory-light-field-hint">{hint}</div>}
      {children}
    </label>
  );
}

export function CollapseGroup({
  icon,
  title,
  selectedCount,
  totalCount,
  open,
  onToggle,
  hideTotal = false,
  loading = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  selectedCount: number;
  totalCount: number;
  open: boolean;
  onToggle: () => void;
  /** 只展示已绑定数量、不展示团队池总数（用于只读详情场景）。 */
  hideTotal?: boolean;
  /**
   * 加载态：count 数字区换成骨架占位（保留 label/title 等结构，避免布局抖动）。
   * 用于详情弹窗打开时资产绑定还没拉完的场景，避免「已选 0/共 0 → 真实数字」的突兀跳变。
   */
  loading?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`_memory-collapse-group${loading ? ' _memory-collapse-group--loading' : ''}`}>
      <button type="button" onClick={onToggle} className="_memory-collapse-group-header" disabled={loading}>
        <ChevronRightIcon
          size={12}
          className={`_memory-collapse-group-chevron${open ? ' _memory-collapse-group-chevron--open' : ''}`}
        />
        <span className="_memory-collapse-group-icon">{icon}</span>
        <span className="_memory-collapse-group-title">{title}</span>
        {loading ? (
          // 加载中：保留图标 + 标题，仅把 count 区换成骨架；按钮禁用防止「加载中点开」出现空面板
          <span className="_memory-collapse-group-count _memory-collapse-group-count--loading" aria-label="loading" />
        ) : (
          <span className="_memory-collapse-group-count">
            {hideTotal ? t('shared.bound', { count: selectedCount }) : t('shared.selected', { selected: selectedCount, total: totalCount })}
          </span>
        )}
      </button>
      {open && !loading && <div className="_memory-collapse-group-body">{children}</div>}
    </div>
  );
}

export function AssetCheckList({
  assets,
  checkedKeys,
  onToggle,
  readOnly = false,
  disabledKeys = new Set<string>(),
}: {
  assets: MountableAsset[];
  checkedKeys: string[];
  onToggle: (key: string) => void;
  readOnly?: boolean;
  disabledKeys?: Set<string>;
}) {
  const { t } = useTranslation();
  const groups = new Map<string, MountableAsset[]>();
  for (const a of assets) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group)!.push(a);
  }
  return (
    <div className="_memory-asset-check-groups">
      {Array.from(groups.entries()).map(([group, items]) => (
        <div key={group}>
          <div className="_memory-asset-check-group-label">{group}</div>
          <ul className="_memory-asset-check-list">
            {items.map((a) => {
              const checked = checkedKeys.includes(a.key);
              const notReady = a.status && a.status !== 'ready';
              const disabled = readOnly || disabledKeys.has(a.key) || !!notReady;
              return (
                <li key={a.key} className="_memory-asset-check-item">
                  <Checkbox value={checked} disabled={disabled} onChange={() => { if (!disabled) onToggle(a.key); }}>
                    <span className="_memory-asset-check-item-row">
                      <span className="_memory-asset-check-item-title">{a.title}</span>
                      <span className="_memory-asset-check-item-slug">
                        {a.slug}{disabledKeys.has(a.key) ? t('shared.selfMemory') : notReady ? ` · ${a.status}` : ''}
                      </span>
                    </span>
                  </Checkbox>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
