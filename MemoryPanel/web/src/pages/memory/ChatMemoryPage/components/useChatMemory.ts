/**
 * useChatMemory —— Chat Memory 页的全部状态与数据逻辑。
 * 组件层只保留 JSX 渲染，状态 / 数据逻辑集中在此。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryBlock, type ChatMemorySearchHit } from '@/lib/teamApi';
import { type MemoryBlock, type MemoryLayer, type ScopeTab } from './types';
import { useScopeTabLabels } from './constants';
import {
  buildInitialLayerCounts,
  defaultTimeRange,
  isRangeTooLargeError,
  layerPageSize,
  mapLayerItem,
  type TimeRange,
} from './memory-utils';
import { getLayerCount } from './utils';

export function useChatMemory(props: { activeTeamId?: string | null } = {}) {
  const { t } = useTranslation();
  const scopeTabLabels = useScopeTabLabels();
  const auth = readAuth();
  const { activeTeamId: storeActiveTeamId, activeTeam } = useTeams();
  const currentUserId = auth?.user_id ?? '';
  const activeTeamId = props.activeTeamId ?? storeActiveTeamId;
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = useMemo(
    () => teamAgents.filter((a) => a.owner_user_id === currentUserId),
    [teamAgents, currentUserId],
  );

  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layer, setLayer] = useState<MemoryLayer>('L1');
  const [layerPages, setLayerPages] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  // 各层「当前时间窗口内」的总条数（key: `${blockId}|${layer}`）。
  // layerCounts 存的是全量总数（选中块时 limit=1 拿到的）；带时间筛选（L0/L1）
  // 时 BFF 返回的 res.total 才是窗口内数量，分页必须用它，否则页数虚高。
  const [windowTotals, setWindowTotals] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  const [layerLoading, setLayerLoading] = useState(false);
  const [layerItemLoadingId, setLayerItemLoadingId] = useState<string | null>(null);
  // 详情页时间筛选器（仅 L0 / L1 生效），默认「前一天 ~ 当前」
  const [timeRange, setTimeRange] = useState<TimeRange>(() => defaultTimeRange());
  // 后端探测到筛选范围过大时为 true，BlockDetail 显示提示而非空态
  const [rangeTooLarge, setRangeTooLarge] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAllocate, setShowAllocate] = useState(false);
  // 默认展示 Agent 资产（fixed），避免用户误以为自己的资产在「团队资产」里
  const [scopeTab, setScopeTab] = useState<ScopeTab>('fixed');
  const [agentFilter, setAgentFilter] = useState<string>('');

  useEffect(() => {
    if (ownedTeamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !ownedTeamAgents.some((a) => a.agent_id === agentFilter)) {
      setAgentFilter(ownedTeamAgents[0].agent_id);
    }
  }, [ownedTeamAgents, agentFilter]);

  // ── 数据加载 ──
  // 请求序号防竞态：快速切换 tab 时，先发的请求可能后返回，
  // 旧 tab 的数据会覆盖新 tab 的数据。每次 fetch 递增序号，
  // 响应回来时校验序号是否仍是最新，不是就丢弃。
  const fetchSeqRef = useRef(0);
  // L0「自动扩展时间范围」的连续次数上限：窗口内到最早时自动往前扩展 24h，
  // 直到后端确认该记忆块在更早时间也没有记录（重新加载返回空 → l0Ended 置位）为止。
  // 该计数作为极端兜底（防止异常情况下无限循环），用户手动调整筛选会随组件重挂载而复位。
  const l0AutoExpandCountRef = useRef(0);

  const fetchBlocks = useCallback(async () => {
    if (!activeTeamId) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    // fixed tab 没选 agent 时不发请求，但要确保 loading 关闭
    if (scopeTab === 'fixed' && !agentFilter) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setBlocksLoading(true);
    // 立即清空旧数据 —— 否则切 tab 时会先看到上一个 tab 的列表，
    // 新数据到了才突然替换，视觉上就是"闪一下"。
    setBlocks([]);
    try {
      let res: { items: ChatMemoryBlock[]; total?: number };
      if (scopeTab === 'fixed') {
        res = await chatMemoryApi.agentFixed(agentFilter);
      } else {
        res = await chatMemoryApi.teamAssets(activeTeamId);
      }
      if (seq !== fetchSeqRef.current) return; // 已被后续请求取代
      const mapped: MemoryBlock[] = res.items.map((b) => ({
        id: b.id,
        title: b.title,
        summary: b.summary ?? '',
        tags: [],
        updated_at_ms: b.updated_at_ms,
        agent_id: b.agent_id ?? undefined,
        uploaded_by_user_id: b.uploaded_by_user_id,
        scope: b.scope,
        layer_counts: b.layer_counts,
        bound_agent_count: b.bound_agent_count,
        layers: { L0: [], L1: [], L2: [], L3: [] },
        // 初始只填后端返回的**真实**计数（>0）；为 0 / 未落地的层留 undefined＝「未知」。
        // 未知层的徽章显示占位，用户切到该 layer tab 时才按需请求真实计数，
        // 避免选中一个块就顺带把其余 3 层各 ping 一次（纯预请求用户还没看的东西）。
        layerCounts: buildInitialLayerCounts(b.layer_counts),
      }));
      setBlocks(mapped);
    } catch (e: any) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error(e?.message || t('memory.notify.loadFailed'));
      setBlocks([]);
    } finally {
      if (seq === fetchSeqRef.current) setBlocksLoading(false);
    }
    // 注：不再在这里 setSelectedId —— 之前 fetchBlocks 的 useCallback 依赖
    // 了 selectedId，导致每次选中一个 block 都重新 fetch 整个列表（卡顿主因）。
    // 默认选中的逻辑改由下方独立 effect 处理。
  }, [activeTeamId, scopeTab, agentFilter, t]);

  // 触发 fetchBlocks：依赖原始参数 + fetchBlocks，并用 key 去重防止短时间内重复触发。
  // 之前直接 `useEffect(() => fetchBlocks(), [fetchBlocks])` 会因 fetchBlocks 引用变化
  // （agentFilter 等依赖异步同步）触发多次，导致同一个接口被反复请求。
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    // 只有 fixed tab 才按 agentFilter 拉取；team tab 的数据源（teamAssets）与选中
    // agent 无关。若把 agentFilter 纳入 team 的 key，ownedTeamAgents 异步加载完后
    // agentFilter 会从 '' 变成首个 agent，导致 key 变化、再触发一次**完全重复**的
    // teamAssets 请求（进页面即多打一次接口）。
    const key =
      scopeTab === 'fixed'
        ? `${activeTeamId}|${scopeTab}|${agentFilter}`
        : `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchBlocks();
  }, [activeTeamId, scopeTab, agentFilter, fetchBlocks]);

  // 列表变化后，仅当当前选中的记忆块已不在列表中时清空选中。
  // 进入页面不自动选中第一个（与 skill 行为保持一致），由用户点击后再加载详情。
  useEffect(() => {
    if (selectedId && !blocks.some((b) => b.id === selectedId)) {
      setSelectedId(null);
    }
  }, [blocks, selectedId]);

  // ── 层分页加载 ──
  const selected = useMemo(
    () => (selectedId ? (blocks.find((b) => b.id === selectedId) ?? null) : null),
    [selectedId, blocks],
  );
  const layerPage = selected?.id ? (layerPages[selected.id]?.[layer] ?? 0) : 0;
  const pageSize = layerPageSize(layer);
  /** 当前层「当前时间窗口内」的总条数；无窗口缓存时回退全量总数（L2/L3 恒等于全量） */
  const windowTotal = selected?.id
    ? (windowTotals[selected.id]?.[layer] ?? getLayerCount(selected, layer))
    : 0;

  // ── 层计数：选中块即并行拉取四层计数 ──
  // 业务确认：teamAssets / agentFixed / myAgents 返回的 layer_counts 不可靠，
  // 必须对选中的 block 调用 L0/L1/L2/L3 四个 layer 接口才能拿到准确计数。
  // 之前做接口优化时把这里去掉了，导致徽章数量不正确。
  const layerCountSeqRef = useRef(0);
  useEffect(() => {
    if (!selected?.id) return;
    const blockId = selected.id;
    const seq = ++layerCountSeqRef.current;

    const layers: MemoryLayer[] = ['L0', 'L1', 'L2', 'L3'];
    layers.forEach((l) => {
      // 已经有真实计数的层不重复请求
      if (selected.layerCounts[l] !== undefined) return;

      chatMemoryApi
        .layer(blockId, l, 1, 0)
        .then((res) => {
          if (seq !== layerCountSeqRef.current) return; // 已被后续选中取代
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId ? { ...b, layerCounts: { ...b.layerCounts, [l]: res.total } } : b,
            ),
          );
        })
        .catch(() => {
          // 单层计数失败不阻断其他层，静默忽略
        });
    });
  }, [selected?.id]);

  // 切换记忆块时，时间筛选器重置为默认「前一天 ~ 当前」（业务确认：每次打开都重置）
  useEffect(() => {
    setTimeRange(defaultTimeRange());
    setRangeTooLarge(false);
  }, [selected?.id]);

  // 切块 / 时间范围变化时，窗口内总数缓存作废（翻页与总数必须按新窗口重新计算）
  useEffect(() => {
    setWindowTotals({});
  }, [selected?.id, timeRange.start, timeRange.end]);

  useEffect(() => {
    if (!selected?.id) {
      setLayerLoading(false);
      return;
    }
    let cancelled = false;
    setLayerLoading(true);
    // 时间筛选仅对 L0 / L1 生效；L2 / L3 是聚合产物，不传时间参数
    const useTimeFilter = layer === 'L0' || layer === 'L1';
    const timeStart = useTimeFilter ? timeRange.start || undefined : undefined;
    const timeEnd = useTimeFilter ? timeRange.end || undefined : undefined;
    chatMemoryApi
      .layer(
        selected.id,
        layer,
        pageSize,
        layerPage * pageSize,
        undefined,
        undefined,
        timeStart,
        timeEnd,
      )
      .then((res) => {
        if (cancelled) return;
        setRangeTooLarge(false);
        // 带时间筛选时 res.total 是「当前时间窗口内」的数量，单独保存供分页用
        // （layerCounts 仍是全量总数，不能动）。L2/L3 无时间维度，窗口总数 = 全量。
        setWindowTotals((prev) => ({
          ...prev,
          [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: res.total },
        }));
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            const updated = {
              ...b,
              layers: { ...b.layers },
              // 注意：带时间范围查询时 res.total 是「范围内」的数量，不是全量总数。
              // 全量总数在选中块时已通过 limit=1 请求获取并存于 layerCounts，
              // 这里不能覆盖，否则徽章计数 / L0 加载更多判断会错。
              // 仅未带时间筛选（L2/L3，或清除时间范围后的 L0/L1）才同步全量 total。
              ...(!useTimeFilter
                ? { layerCounts: { ...b.layerCounts, [layer]: res.total } }
                : {}),
            };
            if (res.layer === 'L0') {
              updated.layers.L0 = res.items;
              // 首屏 / 时间筛选变化重新加载时：窗口内有记录 → 重置「已到最早」，
              // 无记录 → 置位（说明该记忆块在更早时间也没有数据，自动扩展到此为止）。
              // 这是自动扩展时间范围的收敛条件，避免无限往前扩展。
              updated.l0Ended = res.items.length === 0;
            } else if (res.layer === 'L1') updated.layers.L1 = res.items.map(mapLayerItem);
            else if (res.layer === 'L2') updated.layers.L2 = res.items.map(mapLayerItem);
            else if (res.layer === 'L3') updated.layers.L3 = res.items.map(mapLayerItem);
            return updated;
          }),
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 范围过大：不弹错误提示，交由 BlockDetail 渲染「记忆条数过多」引导
        if (isRangeTooLargeError(e)) {
          setRangeTooLarge(true);
          return;
        }
        tea.notify.error(e instanceof Error ? e.message : t('memory.notify.layerFailed'));
      })
      .finally(() => {
        if (!cancelled) setLayerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, layer, layerPage, pageSize, timeRange.start, timeRange.end, t]);

  const handleLayerPageChange = useCallback(
    (nextPage: number) => {
      if (!selected?.id) return;
      setLayerPages((prev) => ({
        ...prev,
        [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: Math.max(0, nextPage) },
      }));
    },
    [selected?.id, layer],
  );

  // ── L0 加载更多（下拉/滚动到顶部触发） ──
  // L0 固定消费第 0 页（最新一批），「加载更多」用最后一条消息的时间戳做游标
  // （before_ts）请求更早的消息，而不是用数组长度做 offset。
  // 原因：VDB 对大 offset 的 scan+skip 成本高，用时间戳过滤可将查询从 O(offset+limit)
  // 降为 O(limit)。数组保持后端的新→旧顺序，渲染层再反转为旧→新，追加项出现在顶部。
  const [l0MoreLoading, setL0MoreLoading] = useState(false);
  const handleL0LoadMore = useCallback(async () => {
    if (!selected?.id || layer !== 'L0' || l0MoreLoading) return;
    const items = selected.layers.L0;
    const total = selected.layerCounts.L0 ?? items.length;
    // 已确认在当前时间窗口内到最早：不再发请求（双保险，正常由 BlockDetail 隐藏入口）
    if (selected.l0Ended) return;
    if (items.length >= total) return;
    // 游标：数组按新→旧排列，最后一条是最旧的已加载消息
    const lastItem = items[items.length - 1];
    const beforeTs = lastItem?.created_at;
    setL0MoreLoading(true);
    try {
      // beforeTs 有值时 offset 传 0（后端按 time_end 过滤）；首屏无 beforeTs 时走 offset=0。
      // 透传 timeStart 时间下界：加载更早消息不能越出用户设定的筛选范围，与首屏保持一致。
      const timeStart = timeRange.start || undefined;
      const res = await chatMemoryApi.layer(
        selected.id,
        'L0',
        pageSize,
        0,
        undefined,
        beforeTs,
        timeStart,
      );
      const noMore = res.items.length === 0;
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          // 防御性去重：并发/刷新导致页重叠时不重复渲染同一条消息
          const existing = new Set(b.layers.L0.map((m) => m.id));
          const more = res.items.filter((m) => !existing.has(m.id));
          // 注意：游标分页下后端返回的 total 是过滤后的剩余条数（time_end < beforeTs），
          // 不是全量总数。保留首屏拿到的全量 total，避免"加载更多后总数递减"的假象。
          return {
            ...b,
            layers: { ...b.layers, L0: [...b.layers.L0, ...more] },
            // 本次无新增（去重后为空）= 当前时间窗口内已到最早，置位隐藏「加载更早」入口
            l0Ended: b.l0Ended || more.length === 0,
          };
        }),
      );
      // 窗口内已到最早 → 自动往前扩展时间范围（提前 24h），触发 L0 重新加载，
      // 让用户无需手改筛选器即可继续看到更早的记忆（设计意图：时间筛选不该成为
      // 回溯历史的阻碍）。重新加载后若仍无数据，effect 会把 l0Ended 置位终止扩展。
      // count 仅作极端兜底防死循环；正常路径靠「扩展后加载为空 → l0Ended」自然收敛。
      if (noMore && timeRange.start && l0AutoExpandCountRef.current < 30) {
        l0AutoExpandCountRef.current += 1;
        const newStart = new Date(new Date(timeRange.start).getTime() - 24 * 60 * 60 * 1000);
        setL0MoreLoading(false);
        setTimeRange((prev) => ({ ...prev, start: newStart.toISOString() }));
        return;
      }
    } catch (e: any) {
      tea.notify.error(e?.message || t('memory.notify.layerFailed'));
    } finally {
      setL0MoreLoading(false);
    }
  }, [selected, layer, l0MoreLoading, pageSize, timeRange.start, t]);

  const handleLayerItemLoad = useCallback(
    async (itemId: string) => {
      if (!selected?.id || layer !== 'L2') return;
      const current = selected.layers.L2.find((item) => item.id === itemId);
      if (!current) return;
      if (current.body.trim()) {
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) =>
                  item.id === itemId ? { ...item, body: '', tags: [] } : item,
                ),
              },
            };
          }),
        );
        return;
      }
      setLayerItemLoadingId(itemId);
      try {
        const res = await chatMemoryApi.layer(selected.id, 'L2', 1, 0, itemId);
        const loaded = res.items[0] ? mapLayerItem(res.items[0]) : null;
        if (!loaded) return;
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) => (item.id === itemId ? { ...item, ...loaded } : item)),
              },
            };
          }),
        );
      } catch (e: any) {
        tea.notify.error(e?.message || t('memory.notify.l2Failed'));
      } finally {
        setLayerItemLoadingId(null);
      }
    },
    [selected?.id, selected?.layers.L2, layer, t],
  );

  // ── 编辑：保存单层内容（Owner-only；成功后乐观更新对应条目 body） ──
  // L1 = content 覆盖；L2 = 整份 scenario 正文覆盖（BFF 会剥 META 后写、内核重建 META）；
  // L3 = 整份 core persona 覆盖。失败时抛出，交由调用方（编辑弹窗）保留输入并提示。
  const handleSaveLayerItem = useCallback(
    async (targetLayer: 'L1' | 'L2' | 'L3', itemId: string, content: string) => {
      if (!selected?.id) return;
      await chatMemoryApi.updateLayer(selected.id, targetLayer, {
        id: itemId,
        content,
      });
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          return {
            ...b,
            layers: {
              ...b.layers,
              [targetLayer]: b.layers[targetLayer].map((item) =>
                item.id === itemId ? { ...item, body: content } : item,
              ),
            },
          };
        }),
      );
      tea.notify.success(t('memory.notify.editSuccess'));
    },
    [selected?.id, t],
  );

  // ── 搜索：L0（对话）/ L1（原子记忆）语义 / 关键字检索 ──
  // 跨 session 召回，返回带 score 的命中项；结果 state 交由 BlockDetail 管理，
  // 这里只提供请求函数（依赖当前选中块）。
  const searchLayer = useCallback(
    async (targetLayer: 'L0' | 'L1', query: string): Promise<ChatMemorySearchHit[]> => {
      if (!selected?.id) return [];
      const res = await chatMemoryApi.searchLayer(selected.id, targetLayer, query, 30);
      return res.items ?? [];
    },
    [selected?.id],
  );

  // ── 过滤与辅助 ──
  const filtered = useMemo(() => {
    if (scopeTab === 'fixed')
      return agentFilter ? blocks.filter((b) => b.agent_id === agentFilter) : [];
    return blocks;
  }, [blocks, scopeTab, agentFilter]);

  function agentLabel(id?: string): string {
    if (!id) return '';
    const a = teamAgents.find((x) => x.agent_id === id);
    return a ? a.name : id;
  }

  function selfChatMemoryAgentId(b: MemoryBlock): string | undefined {
    if (!activeTeamId) return undefined;
    const prefix = `chat_memory-${activeTeamId}-`;
    if (b.id.startsWith(prefix)) return b.id.slice(prefix.length) || undefined;
    return b.agent_id;
  }

  function isSelfChatMemory(b: MemoryBlock): boolean {
    // 只有当"这条 chat_memory 是**当前正在查看的 agent** 的自身记忆"时才算 self —— 不允许解绑。
    // 之前 bug：任何 `chat_memory-{team}-{agentX}` 命名的 asset 都被判成 self，
    // 导致别人 agent 的记忆借入到当前 agent 后（e.g. test3 借了 test-bugfix 的），
    // 也被误判为 self，"解绑"按钮永远不显示。
    // fixed tab 下 agentFilter 就是当前 agent；team/personal tab 不涉及"解绑"语义，
    // 保留原前缀判定作为兜底。
    if (!activeTeamId) return false;
    if (scopeTab === 'fixed' && agentFilter) {
      return b.id === `chat_memory-${activeTeamId}-${agentFilter}`;
    }
    const ownerAgentId = selfChatMemoryAgentId(b);
    return !!ownerAgentId && b.id === `chat_memory-${activeTeamId}-${ownerAgentId}`;
  }

  function allocatableAgents(b: MemoryBlock) {
    // 文档 §4.5 allocate 权限规则：
    //   1. agent.owner = me（只能分配到自己 owner 的 agent，否则 403 NOT_YOUR_AGENT）
    //   3. 不能把 agent 自己的 chat_memory 分配给自己
    // 所以数据源用 ownedTeamAgents，排除该记忆块自身的 agent。
    const ownerAgentId = selfChatMemoryAgentId(b);
    return ownedTeamAgents
      .filter((a) => a.agent_id !== ownerAgentId)
      .map((a) => ({ agent_id: a.agent_id, name: a.name }));
  }

  // ── 操作 ──
  async function handleDeleteBlock(id: string) {
    const ok = await tea.confirm({
      message: t('memory.confirm.unbind'),
      description: t('memory.confirm.unbind.desc'),
      okText: t('memory.confirm.unbind.ok'),
    });
    if (!ok) return;
    try {
      const block = blocks.find((b) => b.id === id);
      if (!activeTeamId || !block?.agent_id) return;
      await chatMemoryApi.unbind(activeTeamId, id, block.agent_id);
      setBlocks((prev) => prev.filter((b) => b.id !== id));
      if (selectedId === id) setSelectedId(null);
      tea.notify.success(t('memory.notify.unbound'));
    } catch (e: any) {
      tea.notify.error(e?.message || t('memory.notify.unbindFailed'));
    }
  }

  async function handleImport({
    agent_id,
    messages,
  }: {
    agent_id: string;
    messages: Array<{ role: string; content: string }>;
  }) {
    try {
      if (!activeTeamId || !agent_id) {
        tea.notify.warning(t('memory.notify.selectAgent'));
        return;
      }
      await chatMemoryApi.import({ teamId: activeTeamId, agentId: agent_id, messages });
      tea.notify.success(t('memory.notify.importSuccess', { count: messages.length }));
      setShowImport(false);
      fetchBlocks();
    } catch (e: any) {
      tea.notify.error(e?.message || t('memory.notify.importFailed'));
    }
  }

  // 共享/私密切换：原 personal tab 的独有能力，取消 personal tab 后迁移到
  // 「Agent 资产(fixed)」tab 的资产项上（仅 owner 可切，见 ChatMemoryPanel 渲染处）。
  async function handleToggleScope(block: MemoryBlock, newScope: 'team' | 'private') {
    if (block.scope === newScope) return;
    // 切私密时先 confirm：其他 agent 若已借入该记忆将不可再使用。
    // 说明只给感知，不列出被影响的 agent 列表（内核不主动 prune，故也无需精确数字）。
    if (newScope === 'private') {
      const ok = await tea.confirm({
        message: t('memory.confirm.private'),
        description: t('memory.confirm.private.desc'),
        okText: t('memory.confirm.private.ok'),
      });
      if (!ok) return;
    }
    try {
      await chatMemoryApi.patchScope(block.id, newScope);
      tea.notify.success(
        newScope === 'team' ? t('memory.notify.scopeTeam') : t('memory.notify.scopePrivate'),
      );
      fetchBlocks();
    } catch (e: any) {
      tea.notify.error(e?.message || t('memory.notify.scopeFailed'));
    }
  }

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUserId,
    ownedTeamAgents,
    teamAgents,
    scopeTabLabels,
    // state
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    layer,
    setLayer,
    layerPages,
    layerLoading,
    layerItemLoadingId,
    l0MoreLoading,
    timeRange,
    setTimeRange,
    rangeTooLarge,
    showImport,
    setShowImport,
    showAllocate,
    setShowAllocate,
    scopeTab,
    setScopeTab,
    agentFilter,
    setAgentFilter,
    // computed
    selected,
    layerPage,
    pageSize,
    windowTotal,
    filtered,
    // handlers
    fetchBlocks,
    handleLayerPageChange,
    handleL0LoadMore,
    handleLayerItemLoad,
    handleSaveLayerItem,
    searchLayer,
    handleDeleteBlock,
    handleImport,
    handleToggleScope,
    // helpers
    agentLabel,
    allocatableAgents,
    isSelfChatMemory,
  };
}

export type ChatMemoryStore = ReturnType<typeof useChatMemory>;
