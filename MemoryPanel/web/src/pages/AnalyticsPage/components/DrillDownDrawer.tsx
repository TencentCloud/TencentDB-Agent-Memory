/**
 * DrillDownDrawer — 统一的下钻抽屉。
 *
 * 取代原先「点卡片/行 → 设置页面级 filter → 滚到下方表格看结果」的交互：
 * 下钻结果直接在抽屉内呈现，不再要求用户滚动定位，也不会改动页面主体状态。
 *
 * 数据加载严格受 visible 约束：抽屉关闭时两个 hook 的 enabled 均为 false，
 * 不会产生后台请求；切 Tab 时也只加载当前视角。
 *
 * wiki / codegraph 同属 knowledge-service，bridge_source 无法区分二者 —— 按这两类
 * 下钻时抽屉会给出提示，说明结果含 knowledge 全部调用（内核过滤维度限制）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Drawer, TabPanel, Tabs, Text } from 'tea-component';
import type { AnalyticsRangeDays } from '@/lib/api/analytics';
import { categoryToBridgeSource } from './AssetCategoryCards';
import { TraceDetailList } from './TraceDetailList';
import { UsageDetailList } from './UsageDetailList';
import { useCallDetail } from '../hooks/useCallDetail';
import { useUsageList } from '../hooks/useUsageList';
import { drillViews, type DrillTarget, type DrillView } from '../utils/drill-target';

export function DrillDownDrawer({
  target,
  days,
  spaceId,
  resolveUserName,
  onClose,
}: {
  target: DrillTarget | null;
  days: AnalyticsRangeDays;
  spaceId: string;
  resolveUserName: (id: string) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const visible = target !== null;

  const views = useMemo<DrillView[]>(() => (target ? drillViews(target) : ['trace']), [target]);
  const [view, setView] = useState<DrillView>(views[0]);

  // 切换下钻对象时重置到该对象的默认视角（上一个对象的视角可能不适用）
  useEffect(() => {
    setView(views[0]);
  }, [views]);

  const userId = target?.type === 'member' ? target.userId : undefined;
  const modelId = target?.type === 'model' ? target.modelId : undefined;
  const bridgeSource =
    target?.type === 'category' ? categoryToBridgeSource(target.category) : undefined;

  const trace = useCallDetail({
    enabled: visible && view === 'trace',
    days,
    spaceId,
    userId: userId ?? null,
    bridgeSource,
    endpointFilter: '',
  });

  const usage = useUsageList({
    enabled: visible && view === 'usage',
    days,
    spaceId,
    userId,
    modelId,
  });

  const title = useMemo(() => {
    if (!target) return '';
    switch (target.type) {
      case 'member':
        return resolveUserName(target.userId);
      case 'category':
        return t(`analytics.category.${target.category}`);
      case 'model':
        return target.modelName || target.modelId;
    }
  }, [target, resolveUserName, t]);

  const subtitle = useMemo(() => {
    if (!target) return null;
    const raw =
      target.type === 'member'
        ? target.userId
        : target.type === 'model'
          ? target.modelId
          : t('analytics.drill.categoryHint');
    return (
      <span className="_an-drill-subtitle">
        <span className="_an-mono">{raw}</span>
        <Text theme="label">{t('analytics.range', { days })}</Text>
      </span>
    );
  }, [target, days, t]);

  const tabs = views.map((v) => ({ id: v, label: t(`analytics.drill.view.${v}`) }));

  // knowledge-service 下 wiki / codegraph 共用 bridge_source，结果无法只含单一类别
  const knowledgeAmbiguous =
    target?.type === 'category' && (target.category === 'wiki' || target.category === 'codegraph');

  const renderView = (v: DrillView) => {
    if (!target) return null;
    return v === 'trace' ? (
      <TraceDetailList
        rows={trace.rows}
        total={trace.total}
        offset={trace.offset}
        limit={trace.limit}
        loading={trace.loading}
        error={trace.error}
        resolveUserName={resolveUserName}
        showUser={target.type !== 'member'}
        onOffsetChange={trace.setOffset}
      />
    ) : (
      <UsageDetailList
        rows={usage.rows}
        total={usage.total}
        offset={usage.offset}
        limit={usage.limit}
        loading={usage.loading}
        error={usage.error}
        resolveUserName={resolveUserName}
        showUser={target.type !== 'member'}
        showModel={target.type !== 'model'}
        onOffsetChange={usage.setOffset}
      />
    );
  };

  return (
    <Drawer
      visible={visible}
      size="l"
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      destroyOnClose
      showMask
    >
      {target && (
        <div className="_an-drill-body">
          {knowledgeAmbiguous && (
            <Alert type="info">{t('analytics.drill.knowledgeAmbiguous')}</Alert>
          )}

          {views.length > 1 ? (
            <Tabs tabs={tabs} activeId={view} onActive={(tab) => setView(tab.id as DrillView)}>
              {views.map((v) => (
                <TabPanel id={v} key={v}>
                  <div className="_an-drill-tab-body">{renderView(v)}</div>
                </TabPanel>
              ))}
            </Tabs>
          ) : (
            renderView(view)
          )}
        </div>
      )}
    </Drawer>
  );
}
