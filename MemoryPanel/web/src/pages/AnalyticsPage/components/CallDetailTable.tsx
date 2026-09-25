/**
 * CallDetailTable — 工具调用明细（trace 视图）。
 *
 * 数据来自内核 `tool-calls/list`（全量分页，非抽样），支持内核侧四维过滤：
 * kind / user_id / bridge_source / executed_endpoint（后者为 LIKE 模糊匹配）。
 *
 * 这是「指标 + trace」中的 trace 落点：每行对应一次真实调用，可看到发起工具、
 * 实际端点、请求体、上游状态与耗时；点击行展开完整请求体。
 *
 * 表格自身只保留端点关键字搜索；按成员 / 资产类别的下钻已改为抽屉，不再由本表
 * 承接联动过滤（成员列点击即可呼出该成员的下钻抽屉）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input, Justify, Table, Text } from 'tea-component';
import type { ToolCallRow } from '@/lib/api/analytics';
import { DetailPager } from './DetailPager';
import { UserName } from './UserName';
import { fmtInt } from '../utils/formatters';

const { autotip, expandable } = Table.addons;

export function CallDetailTable({
  rows,
  total,
  offset,
  limit,
  loading,
  endpointFilter,
  resolveUserName,
  onEndpointFilterChange,
  onOffsetChange,
  onDrillMember,
}: {
  rows: ToolCallRow[];
  total: number;
  offset: number;
  limit: number;
  loading: boolean;
  endpointFilter: string;
  resolveUserName: (id: string) => string;
  onEndpointFilterChange: (value: string) => void;
  onOffsetChange: (offset: number) => void;
  onDrillMember: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [keyword, setKeyword] = useState(endpointFilter);

  const recordKey = (r: ToolCallRow) => `${r.session_key}:${r.turn_seq}:${r.timestamp}`;

  const columns = [
    {
      key: 'timestamp',
      header: t('analytics.trace.col.time'),
      width: 170,
      render: (r: ToolCallRow) => (
        <Text className="_an-mono" overflow>
          {r.timestamp}
        </Text>
      ),
    },
    {
      key: 'user_id',
      header: t('analytics.trace.col.user'),
      width: 150,
      render: (r: ToolCallRow) =>
        r.user_id ? (
          <Button
            type="link"
            className="_an-user-link"
            tooltip={r.user_id}
            onClick={() => onDrillMember(r.user_id)}
          >
            <UserName userId={r.user_id} displayName={resolveUserName(r.user_id)} />
          </Button>
        ) : (
          '—'
        ),
    },
    {
      key: 'agent_source',
      header: t('analytics.trace.col.agent'),
      width: 110,
      render: (r: ToolCallRow) => r.agent_source || '—',
    },
    {
      key: 'initiated_tool',
      header: t('analytics.trace.col.tool'),
      width: 170,
      render: (r: ToolCallRow) => (
        <Text className="_an-mono" overflow>
          {r.initiated_tool || '—'}
        </Text>
      ),
    },
    {
      key: 'executed_endpoint',
      header: t('analytics.trace.col.endpoint'),
      width: 170,
      render: (r: ToolCallRow) => (
        <Text className="_an-mono" overflow>
          {r.executed_endpoint || '—'}
        </Text>
      ),
    },
    {
      key: 'upstream_status',
      header: t('analytics.trace.col.status'),
      width: 90,
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
      width: 100,
      align: 'right' as const,
      render: (r: ToolCallRow) => (r.elapsed_ms > 0 ? `${fmtInt(r.elapsed_ms)}ms` : '—'),
    },
  ];

  return (
    <Card bordered>
      <Card.Body title={t('analytics.section.trace')} subtitle={t('analytics.section.traceSub')}>
        <Table.ActionPanel>
          <Justify
            left={
              <div className="_an-trace-filters">
                <Input
                  value={keyword}
                  onChange={setKeyword}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onEndpointFilterChange(keyword);
                  }}
                  placeholder={t('analytics.trace.endpointPlaceholder')}
                  size="m"
                />
                <Button type="weak" onClick={() => onEndpointFilterChange(keyword)}>
                  {t('analytics.trace.search')}
                </Button>
                {endpointFilter && (
                  <Button
                    type="link"
                    onClick={() => {
                      setKeyword('');
                      onEndpointFilterChange('');
                    }}
                  >
                    {t('analytics.trace.clearFilters')}
                  </Button>
                )}
              </div>
            }
          />
        </Table.ActionPanel>

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
            autotip({ isLoading: loading, emptyText: t('analytics.empty.bridge') }),
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
      </Card.Body>
    </Card>
  );
}
