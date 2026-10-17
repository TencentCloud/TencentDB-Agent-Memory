/**
 * KpiRow — 5 张核心指标卡（渗透率 / 场均调用 / bypass 率 / 独立 Session / 总调用）。
 *
 * 复用 Tea 的 MetricsBoard（与 WikiSourcesPanel、wiki-detail-view 同一惯例）：
 * 标题 / 数值 / 单位 / infos 补充行均由组件语义属性承载，不自绘字号与排版。
 * 环比通过 infos 承载 DeltaBadge。
 */
import { useTranslation } from 'react-i18next';
import { MetricsBoard } from 'tea-component';
import type { SessionInitSummary } from '@/lib/api/analytics';
import { DeltaBadge } from './DeltaBadge';
import { fmtInt, fmtNum, fmtPctValue } from '../utils/formatters';

export function KpiRow({ summary }: { summary: SessionInitSummary | null }) {
  const { t } = useTranslation();

  return (
    <div className="_an-kpi-row">
      <MetricsBoard
        title={t('analytics.kpi.rate')}
        value={fmtPctValue(summary?.tool_call_rate.current_pct)}
        unit="%"
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.vsPrev')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>
              <DeltaBadge value={summary?.tool_call_rate.delta_pp} unit="pp" />
            </MetricsBoard.InfoKey>
          </>,
        ]}
      />
      <MetricsBoard
        title={t('analytics.kpi.avg')}
        value={fmtNum(summary?.avg_calls.current_avg)}
        unit={t('analytics.unit.times')}
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.vsPrev')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>
              <DeltaBadge value={summary?.avg_calls.delta} unit="" />
            </MetricsBoard.InfoKey>
          </>,
          <>{t('analytics.perInitSession')}</>,
        ]}
      />
      <MetricsBoard
        title={t('analytics.kpi.bypass')}
        value={fmtPctValue(summary?.bypass_rate.current_pct)}
        unit="%"
        infos={[
          <>
            <MetricsBoard.InfoLabel>{t('analytics.vsPrev')}</MetricsBoard.InfoLabel>
            <MetricsBoard.InfoKey>
              <DeltaBadge value={summary?.bypass_rate.delta_pp} unit="pp" />
            </MetricsBoard.InfoKey>
          </>,
          <>
            {t('analytics.bypassSub', {
              bypass: fmtInt(summary?.bypass_rate.bypass_sessions),
              normal: fmtInt(summary?.bypass_rate.non_bypass_sessions),
            })}
          </>,
        ]}
      />
      <MetricsBoard
        title={t('analytics.kpi.sessions')}
        value={fmtInt(summary?.distinct_init_sessions)}
        infos={[<>{t('analytics.initSessionsSub')}</>]}
      />
      <MetricsBoard
        title={t('analytics.kpi.total')}
        value={fmtInt(summary?.total_bridge_calls)}
        infos={[<>{t('analytics.totalCallsSub')}</>]}
      />
    </div>
  );
}
