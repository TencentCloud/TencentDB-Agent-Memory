/**
 * ChatMemoryPanel — 原子能力 · 记忆。
 *
 * 后端链路：POST /api/v1/chat-memory/team-assets|agent-fixed|my-agents|layer|allocate|unbind|import
 *
 * 子组件：
 *   BlockDetail           — 右侧详情面板（meta + L0-L3 tabs）
 *   PersonalAssetsTable   — 「我的资产分配」tab
 *   ImportBlockDialog     — 导入 session 对话框
 *   AllocateMemoryDialog  — 分配到 Agent 对话框
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segment, Select } from 'tea-component';
import { AppIcon, UsergroupIcon, UserIcon } from 'tea-icons-react';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryBlock, type ChatMemoryLayerItem } from '@/lib/teamApi';
import { type MemoryBlock, type MemoryLayer, type ScopeTab } from './types';
import { useScopeTabLabels } from './constants';

import { BlockDetail } from './BlockDetail';
import { PersonalAssetsTable } from './PersonalAssetsTable';
import { ImportBlockDialog } from './ImportBlockDialog';
import { AllocateMemoryDialog } from './AllocateMemoryDialog';
import { AssetPageHeader } from '@/pages/ResourcePage/components/AssetPageHeader';
import { AssetSplitLayout } from '@/pages/ResourcePage/components/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemBadges,
  AssetBadge,
  AssetBadgeYou,
  AssetItemMeta,
  AssetItemTime,
} from '@/pages/ResourcePage/components/AssetListPanel';
import './chat-memory-panel.css';

const LAYER_PAGE_SIZE: Record<MemoryLayer, number> = { L0: 20, L1: 20, L2: 50, L3: 50 };
function layerPageSize(layer: MemoryLayer): number {
  return LAYER_PAGE_SIZE[layer];
}

export default function ChatMemoryPanel(
  props: {
    currentUser?: string;
    activeTeamId?: string | null;
  } = {},
) {
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
  const [layerLoading, setLayerLoading] = useState(false);
  const [layerItemLoadingId, setLayerItemLoadingId] = useState<string | null>(null);
  const [layerRefresh, setLayerRefresh] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const [showAllocate, setShowAllocate] = useState(false);
  const [scopeTab, setScopeTab] = useState<ScopeTab>('team');
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
      } else if (scopeTab === 'personal') {
        res = await chatMemoryApi.myAgents(activeTeamId);
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
        scope: (b as any).scope,
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
    // 只有 fixed tab 才按 agentFilter 拉取；team/personal tab 的数据源
    // （teamAssets / myAgents）与选中 agent 无关。若把 agentFilter 纳入这两个 tab 的 key，
    // ownedTeamAgents 异步加载完后 agentFilter 会从 '' 变成首个 agent，导致 key 变化、
    // 再触发一次**完全重复**的 teamAssets / myAgents 请求（进页面即多打一次接口）。
    const key =
      scopeTab === 'fixed'
        ? `${activeTeamId}|${scopeTab}|${agentFilter}`
        : `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchBlocks();
  }, [activeTeamId, scopeTab, agentFilter, fetchBlocks]);

  // 切换 tab 时：进入 personal tab 主动清空 selectedId，与 skill PersonalAssetTab
  // 行为对齐 —— 「我的资产分配」tab 默认不选中任何行，必须用户点击才选中。
  // team / fixed tab 不清空，由下方「默认选中」effect 自动选第一个。
  useEffect(() => {
    if (scopeTab === 'personal') {
      setSelectedId(null);
    }
  }, [scopeTab]);

  // 默认选中：blocks 变化后，如果当前没选中、或选中的已不在列表里，自动选第一个。
  // 从 fetchBlocks 里拆出来，避免把 selectedId 放进 fetchBlocks 的依赖数组。
  // ⚠ personal tab 不自动选中：与 skill 的 PersonalAssetTab 交互对齐 ——
  //    必须用户点击某行才选中，顶部「分配到 Agent」按钮才 enable。
  //    team/fixed tab 仍保留自动选中第一行的行为（左侧 list 默认聚焦第一条）。
  useEffect(() => {
    if (scopeTab === 'personal') {
      // personal tab 下：如果之前选中的 id 不在新列表里，清空；
      // 但不主动 setSelectedId 到 blocks[0]。让用户点击触发选中。
      if (selectedId && !blocks.some((b) => b.id === selectedId)) {
        setSelectedId(null);
      }
      return;
    }
    if (blocks.length > 0) {
      const stillExists = blocks.some((b) => b.id === selectedId);
      if (!stillExists) setSelectedId(blocks[0].id);
    } else if (selectedId) {
      setSelectedId(null);
    }
  }, [blocks, selectedId, scopeTab]);

  // ── 层分页加载 ──
  const selected = useMemo(
    () => (selectedId ? (blocks.find((b) => b.id === selectedId) ?? null) : null),
    [selectedId, blocks],
  );
  const layerPage = selected?.id ? (layerPages[selected.id]?.[layer] ?? 0) : 0;
  const pageSize = layerPageSize(layer);

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
              b.id === blockId
                ? { ...b, layerCounts: { ...b.layerCounts, [l]: res.total } }
                : b,
            ),
          );
        })
        .catch(() => {
          // 单层计数失败不阻断其他层，静默忽略
        });
    });
  }, [selected?.id]);

  const handleDeleteItem = useCallback(
    async (delLayer: 'L0' | 'L1' | 'L2', id: string, path?: string) => {
      if (!selected?.id) return;
      try {
        const target =
          delLayer === 'L0'
            ? { message_ids: [id] }
            : delLayer === 'L1'
              ? { ids: [id] }
              : { path: path || id };
        const res = await chatMemoryApi.deleteMemory(selected.id, delLayer, target);
        tea.notify.success(
          t('memory.notify.deleted', { count: res?.deleted_count ?? 1 }),
        );
        setLayerPages((prev) => ({
          ...prev,
          [selected.id]: { ...(prev[selected.id] ?? {}), [delLayer]: 0 },
        }));
        setLayerRefresh((v) => v + 1);
      } catch (e: any) {
        tea.notify.error(e?.message || t('memory.notify.deleteFailed'));
      }
    },
    [selected?.id, t],
  );

  useEffect(() => {
    if (!selected?.id) {
      setLayerLoading(false);
      return;
    }
    let cancelled = false;
    setLayerLoading(true);
    chatMemoryApi
      .layer(selected.id, layer, pageSize, layerPage * pageSize)
      .then((res) => {
        if (cancelled) return;
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            const updated = {
              ...b,
              layers: { ...b.layers },
              layerCounts: { ...b.layerCounts, [layer]: res.total },
            };
            if (res.layer === 'L0') updated.layers.L0 = res.items;
            else if (res.layer === 'L1') updated.layers.L1 = res.items.map(mapLayerItem);
            else if (res.layer === 'L2') updated.layers.L2 = res.items.map(mapLayerItem);
            else if (res.layer === 'L3') updated.layers.L3 = res.items.map(mapLayerItem);
            return updated;
          }),
        );
      })
      .catch((e: any) => {
        if (!cancelled) tea.notify.error(e?.message || t('memory.notify.layerFailed'));
      })
      .finally(() => {
        if (!cancelled) setLayerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, layer, layerPage, pageSize, t, layerRefresh]);

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
    if (items.length >= total) return;
    // 游标：数组按新→旧排列，最后一条是最旧的已加载消息
    const lastItem = items[items.length - 1];
    const beforeTs = lastItem?.created_at;
    setL0MoreLoading(true);
    try {
      // beforeTs 有值时 offset 传 0（后端按 time_end 过滤）；首屏无 beforeTs 时走 offset=0
      const res = await chatMemoryApi.layer(
        selected.id, 'L0', pageSize, 0, undefined, beforeTs,
      );
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
          };
        }),
      );
    } catch (e: any) {
      tea.notify.error(e?.message || t('memory.notify.layerFailed'));
    } finally {
      setL0MoreLoading(false);
    }
  }, [selected, layer, l0MoreLoading, pageSize, t]);

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
      await chatMemoryApi.import(activeTeamId, agent_id, messages);
      tea.notify.success(t('memory.notify.importSuccess', { count: messages.length }));
      setShowImport(false);
      fetchBlocks();
    } catch (e: any) {
      tea.notify.error(e?.message || t('memory.notify.importFailed'));
    }
  }

  async function handleTogglePersonalScope(block: MemoryBlock, newScope: 'team' | 'private') {
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
      tea.notify.success(newScope === 'team' ? t('memory.notify.scopeTeam') : t('memory.notify.scopePrivate'));
      fetchBlocks();
    } catch (e: any) {
      tea.notify.error(e?.message || t('memory.notify.scopeFailed'));
    }
  }

  // ── 渲染 ──
  return (
    <div className="_asset-memory-page">
      <AssetPageHeader
        title={t('memory.title')}
        subtitle={
          activeTeam
            ? t('memory.subtitle.team', { name: activeTeam.name, count: blocks.length })
            : t('memory.subtitle.global', { count: blocks.length })
        }
        scope={
          <Segment
            value={scopeTab}
            onChange={(v) => setScopeTab(v as ScopeTab)}
            options={(['team', 'fixed', 'personal'] as ScopeTab[]).map((tab) => ({
              value: tab,
              text: scopeTabLabels[tab],
            }))}
          />
        }
        agent={
          scopeTab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={agentFilter}
              onChange={setAgentFilter}
              disabled={ownedTeamAgents.length === 0}
              placeholder={t('memory.noAgent')}
              options={ownedTeamAgents.map((agent) => ({
                value: agent.agent_id,
                text: `${agent.name}（${agent.agent_id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          <>
            {(() => {
              const isPrivateAndNotOwner =
                !!selected &&
                selected.scope === 'private' &&
                selected.uploaded_by_user_id !== currentUserId;
              const disabled = !selected || isPrivateAndNotOwner;
              const tooltip = !selected
                ? t('memory.allocate.disabled')
                : isPrivateAndNotOwner
                  ? t('memory.allocate.privateDisabled')
                  : undefined;
              return (
                <Button onClick={() => setShowAllocate(true)} disabled={disabled} tooltip={tooltip}>
                  {t('memory.allocateToAgent')}
                </Button>
              );
            })()}
            <Button type="primary" onClick={() => setShowImport(true)}>
              {t('memory.import')}
            </Button>
          </>
        }
      />

      {scopeTab === 'personal' ? (
        <PersonalAssetsTable
          blocks={blocks}
          loading={blocksLoading}
          onToggleScope={handleTogglePersonalScope}
          selectedId={selectedId}
          onSelect={setSelectedId}
          currentUserId={currentUserId}
        />
      ) : (
        <AssetSplitLayout
          sidebar={
            <AssetListPanel
              title={t('memory.blockList')}
              count={t('memory.blockCount', { filtered: filtered.length, total: blocks.length })}
              loading={blocksLoading}
              items={filtered}
              selectedId={selectedId}
              getItemId={(b) => b.id}
              onSelect={(b) => setSelectedId(b.id)}
              isItemDisabled={(b) =>
                scopeTab === 'fixed' &&
                b.scope === 'private' &&
                b.uploaded_by_user_id !== currentUserId
              }
              emptyText={t('memory.empty.filtered')}
              renderItem={(b) => {
                const isRevoked =
                  scopeTab === 'fixed' &&
                  b.scope === 'private' &&
                  b.uploaded_by_user_id !== currentUserId;
                return (
                  <>
                    <AssetItemHeader>
                      <AssetItemName title={b.title}>
                        {b.title}
                        {isRevoked && (
                          <span className="_memory-badge _memory-badge--warning">{t('memory.list.revoked')}</span>
                        )}
                      </AssetItemName>
                    </AssetItemHeader>

                    <AssetItemBadges>
                      {b.agent_id ? (
                        <AssetBadge icon={<AppIcon size={10} />} title={t('memory.list.fixedTo', { id: b.agent_id })}>
                          {agentLabel(b.agent_id)}
                        </AssetBadge>
                      ) : (
                        <AssetBadge icon={<UsergroupIcon size={10} />} title={t('memory.list.teamPool')}>
                          {t('memory.list.teamPoolShort')}
                        </AssetBadge>
                      )}
                      {b.uploaded_by_user_id && (
                        <AssetBadge icon={<UserIcon size={10} />}>
                          @{b.uploaded_by_user_id}
                          {b.uploaded_by_user_id === currentUserId && (
                            <AssetBadgeYou>{t('common.you')}</AssetBadgeYou>
                          )}
                        </AssetBadge>
                      )}
                    </AssetItemBadges>

                    <AssetItemMeta>
                      <AssetItemTime>{new Date(b.updated_at_ms).toLocaleString()}</AssetItemTime>
                    </AssetItemMeta>

                    {scopeTab === 'fixed' && !isSelfChatMemory(b) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteBlock(b.id);
                        }}
                        title={t('memory.unbind.tooltip')}
                        className="_memory-block-item-unbind"
                      >
                        {t('memory.unbind')}
                      </button>
                    )}
                  </>
                );
              }}
            />
          }
          detail={
            !selected ? (
              <div className="_alp-detail-empty">
                {t('memory.detail.empty')}
              </div>
            ) : (
              <BlockDetail
                block={selected}
                layer={layer}
                onLayerChange={setLayer}
                agentLabel={agentLabel}
                layerPage={layerPage}
                layerPageSize={pageSize}
                layerLoading={layerLoading}
                onLayerPageChange={handleLayerPageChange}
                onLayerItemLoad={handleLayerItemLoad}
                layerItemLoadingId={layerItemLoadingId}
                onL0LoadMore={handleL0LoadMore}
                l0MoreLoading={l0MoreLoading}
                onDeleteItem={handleDeleteItem}
              />
            )
          }
        />
      )}

      {showImport && (
        <ImportBlockDialog
          onClose={() => setShowImport(false)}
          onImported={handleImport}
          agents={ownedTeamAgents.map((a) => ({ agent_id: a.agent_id, name: a.name }))}
          defaultAgentId={scopeTab === 'fixed' && agentFilter ? agentFilter : ''}
        />
      )}

      {showAllocate && selected && (
        <AllocateMemoryDialog
          memoryTitle={selected.title}
          agents={allocatableAgents(selected)}
          // 文案区分：personal tab 的 memory 是用户 owner 的 agent 自有记忆，
          // 不能用"团队池里"这种措辞。team/fixed tab 走默认 'team'（团队池语义）。
          memorySource={scopeTab === 'personal' ? 'personal' : 'team'}
          onClose={() => setShowAllocate(false)}
          onAllocated={async (agentId) => {
            try {
              await chatMemoryApi.allocate(activeTeamId!, selected.id, agentId);
              tea.notify.success(t('memory.notify.allocated'));
              setShowAllocate(false);
              fetchBlocks();
            } catch (e: any) {
              tea.notify.error(e?.message || t('memory.notify.allocateFailed'));
            }
          }}
        />
      )}
    </div>
  );
}

function mapLayerItem(i: ChatMemoryLayerItem) {
  return {
    id: i.id,
    title: i.title,
    body: i.body,
    refs: i.refs,
    tags: i.tags,
    created_at: i.created_at,
  };
}

// 由列表接口的 layer_counts 构造初始 layerCounts：只保留 >0 的真实计数，
// 其余留 undefined＝「未知」。徽章据此显示占位，避免把「未加载」误显示成「0」，
// 也不再为拿计数而预请求。后端 layer_counts 落地真实值后此处会自动直接采用。
function buildInitialLayerCounts(lc: {
  L0_messages: number;
  L1: number;
  L2: number;
  L3: number;
}): MemoryBlock['layerCounts'] {
  const out: MemoryBlock['layerCounts'] = {};
  if (lc.L0_messages > 0) out.L0 = lc.L0_messages;
  if (lc.L1 > 0) out.L1 = lc.L1;
  if (lc.L2 > 0) out.L2 = lc.L2;
  if (lc.L3 > 0) out.L3 = lc.L3;
  return out;
}
