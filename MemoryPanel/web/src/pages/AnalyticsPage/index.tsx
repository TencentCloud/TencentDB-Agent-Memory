/**
 * AnalyticsPage — 「可观测」使用看板（仅 system_admin 可见）。
 *
 * 数据源：Panel /api/v1/analytics/* 透明代理 → 内核 /v3/analytics/*（iwiki 4036925405），
 * 内核读 MemoryProxy 侧 ClickHouse（context_proxy）埋点表。本期不含 LLM / Langfuse
 * 效果分析（采用率、对任务结果的作用等需语义判断，SQL 表达不了）。
 *
 * 两个 Tab 对应两种视角，各自懒加载（切到该 Tab 才发请求，避免首屏一次性
 * 打出 10+ 个 CH 查询）：
 *   - 使用情况：session 渗透 / 资产类别 / 成员 / trace 明细（tool_call + session_init 表）
 *   - 成本：token / credit / 模型分布 / 计费留档（usage_logs + usage_raw 表）
 *
 * 下钻交互：成员 / 资产类别 / 模型的下钻统一呼出 DrillDownDrawer，页面主体不再
 * 承接联动过滤（原先"点卡片→改下方表格筛选"需要用户滚动找结果，体验差）。
 *
 * 数据流约束（勿改回「load 内部再探测 config」）：config 只探测一次并归约为
 * chReady 布尔，若在 load 内 setConfig 会与以 config 对象为依赖的 effect 形成
 * 自激励循环（fetch 每次返回新引用），导致无限请求。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Select, Status, TabPanel, Tabs, Text } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useCurrentRole } from '@/services/useCurrentRole';
import { usePanelAnalyticsEnabled } from '@/services/usePanelCapabilities';
import { useAuthStore } from '@/stores/auth';
import type { AnalyticsRangeDays } from '@/lib/api/analytics';
import { BehaviorPanel } from './components/BehaviorPanel';
import { UsagePanel } from './components/UsagePanel';
import { DrillDownDrawer } from './components/DrillDownDrawer';
import { useAnalyticsMetrics } from './hooks/useAnalyticsMetrics';
import { useMemberStats } from './hooks/useMemberStats';
import { useCallDetail } from './hooks/useCallDetail';
import { useUsageStats } from './hooks/useUsageStats';
import { useUserNames } from './hooks/useUserNames';
import { UNASSIGNED_USER } from './utils/member-stats';
import type { AssetCategory } from './utils/asset-category';
import type { DrillTarget } from './utils/drill-target';
import './styles/analytics.css';

const DAYS: AnalyticsRangeDays[] = [1, 7, 30, 90];

type ViewTab = 'behavior' | 'cost';

export function AnalyticsPage() {
  const { t } = useTranslation();
  const isAdmin = useCurrentRole() === 'admin';

  const [tab, setTab] = useState<ViewTab>('behavior');
  const [days, setDays] = useState<AnalyticsRangeDays>(7);
  // 数据面实例隔离：Space 固定为当前登录实例（auth.instance_id = 内核
  // x-tdai-service-id = CH 埋点写入的 space_id），不再提供「全部 Space」
  // 与跨实例切换，避免共享 CH 库中其他实例的数据被聚合展示。
  const [spaceId, setSpaceId] = useState(() => useAuthStore.getState().auth?.instance_id ?? '');
  const [endpointFilter, setEndpointFilter] = useState('');
  const [expandedRawKeys, setExpandedRawKeys] = useState<string[]>([]);
  const [drill, setDrill] = useState<DrillTarget | null>(null);

  // config 探测与 Space 列表两个 Tab 共用，故不受 tab 影响
  const metrics = useAnalyticsMetrics({ enabled: isAdmin, days, spaceId });
  const { chReady } = metrics;

  const behaviorEnabled = isAdmin && chReady && tab === 'behavior';
  const costEnabled = isAdmin && chReady && tab === 'cost';

  const memberStats = useMemberStats({ enabled: behaviorEnabled, days, spaceId });
  const trace = useCallDetail({
    enabled: behaviorEnabled,
    days,
    spaceId,
    userId: null,
    bridgeSource: undefined,
    endpointFilter,
  });
  const usage = useUsageStats({ enabled: costEnabled, days, spaceId });

  // 汇集当前视图内出现的 user_id 做一次批量名称解析（成员表 + trace + 留档表）。
  // 排除 UNASSIGNED_USER：它是空 user_id 的聚合桶标签而非真实用户，送去查询会
  // 白占 user_ids 配额且必然查不到。
  const visibleUserIds = useMemo(
    () =>
      [
        ...memberStats.members.map((m) => m.user_id),
        ...trace.rows.map((r) => r.user_id),
        ...usage.rawRows.map((r) => r.user_id),
        ...(drill?.type === 'member' ? [drill.userId] : []),
      ].filter((id) => id && id !== UNASSIGNED_USER),
    [memberStats.members, trace.rows, usage.rawRows, drill],
  );
  const resolveUserName = useUserNames(visibleUserIds);

  // 面板 env 开关关闭（或获取失败）时整页不可用：菜单已隐藏，这里兜底拦截深链直敲。
  // 注意 hooks 顺序：该判断必须位于所有 hooks 调用之后。
  const analyticsEnabled = usePanelAnalyticsEnabled();
  if (analyticsEnabled === false) {
    return (
      <ResourcePage>
        <Card bordered>
          <Card.Body>
            <Status
              icon="no-permission"
              size="m"
              title={t('analytics.featureDisabled.title')}
              description={t('analytics.featureDisabled.desc')}
            />
          </Card.Body>
        </Card>
      </ResourcePage>
    );
  }

  if (!isAdmin) {
    return (
      <ResourcePage>
        <Card bordered>
          <Card.Body>
            <Status
              icon="no-permission"
              size="m"
              title={t('analytics.noPermission.title')}
              description={t('analytics.noPermission.desc')}
            />
          </Card.Body>
        </Card>
      </ResourcePage>
    );
  }

  const chAlert =
    metrics.chState === 'not-configured'
      ? t('analytics.chNotConfigured')
      : metrics.chState === 'unreachable'
        ? t('analytics.chUnreachable')
        : metrics.chState === 'probe-failed'
          ? t('analytics.chProbeFailed')
          : '';

  const activeUpdatedAt = tab === 'cost' ? usage.updatedAt : metrics.updatedAt;
  const activeLoading = tab === 'cost' ? usage.loading : metrics.loading;

  const refreshAll = () => {
    if (tab === 'cost') {
      usage.reload();
      return;
    }
    void metrics.reload();
    void memberStats.reload();
    void trace.reload();
  };

  const tabs = [
    { id: 'behavior', label: t('analytics.tab.behavior') },
    { id: 'cost', label: t('analytics.tab.cost') },
  ];

  return (
    <ResourcePage>
      <Card bordered>
        <Card.Body title={t('analytics.title')} subtitle={t('analytics.subtitle')}>
          <div className="_an-toolbar">
            <Select
              className="_an-toolbar-select"
              appearance="button"
              value={String(days)}
              onChange={(v) => setDays(Number(v) as AnalyticsRangeDays)}
              options={DAYS.map((d) => ({ value: String(d), text: t('analytics.range', { days: d }) }))}
              listWidth={140}
            />
            <Select
              className="_an-toolbar-select"
              appearance="button"
              value={spaceId}
              onChange={setSpaceId}
              // 仅当前登录实例一项：spaces 列表接口返回的是共享 CH 全量 space_id
              // （含其他实例），不再作为可选项下发到 UI。
              options={[{ value: spaceId, text: spaceId || t('analytics.allSpaces') }]}
              listWidth={260}
            />
            <Button type="weak" onClick={refreshAll} loading={activeLoading} disabled={!chReady}>
              {t('analytics.refresh')}
            </Button>
            <Text theme="label" className="_an-stamp">
              {activeUpdatedAt
                ? t('analytics.updatedAt', { time: activeUpdatedAt.toLocaleTimeString() })
                : t('analytics.notLoaded')}
            </Text>
          </div>

          {metrics.error && <Alert type="error">{metrics.error}</Alert>}
          {chAlert && <Alert type="warning">{chAlert}</Alert>}
        </Card.Body>
      </Card>

      {chReady && (
        <Tabs
          tabs={tabs}
          activeId={tab}
          onActive={(nextTab) => setTab(nextTab.id as ViewTab)}
          className="_an-tabs"
        >
          <TabPanel id="behavior">
            <div className="_an-tab-body">
              <BehaviorPanel
                metrics={metrics}
                memberStats={memberStats}
                trace={trace}
                endpointFilter={endpointFilter}
                resolveUserName={resolveUserName}
                onEndpointFilterChange={setEndpointFilter}
                onDrillCategory={(category: AssetCategory) => setDrill({ type: 'category', category })}
                onDrillMember={(userId) => setDrill({ type: 'member', userId })}
              />
            </div>
          </TabPanel>
          <TabPanel id="cost">
            <div className="_an-tab-body">
              <UsagePanel
                usage={usage}
                expandedRawKeys={expandedRawKeys}
                resolveUserName={resolveUserName}
                onExpandedRawKeysChange={setExpandedRawKeys}
                onDrillModel={(modelId, modelName) => setDrill({ type: 'model', modelId, modelName })}
                onDrillMember={(userId) => setDrill({ type: 'member', userId })}
              />
            </div>
          </TabPanel>
        </Tabs>
      )}

      <DrillDownDrawer
        target={drill}
        days={days}
        spaceId={spaceId}
        resolveUserName={resolveUserName}
        onClose={() => setDrill(null)}
      />
    </ResourcePage>
  );
}
