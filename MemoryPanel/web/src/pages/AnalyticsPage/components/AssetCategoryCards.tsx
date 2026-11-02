/**
 * AssetCategoryCards — 四类资产调用分布（Memory / Skill / Wiki / Code Graph）。
 *
 * 数据来自内核 `tool-calls/endpoint-share`（SQL 全量聚合），面板侧只做端点→类别
 * 归并，因此 calls / pct 是**全量准确值**，不是抽样。
 *
 * 点击卡片直接呼出下钻抽屉查看该类资产的调用明细（不再改动页面主体状态，
 * 避免「点了却要滚动到下方找结果」）。
 */
import { useTranslation } from 'react-i18next';
import { Card, StatusTip, Text, Tooltip } from 'tea-component';
import type { AssetCategory, CategoryStat } from '../utils/asset-category';
import { fmtInt, fmtPct } from '../utils/formatters';

/** 类别 → i18n key 后缀与主题色（沿用 Tea 语义色 Token）。 */
const CATEGORY_META: Record<AssetCategory, { i18nKey: string; color: string }> = {
  memory: { i18nKey: 'memory', color: 'var(--tea-color-text-brand-default)' },
  skill: { i18nKey: 'skill', color: 'var(--tea-color-text-success-default)' },
  wiki: { i18nKey: 'wiki', color: 'var(--tea-color-text-warning-default)' },
  codegraph: { i18nKey: 'codegraph', color: 'var(--tea-color-text-secondary)' },
  other: { i18nKey: 'other', color: 'var(--tea-color-text-tertiary)' },
};

export function AssetCategoryCards({
  stats,
  onDrill,
}: {
  stats: CategoryStat[];
  onDrill: (category: AssetCategory) => void;
}) {
  const { t } = useTranslation();

  if (stats.length === 0) {
    return <StatusTip status="empty" emptyText={t('analytics.empty.bridge')} />;
  }

  const max = Math.max(...stats.map((s) => s.pct), 1);

  return (
    <div className="_an-cat-grid">
      {stats.map((stat) => {
        const meta = CATEGORY_META[stat.category];
        // 归类依据：展示落入该类的原始端点，便于核对归并是否符合预期
        const tip =
          stat.endpoints.length > 0
            ? stat.endpoints.map((e) => `${e.endpoint} (${e.calls})`).join('\n')
            : t('analytics.category.noEndpoint');

        return (
          <Tooltip key={stat.category} title={tip} placement="top">
            <button
              type="button"
              className="_an-cat-card"
              onClick={() => onDrill(stat.category)}
            >
              <span className="_an-cat-badge" style={{ background: meta.color }}>
                {t(`analytics.category.${meta.i18nKey}`)}
              </span>
              <span className="_an-cat-value">{fmtInt(stat.calls)}</span>
              <span className="_an-cat-track">
                <span
                  className="_an-cat-fill"
                  style={{ width: `${(stat.pct / max) * 100}%`, background: meta.color }}
                />
              </span>
              <span className="_an-cat-meta">
                <Text theme="label">{t('analytics.category.calls')}</Text>
                <Text theme="label">{fmtPct(stat.pct)}</Text>
              </span>
              <Text theme="label" className="_an-cat-desc">
                {t(`analytics.category.${meta.i18nKey}.desc`)}
              </Text>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** 类别 → 内核 bridge_source 过滤值（用于下钻 trace 明细）。 */
export function categoryToBridgeSource(category: AssetCategory): string | undefined {
  if (category === 'memory') return 'memory-bridge';
  if (category === 'skill') return 'skill-bridge';
  // wiki / codegraph 同属 knowledge-service，无法只靠 bridge_source 区分，
  // 由调用方改用端点关键字过滤。
  if (category === 'wiki' || category === 'codegraph') return 'knowledge-service';
  return undefined;
}

export { CATEGORY_META };

/** Card 容器包装（供页面直接使用，保持 Card.Body 语义一致）。 */
export function AssetCategorySection({
  stats,
  onDrill,
}: {
  stats: CategoryStat[];
  onDrill: (category: AssetCategory) => void;
}) {
  const { t } = useTranslation();
  return (
    <Card bordered>
      <Card.Body
        title={t('analytics.section.assetCategory')}
        subtitle={t('analytics.section.assetCategorySub')}
      >
        <AssetCategoryCards stats={stats} onDrill={onDrill} />
      </Card.Body>
    </Card>
  );
}
