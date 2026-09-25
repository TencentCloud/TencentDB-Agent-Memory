/**
 * UsagePanel — 成本视角面板（成本 Tab 的内容）。
 *
 * 区块：KPI → token 趋势 → credit 趋势 → 模型分布 → 计费异常上报。
 *
 * token 与 credit **分成两张趋势图**：token 量级常达千万、credit 仅数百，
 * 同图归一化会把 credit 线压到贴底看不出变化。TrendLines 按各自最大值归一，
 * 分图后每张图内量级相近。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Card } from 'tea-component';
import type { UsageRawReason } from '@/lib/api/analytics';
import { TrendLines } from './TrendLines';
import { UsageKpiRow } from './UsageKpiRow';
import { ModelTable } from './ModelTable';
import { UsageRawTable } from './UsageRawTable';
import type { useUsageStats } from '../hooks/useUsageStats';

type UsageStats = ReturnType<typeof useUsageStats>;

export function UsagePanel({
  usage,
  expandedRawKeys,
  resolveUserName,
  onExpandedRawKeysChange,
  onDrillModel,
  onDrillMember,
}: {
  usage: UsageStats;
  expandedRawKeys: string[];
  resolveUserName: (id: string) => string;
  onExpandedRawKeysChange: (keys: string[]) => void;
  onDrillModel: (modelId: string, modelName: string) => void;
  onDrillMember: (userId: string) => void;
}) {
  const { t } = useTranslation();

  const tokenLines = useMemo(
    () => [
      {
        key: 'prompt_tokens' as const,
        label: t('analytics.usage.trend.prompt'),
        color: 'var(--tea-color-text-brand-default)',
      },
      {
        key: 'completion_tokens' as const,
        label: t('analytics.usage.trend.completion'),
        color: 'var(--tea-color-text-success-default)',
      },
      {
        key: 'cache_hit_tokens' as const,
        label: t('analytics.usage.trend.cacheHit'),
        color: 'var(--tea-color-text-warning-default)',
      },
    ],
    [t],
  );

  const creditLines = useMemo(
    () => [
      {
        key: 'credit' as const,
        label: t('analytics.usage.trend.credit'),
        color: 'var(--tea-color-text-brand-default)',
      },
      {
        key: 'credit_saved' as const,
        label: t('analytics.usage.trend.creditSaved'),
        color: 'var(--tea-color-text-success-default)',
      },
    ],
    [t],
  );

  return (
    <>
      {usage.error && <Alert type="error">{usage.error}</Alert>}

      <Card bordered>
        <Card.Body>
          <UsageKpiRow summary={usage.summary} />
        </Card.Body>
      </Card>

      <Card bordered>
        <Card.Body title={t('analytics.usage.section.tokenTrend')}>
          <TrendLines
            rows={usage.series}
            lines={tokenLines}
            emptyText={t('analytics.usage.empty.trend')}
            maxLabel={(max) => t('analytics.trend.max', { value: max })}
            singlePointHint={t('analytics.trend.singlePoint')}
          />
        </Card.Body>
      </Card>

      <Card bordered>
        <Card.Body
          title={t('analytics.usage.section.creditTrend')}
          subtitle={t('analytics.usage.section.creditTrendSub')}
        >
          <TrendLines
            rows={usage.series}
            lines={creditLines}
            emptyText={t('analytics.usage.empty.trend')}
            maxLabel={(max) => t('analytics.trend.max', { value: max })}
            singlePointHint={t('analytics.trend.singlePoint')}
          />
        </Card.Body>
      </Card>

      <ModelTable models={usage.models} loading={usage.loading} onDrill={onDrillModel} />

      <UsageRawTable
        rows={usage.rawRows}
        total={usage.rawTotal}
        offset={usage.rawOffset}
        limit={usage.rawLimit}
        reason={usage.rawReason as UsageRawReason | ''}
        reasonCounts={usage.reasonCounts}
        loading={usage.rawLoading}
        expandedKeys={expandedRawKeys}
        resolveUserName={resolveUserName}
        onExpandedKeysChange={onExpandedRawKeysChange}
        onReasonChange={usage.setRawReason}
        onOffsetChange={usage.setRawOffset}
        onDrillMember={onDrillMember}
      />
    </>
  );
}
