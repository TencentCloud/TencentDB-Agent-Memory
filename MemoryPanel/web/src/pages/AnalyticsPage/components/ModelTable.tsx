/**
 * ModelTable — 按模型的用量与成本分布（usage/by-model）。
 *
 * 内核已按 credit 降序返回，占比列由 SQL 计算（分母为 0 时为 null → 显示占位符）。
 * `routed_to_count` 表示「由其他模型路由到该模型」的请求数，可用于观察降级/兜底路由。
 */
import { useTranslation } from 'react-i18next';
import { Button, Card, Table, Text } from 'tea-component';
import type { UsageModelRow } from '@/lib/api/analytics';
import { fmtCompact, fmtCredit, fmtInt, fmtPct } from '../utils/formatters';

const { autotip } = Table.addons;

export function ModelTable({
  models,
  loading,
  onDrill,
}: {
  models: UsageModelRow[];
  loading: boolean;
  onDrill: (modelId: string, modelName: string) => void;
}) {
  const { t } = useTranslation();

  // 以最大 credit 占比为满格基准，给出直观的成本分布条
  const maxCreditPct = Math.max(...models.map((m) => m.pct_credit ?? 0), 1);

  const columns = [
    {
      key: 'model_name',
      header: t('analytics.usage.model.col.model'),
      render: (r: UsageModelRow) => (
        <div className="_an-model-cell">
          <Text overflow>{r.model_name || r.model_id || '—'}</Text>
          {r.model_name && r.model_id && r.model_name !== r.model_id && (
            <Text theme="label" className="_an-mono" overflow>
              {r.model_id}
            </Text>
          )}
        </div>
      ),
    },
    {
      key: 'requests',
      header: t('analytics.usage.model.col.requests'),
      width: 110,
      align: 'right' as const,
      render: (r: UsageModelRow) => fmtInt(r.requests),
    },
    {
      key: 'pct_requests',
      header: t('analytics.usage.model.col.pctRequests'),
      width: 100,
      align: 'right' as const,
      render: (r: UsageModelRow) => fmtPct(r.pct_requests),
    },
    {
      key: 'total_tokens',
      header: t('analytics.usage.model.col.tokens'),
      width: 110,
      align: 'right' as const,
      render: (r: UsageModelRow) => fmtCompact(r.total_tokens),
    },
    {
      key: 'credit',
      header: t('analytics.usage.model.col.credit'),
      width: 120,
      align: 'right' as const,
      render: (r: UsageModelRow) => fmtCredit(r.credit),
    },
    {
      key: 'pct_credit',
      header: t('analytics.usage.model.col.pctCredit'),
      width: 160,
      render: (r: UsageModelRow) => (
        <div className="_an-model-bar">
          <span className="_an-cat-track">
            <span
              className="_an-cat-fill"
              style={{
                width: `${((r.pct_credit ?? 0) / maxCreditPct) * 100}%`,
                background: 'var(--tea-color-bg-brand-default)',
              }}
            />
          </span>
          <Text theme="label">{fmtPct(r.pct_credit)}</Text>
        </div>
      ),
    },
    {
      key: 'routed_to_count',
      header: t('analytics.usage.model.col.routed'),
      width: 110,
      align: 'right' as const,
      render: (r: UsageModelRow) =>
        r.routed_to_count > 0 ? fmtInt(r.routed_to_count) : '—',
    },
    {
      key: 'op',
      header: t('analytics.member.col.op'),
      width: 90,
      render: (r: UsageModelRow) => (
        <Button type="link" onClick={() => onDrill(r.model_id, r.model_name)}>
          {t('analytics.drill.open')}
        </Button>
      ),
    },
  ];

  return (
    <Card bordered>
      <Card.Body
        title={t('analytics.usage.section.byModel')}
        subtitle={t('analytics.usage.section.byModelSub')}
      >
        <Table
          records={models}
          recordKey="model_id"
          columns={columns}
          verticalTop
          bordered
          addons={[autotip({ isLoading: loading, emptyText: t('analytics.usage.empty.model') })]}
        />
      </Card.Body>
    </Card>
  );
}
