/**
 * AssetListSearch —— 资产列表通用关键词搜索框。
 *
 * 基于 tea SearchBox：自带清空按钮，按 Esc 也会清空（SearchBox 内置行为）。
 * 只负责输入，过滤逻辑见 `@/lib/asset-filter`（本地过滤，不发请求）。
 */
import { useTranslation } from 'react-i18next';
import { SearchBox } from 'tea-component';
import './asset-list-panel.css';

interface AssetListSearchProps {
  value: string;
  onChange: (value: string) => void;
  /** 占位文案；缺省用通用文案 */
  placeholder?: string;
  /** 无障碍标签；缺省用通用文案 */
  ariaLabel?: string;
  /** 撑满容器宽度（列表面板内使用） */
  full?: boolean;
}

export function AssetListSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
  full,
}: AssetListSearchProps) {
  const { t } = useTranslation();
  return (
    <div className={full ? '_alp-search _alp-search--full' : '_alp-search'}>
      <SearchBox
        size={full ? 'full' : undefined}
        value={value}
        onChange={(v) => onChange(v)}
        onClear={() => onChange('')}
        placeholder={placeholder ?? t('asset.search.placeholder')}
        aria-label={ariaLabel ?? t('asset.search.ariaLabel')}
      />
    </div>
  );
}
