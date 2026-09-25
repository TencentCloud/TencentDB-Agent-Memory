/**
 * TraceDetailList — 抽屉内的调用明细列表（tool-calls/list）。
 *
 * 与页面主体的 CallDetailTable 区别：无 Card 外壳与搜索栏，专用于下钻场景，
 * 过滤条件由抽屉的下钻目标决定（成员 / 资产类别），不在此处再开放筛选入口。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Table, Text } from 'tea-component';
import type { ToolCallRow } from '@/lib/api/analytics';
import { DetailPager } from './DetailPager';
import { UserName } from './UserName';
import { fmtInt } from '../utils/formatters';

const { autotip, expandable } = Table.addons;

export function TraceDetailList({
  rows,
  total,
  offset,
  limit,
  loading,
  error,
  resolveUserName,
  showUser,
  onOffsetChange,
}: {
  rows: ToolCallRow[];
  total: number;
  offset: number;
  limit: number;
  loading: boolean;
  error: string;
  resolveUserName: (id: string) => string;
  /** 按成员下钻时该列恒为同一人，隐藏以让出横向空间。 */
  showUser: boolean;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  const recordKey = (r: ToolCallRow) => `${r.session_key}:${r.turn_seq}:${r.timestamp}`;

  const columns = [
    {
      key: 'timestamp',
      header: t('analytics.trace.col.time'),
      width: 165,
      render: (r: ToolCallRow) => (
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
            render: (r: ToolCallRow) =>
              r.user_id ? (
                <UserName userId={r.user_id} displayName={resolveUserName(r.user_id)} />
              ) : (
                '—'
              ),
          },
        ]
      : []),
    {
      key: 'initiated_tool',
      header: t('analytics.trace.col.tool'),
      width: 150,
      render: (r: ToolCallRow) => (
        <Text className="_an-mono" overflow>
          {r.initiated_tool || '—'}
        </Text>
      ),
    },
    {
      key: 'executed_endpoint',
      header: t('analytics.trace.col.endpoint'),
      render: (r: ToolCallRow) => (
        <Text className="_an-mono" overflow>
          {r.executed_endpoint || '—'}
        </Text>
      ),
    },
    {
      key: 'upstream_status',
      header: t('analytics.trace.col.status'),
      width: 80,
      align: 'right' as const,
      render: (r: ToolCallRow) => {
        if (r.reject_reason) return <Text theme="danger">{r.reject_reason}</Text>;
        if (r.upstream_status >= 400) return <Text theme="danger">{r.upstream_status}</Text>;
        return r.upstream_status || '—';
      },
    },
    {
      key: 'elapsed_ms',
      header: t('analytics.trace.col.elapsed'),
      width: 90,
      align: 'right' as const,
      render: (r: ToolCallRow) => (r.elapsed_ms > 0 ? `${fmtInt(r.elapsed_ms)}ms` : '—'),
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
        addons={[
          expandable({
            expandedKeys,
            onExpandedKeysChange: setExpandedKeys,
            render: (r: ToolCallRow) => (
              <pre className="_an-trace-body">{r.request_body || t('analytics.trace.emptyBody')}</pre>
            ),
          }),
          autotip({ isLoading: loading, emptyText: t('analytics.empty.trace') }),
        ]}
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
