/**
 * UsageDetailList — 抽屉内的用量明细列表（usage/list）。
 *
 * 每行是一次模型请求的计费快照：token 构成、credit、是否流式、是否由其他模型
 * 路由而来。按成员下钻时隐藏成员列、按模型下钻时隐藏模型列（恒为同一值）。
 */
import { useTranslation } from 'react-i18next';
import { Alert, Table, Text } from 'tea-component';
import type { UsageLogRow } from '@/lib/api/analytics';
import { DetailPager } from './DetailPager';
import { UserName } from './UserName';
import { fmtCompact, fmtCredit } from '../utils/formatters';

const { autotip } = Table.addons;

export function UsageDetailList({
  rows,
  total,
  offset,
  limit,
  loading,
  error,
  resolveUserName,
  showUser,
  showModel,
  onOffsetChange,
}: {
  rows: UsageLogRow[];
  total: number;
  offset: number;
  limit: number;
  loading: boolean;
  error: string;
  resolveUserName: (id: string) => string;
  showUser: boolean;
  showModel: boolean;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation();

  const recordKey = (r: UsageLogRow) => `${r.session_key}:${r.turn_seq}:${r.timestamp}`;

  const columns = [
    {
      key: 'timestamp',
      header: t('analytics.trace.col.time'),
      width: 165,
      render: (r: UsageLogRow) => (
        <Text className="_an-mono" overflow>
          {r.timestamp}
        </Text>
      ),
    },
    ...(showUser
      ? [
          {
            key: 'user_id',
            header: t('analytics.trace.col.user'),
            width: 130,
            render: (r: UsageLogRow) =>
              r.user_id ? (
                <UserName userId={r.user_id} displayName={resolveUserName(r.user_id)} />
              ) : (
                '—'
              ),
          },
        ]
      : []),
    ...(showModel
      ? [
          {
            key: 'model_name',
            header: t('analytics.usage.model.col.model'),
            width: 160,
            render: (r: UsageLogRow) => (
              <Text className="_an-mono" overflow tooltip={r.model_id}>
                {r.model_name || r.model_id || '—'}
              </Text>
            ),
          },
        ]
      : []),
    {
      key: 'prompt_tokens',
      header: t('analytics.usage.kpi.prompt'),
      width: 90,
      align: 'right' as const,
      render: (r: UsageLogRow) => fmtCompact(r.prompt_tokens),
    },
    {
      key: 'completion_tokens',
      header: t('analytics.usage.kpi.completion'),
      width: 90,
      align: 'right' as const,
      render: (r: UsageLogRow) => fmtCompact(r.completion_tokens),
    },
    {
      key: 'cache_hit_tokens',
      header: t('analytics.usage.kpi.cacheTokens'),
      width: 100,
      align: 'right' as const,
      render: (r: UsageLogRow) => fmtCompact(r.cache_hit_tokens),
    },
    {
      key: 'credit',
      header: t('analytics.usage.model.col.credit'),
      width: 100,
      align: 'right' as const,
      render: (r: UsageLogRow) => fmtCredit(r.credit),
    },
    {
      key: 'flags',
      header: t('analytics.usage.detail.col.flags'),
      width: 130,
      render: (r: UsageLogRow) => (
        <span className="_an-flag-cell">
          {r.stream && <Text theme="label">{t('analytics.usage.detail.stream')}</Text>}
          {r.routed_from && (
            <Text theme="warning" overflow tooltip={t('analytics.usage.detail.routedFrom', { model: r.routed_from })}>
              {t('analytics.usage.detail.routed')}
            </Text>
          )}
          {!r.stream && !r.routed_from && '—'}
        </span>
      ),
    },
  ];

  return (
    <>
      {error && <Alert type="error">{error}</Alert>}
      <Table
        records={rows}
        recordKey={recordKey}
        columns={columns}
        verticalTop
        bordered
        addons={[autotip({ isLoading: loading, emptyText: t('analytics.usage.empty.detail') })]}
      />
      <DetailPager
        total={total}
        offset={offset}
        limit={limit}
        count={rows.length}
        loading={loading}
        onOffsetChange={onOffsetChange}
      />
    </>
  );
}
