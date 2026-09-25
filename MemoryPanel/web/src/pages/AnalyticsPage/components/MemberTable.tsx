/**
 * MemberTable — 成员维度调用统计表。
 *
 * ⚠️ 抽样口径：数据由面板侧对 `tool-calls/list` 分页采样后聚合（内核无按成员
 * 聚合的展示接口，本期不改 Core）。当 truncated=true 时表头会明示
 * 「基于最近 N / total 条」，避免被误读为全量。
 *
 * 成员列以两行展示：主行用户名（`user/list` 批量解析，解析失败/内部账号被过滤
 * 时展示「未识别用户」占位），副行固定展示原始 user_id，便于识别与复制。
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Table, Text, Tooltip } from 'tea-component';
import type { MemberStat } from '../utils/member-stats';
import { UNASSIGNED_USER } from '../utils/member-stats';
import type { AssetCategory } from '../utils/asset-category';
import { CATEGORY_META } from './AssetCategoryCards';
import { UserName } from './UserName';
import { fmtInt } from '../utils/formatters';

const { autotip } = Table.addons;

/** 成员维度资产使用次数展示顺序（other 归到最后）。 */
const ASSET_COLUMN_ORDER: readonly AssetCategory[] = ['memory', 'skill', 'wiki', 'codegraph', 'other'];

export function MemberTable({
  members,
  sampled,
  total,
  truncated,
  loading,
  resolveUserName,
  onDrill,
}: {
  members: MemberStat[];
  sampled: number;
  total: number;
  truncated: boolean;
  loading: boolean;
  resolveUserName: (id: string) => string;
  onDrill: (userId: string) => void;
}) {
  const { t } = useTranslation();

  const columns = [
    {
      key: 'user_id',
      header: t('analytics.member.col.user'),
      width: 200,
      render: (r: MemberStat) => {
        // 未归属桶不是真实用户：直接展示占位文案，不做名称解析
        if (r.user_id === UNASSIGNED_USER) {
          return <Text theme="label">{t('analytics.member.unassigned')}</Text>;
        }
        // 未解析时主行渲染「未识别用户」（不再把裸 user_id 当可读名），
        // 副行统一展示 user_id，保持整列两行版式一致。
        return (
          <div className="_an-user-cell">
            <UserName userId={r.user_id} displayName={resolveUserName(r.user_id)} />
            <Text theme="label" className="_an-mono _an-user-id" overflow>
              {r.user_id}
            </Text>
          </div>
        );
      },
    },
    {
      key: 'calls',
      header: t('analytics.member.col.calls'),
      width: 90,
      align: 'right' as const,
      render: (r: MemberStat) => fmtInt(r.calls),
    },
    {
      key: 'sessions',
      header: t('analytics.member.col.sessions'),
      width: 90,
      align: 'right' as const,
      render: (r: MemberStat) => fmtInt(r.sessions),
    },
    {
      key: 'topCategory',
      header: t('analytics.member.col.topCategory'),
      width: 260,
      render: (r: MemberStat) => {
        // 该成员使用过的资产类别（按固定顺序取前几类）——补全「分别使用次数」，
        // 不再只显示单一 top 类别徽章。
        const used = ASSET_COLUMN_ORDER.filter((c) => r.byCategory[c] > 0);
        if (used.length === 0) return '—';
        // Tooltip 用逐行 ReactNode（纯文本 \n 在 HTML 中不换行）
        const tip = (
          <div>
            {used.map((c) => (
              <div key={c}>
                {t(`analytics.category.${CATEGORY_META[c].i18nKey}`)}: {fmtInt(r.byCategory[c])}
              </div>
            ))}
          </div>
        );
        return (
          <Tooltip title={tip} placement="top">
            <div className="_an-member-assets">
              {used.map((c) => (
                <span key={c} className="_an-asset-chip">
                  <i style={{ background: CATEGORY_META[c].color }} />
                  {t(`analytics.category.${CATEGORY_META[c].i18nKey}`)}
                  <em>{fmtInt(r.byCategory[c])}</em>
                </span>
              ))}
            </div>
          </Tooltip>
        );
      },
    },
    {
      key: 'avgElapsedMs',
      header: t('analytics.member.col.avgElapsed'),
      width: 110,
      align: 'right' as const,
      render: (r: MemberStat) => (r.avgElapsedMs > 0 ? `${fmtInt(r.avgElapsedMs)}ms` : '—'),
    },
    {
      key: 'errors',
      header: t('analytics.member.col.errors'),
      width: 90,
      align: 'right' as const,
      render: (r: MemberStat) =>
        r.errors > 0 ? <Text theme="danger">{fmtInt(r.errors)}</Text> : '0',
    },
    {
      key: 'lastCallAt',
      header: t('analytics.member.col.lastCall'),
      width: 170,
      render: (r: MemberStat) => (
        <Text className="_an-mono" overflow>
          {r.lastCallAt || '—'}
        </Text>
      ),
    },
    {
      key: 'op',
      header: t('analytics.member.col.op'),
      width: 90,
      render: (r: MemberStat) =>
        // 未归属桶无法作为 user_id 过滤条件，不提供下钻入口
        r.user_id === UNASSIGNED_USER ? (
          '—'
        ) : (
          <Button type="link" onClick={() => onDrill(r.user_id)}>
            {t('analytics.drill.open')}
          </Button>
        ),
    },
  ];

  return (
    <Card bordered>
      <Card.Body
        title={t('analytics.section.members')}
        subtitle={t('analytics.section.membersSub')}
      >
        {truncated && (
          <Alert type="info">
            {t('analytics.member.sampled', { sampled: fmtInt(sampled), total: fmtInt(total) })}
          </Alert>
        )}
        <Table
          records={members}
          recordKey="user_id"
          columns={columns}
          verticalTop
          bordered
          addons={[
            autotip({
              isLoading: loading,
              emptyText: t('analytics.empty.member'),
            }),
          ]}
        />
      </Card.Body>
    </Card>
  );
}
