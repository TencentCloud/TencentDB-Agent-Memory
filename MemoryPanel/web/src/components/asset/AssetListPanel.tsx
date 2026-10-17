/**
 * AssetListPanel — 资产管理页通用左侧列表面板。
 *
 * 统一 Skills / Memory 等资产页的左侧导航列表容器，提供：
 *   - 面板标题 + 条数统计
 *   - 加载骨架屏
 *   - 空态提示
 *   - 选中态管理（浅品牌底色，无边框）
 *   - 统一的列表项 4 行结构（标题 / 描述 / 徽章 / 元信息）
 *
 * 列表项内容通过 render prop 由各资产页自行填充，
 * 保持容器与业务解耦。
 */

import type { ReactNode } from 'react';
import './asset-list-panel.css';

/* ── 面板 ── */

interface AssetListPanelProps<T> {
  /** 面板标题 */
  title: ReactNode;
  /** 条数统计文本 */
  count?: ReactNode;
  /** 是否加载中 */
  loading?: boolean;
  /** 数据项 */
  items: T[];
  /** 当前选中项 id */
  selectedId?: string | null;
  /** 从数据项提取唯一 id */
  getItemId: (item: T) => string;
  /** 选中回调 */
  onSelect: (item: T) => void;
  /** 渲染单个列表项内容（不含外层选中态容器） */
  renderItem: (item: T, isSelected: boolean) => ReactNode;
  /** 判断某项是否禁用（不可点击） */
  isItemDisabled?: (item: T) => boolean;
  /** 空态文本 */
  emptyText?: ReactNode;
}

export function AssetListPanel<T>({
  title,
  count,
  loading,
  items,
  selectedId,
  getItemId,
  onSelect,
  renderItem,
  isItemDisabled,
  emptyText,
}: AssetListPanelProps<T>) {
  return (
    <div className="_alp">
      <div className="_alp-header">
        <span className="_alp-title">{title}</span>
        {!loading && count != null && <span className="_alp-count">{count}</span>}
      </div>

      {loading ? (
        <div className="_alp-items">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="_alp-item _alp-skeleton">
              <div className="_alp-skeleton-line _alp-skeleton-primary" />
              <div className="_alp-skeleton-line _alp-skeleton-secondary" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="_alp-empty">{emptyText}</div>
      ) : (
        <ul className="_alp-items">
          {items.map((item) => {
            const id = getItemId(item);
            const isSelected = selectedId === id;
            const disabled = isItemDisabled?.(item) ?? false;
            return (
              <li
                key={id}
                className={[
                  '_alp-item',
                  isSelected ? '_alp-item--selected' : '',
                  disabled ? '_alp-item--disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  type="button"
                  className="_alp-item-btn"
                  onClick={() => !disabled && onSelect(item)}
                  disabled={disabled}
                >
                  {renderItem(item, isSelected)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── 列表项内容区 — 标准化 4 行结构 ── */

/** 标题行：主标识 + 可选操作按钮 */
export function AssetItemHeader({ children }: { children: ReactNode }) {
  return <div className="_alp-item-header">{children}</div>;
}

/** 名称 / 标题文本 */
export function AssetItemName({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="_alp-item-name" title={title}>
      {children}
    </span>
  );
}

/** 资产真实 id —— 弱化展示，附在名称旁，便于识别 ID 化命名的资产（name + id 组合） */
export function AssetItemId({ children }: { children: ReactNode }) {
  return (
    <span className="_alp-item-id" title={typeof children === 'string' ? children : undefined}>
      {children}
    </span>
  );
}

/** 描述文本（2 行截断） */
export function AssetItemDesc({ children }: { children: ReactNode }) {
  return <p className="_alp-item-desc">{children}</p>;
}

/** 徽章行容器 */
export function AssetItemBadges({ children }: { children: ReactNode }) {
  return <div className="_alp-item-badges">{children}</div>;
}

/** 纯文本徽章 — 替代亮色 Tag */
export function AssetBadge({
  icon,
  children,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="_alp-badge" title={title}>
      {icon}
      {children}
    </span>
  );
}

/** "含你"/"你" 标识 — 品牌色纯文本 */
export function AssetBadgeYou({ children }: { children: ReactNode }) {
  return <span className="_alp-badge-you">{children}</span>;
}

/** 元信息行容器 */
export function AssetItemMeta({ children }: { children: ReactNode }) {
  return <div className="_alp-item-meta">{children}</div>;
}

/** 元信息右侧时间 */
export function AssetItemTime({ children }: { children: ReactNode }) {
  return <span className="_alp-item-time">{children}</span>;
}
