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
import { AppIcon, UsergroupIcon } from 'tea-icons-react';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryBlock, type ChatMemoryLayerItem } from '@/lib/teamApi';
import { type MemoryBlock, type MemoryLayer, type ScopeTab } from './types';
import { SCOPE_TAB_LABELS } from './constants';
import { formatShortTime } from './utils';
import { BlockDetail } from './BlockDetail';
import { PersonalAssetsTable } from './PersonalAssetsTable';
import { ImportBlockDialog } from './ImportBlockDialog';
import { AllocateMemoryDialog } from './AllocateMemoryDialog';
import { AssetPageHeader } from '@/pages/ResourcePage/components/AssetPageHeader';
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
      tea.notify.error(e?.message || '加载记忆块失败');
      setBlocks([]);
    } finally {
      if (seq === fetchSeqRef.current) setBlocksLoading(false);
    }
    // 注：不再在这里 setSelectedId —— 之前 fetchBlocks 的 useCallback 依赖
    // 了 selectedId，导致每次选中一个 block 都重新 fetch 整个列表（卡顿主因）。
    // 默认选中的逻辑改由下方独立 effect 处理。
  }, [activeTeamId, scopeTab, agentFilter]);

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
        if (!cancelled) tea.notify.error(e?.message || '加载层数据失败');
      })
      .finally(() => {
        if (!cancelled) setLayerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, layer, layerPage, pageSize]);

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
        tea.notify.error(e?.message || '加载 L2 原文失败');
      } finally {
        setLayerItemLoadingId(null);
      }
    },
    [selected?.id, selected?.layers.L2, layer],
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
      message: '确认解绑该记忆块？',
      description: '将从当前 agent 移除该记忆块绑定。',
      okText: '解绑',
    });
    if (!ok) return;
    try {
      const block = blocks.find((b) => b.id === id);
      if (!activeTeamId || !block?.agent_id) return;
      await chatMemoryApi.unbind(activeTeamId, id, block.agent_id);
      setBlocks((prev) => prev.filter((b) => b.id !== id));
      if (selectedId === id) setSelectedId(null);
      tea.notify.success('已解绑');
    } catch (e: any) {
      tea.notify.error(e?.message || '解绑失败');
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
        tea.notify.warning('请先选择一个 Agent');
        return;
      }
      await chatMemoryApi.import(activeTeamId, agent_id, messages);
      tea.notify.success(`导入成功 · ${messages.length} 条消息，tdai 后台正在蒸馏 L1/L2/L3`);
      setShowImport(false);
      fetchBlocks();
    } catch (e: any) {
      tea.notify.error(e?.message || '导入失败');
    }
  }

  async function handleTogglePersonalScope(block: MemoryBlock, newScope: 'team' | 'private') {
    if (block.scope === newScope) return;
    // 切私密时先 confirm：其他 agent 若已借入该记忆将不可再使用。
    // 说明只给感知，不列出被影响的 agent 列表（内核不主动 prune，故也无需精确数字）。
    if (newScope === 'private') {
      const ok = await tea.confirm({
        message: '设为私密后，其他 Agent 将不能再使用这条记忆',
        description: '如需再次共享，随时可以改回团队可见。',
        okText: '设为私密',
      });
      if (!ok) return;
    }
    try {
      await chatMemoryApi.patchScope(block.id, newScope);
      tea.notify.success(newScope === 'team' ? '已切换为团队可见' : '已切换为私密');
      fetchBlocks();
    } catch (e: any) {
      tea.notify.error(e?.message || '切换可见范围失败');
    }
  }

  // ── 渲染 ──
  return (
    <div className="_asset-memory-page">
      <AssetPageHeader
        title="Chat_Memory · 原子记忆块"
        subtitle={
          activeTeam
            ? `${activeTeam.name} · 共 ${blocks.length} 条记忆`
            : `共 ${blocks.length} 条记忆`
        }
        scope={
          <Segment
            value={scopeTab}
            onChange={(v) => setScopeTab(v as ScopeTab)}
            options={(['team', 'fixed', 'personal'] as ScopeTab[]).map((t) => ({
              value: t,
              text: SCOPE_TAB_LABELS[t],
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
              placeholder="无可选 Agent"
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
                ? '请先选中一条记忆块'
                : isPrivateAndNotOwner
                  ? '该记忆已被 owner 设为私密，无法再分配给其他 Agent'
                  : undefined;
              return (
                <Button onClick={() => setShowAllocate(true)} disabled={disabled} tooltip={tooltip}>
                  分配到 Agent
                </Button>
              );
            })()}
            <Button type="primary" onClick={() => setShowImport(true)}>
              导入记忆
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
        <div className="_asset-memory-body">
          {/* Left: block list */}
          <section className="_asset-memory-list-column">
            <div className="_asset-memory-list-panel">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-foreground/85">{t('memory.title', { defaultValue: '记忆块' })}</div>
                <div className="text-[11px] text-muted-foreground">
                  {filtered.length} / {blocks.length}
                </div>
              </div>
              {filtered.length === 0 ? (
                <div className="text-[12px] text-muted-foreground px-3 py-4">
                  没有匹配的记忆块。
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {filtered.map((b) => {
                    const active = selectedId === b.id;
                    // 固定资产 tab 里被 owner 切成 private 的"外部借入记忆" —— 视觉灰化
                    // + 加"已私密"badge，让使用者知情；主体点击禁用（详情/内容不可预览），
                    // 但右侧"解绑"按钮保留可点，允许清理残留绑定。
                    const isRevoked =
                      scopeTab === 'fixed' &&
                      b.scope === 'private' &&
                      b.uploaded_by_user_id !== currentUserId;
                    return (
                      <li
                        key={b.id}
                        className={[
                          '_asset-memory-list-item memory-list-item group relative border-l-2 px-3.5 py-3 pr-8 transition',
                          isRevoked
                            ? 'opacity-70 bg-muted/30 border-transparent'
                            : 'cursor-pointer ' +
                              (active
                                ? 'border-primary bg-primary/10'
                                : 'hover:bg-accent border-transparent'),
                        ].join(' ')}
                        title={
                          isRevoked
                            ? '该记忆已被 owner 设为私密，不可预览；可点右侧"解绑"清理该绑定。'
                            : undefined
                        }
                      >
                        <button
                          onClick={() => {
                            if (!isRevoked) setSelectedId(b.id);
                          }}
                          disabled={isRevoked}
                          className="w-full text-left disabled:cursor-not-allowed"
                        >
                          <div className="font-medium text-[12px] text-foreground/85 leading-snug break-words line-clamp-2">
                            {b.title}
                            {isRevoked && (
                              <span
                                className="ml-1.5 px-1 rounded text-[9px] font-normal border align-middle"
                                style={{
                                  background: 'var(--tea-color-bg-warning-lighten-default)',
                                  borderColor: 'var(--tea-color-border-warning-default)',
                                  color: 'var(--tea-color-text-warning-default)',
                                }}
                              >
                                已被 owner 设为私密
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground flex-wrap">
                            {b.agent_id ? (
                              <span
                                className="px-1 rounded border font-mono truncate max-w-[120px] inline-flex items-center gap-0.5"
                                style={{
                                  background: 'var(--tea-color-bg-success-lighten-default)',
                                  borderColor: 'var(--tea-color-border-success-default)',
                                  color: 'var(--tea-color-text-success-default)',
                                }}
                                title={`Agent 固定资产 · ${b.agent_id}`}
                              >
                                <AppIcon size={12} /> {agentLabel(b.agent_id)}
                              </span>
                            ) : (
                              <span
                                className="px-1 rounded border inline-flex items-center gap-0.5"
                                style={{
                                  background: 'var(--tea-color-bg-warning-lighten-default)',
                                  borderColor: 'var(--tea-color-border-warning-default)',
                                  color: 'var(--tea-color-text-warning-default)',
                                }}
                                title="团队记忆池"
                              >
                                <UsergroupIcon size={12} /> 团队池
                              </span>
                            )}
                          </div>
                          {b.uploaded_by_user_id && (
                            <div className="mt-1 text-[10px] text-muted-foreground">
                              上传：
                              <span className="font-mono text-foreground/70">
                                @{b.uploaded_by_user_id}
                              </span>
                              {b.uploaded_by_user_id === currentUserId && (
                                <span className="ml-1 text-[9px] text-primary">（你）</span>
                              )}
                            </div>
                          )}
                          {/*
                            L0/L1/L2/L3 条数徽章已从左侧列表移除：列表接口不带真实
                            layer_counts（都是 0），旧版还会按选中块 4 次 /layer 请求
                            做"计数校正"；用户仅在右侧详情面板查看层内容，列表徽章
                            无实际用途，隐藏后避免误导。
                          */}
                          <div className="flex items-center justify-end gap-2 mt-1.5">
                            <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
                              {formatShortTime(b.updated_at_ms)}
                            </span>
                          </div>
                        </button>
                        {scopeTab === 'fixed' && !isSelfChatMemory(b) && (
                          // 醒目版"解绑该记忆块"按钮：红底白字，尺寸大，永久显示。
                          // 从当前 agent 的固定资产表移除这条 chat_memory 绑定（记忆本身不删）。
                          // self memory 不显示（不允许解绑）。
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteBlock(b.id);
                            }}
                            title="解除该 Agent 对这条记忆块的固定绑定（记忆本身保留）"
                            style={{
                              position: 'absolute',
                              right: '8px',
                              top: '8px',
                              zIndex: 10,
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: 'var(--tea-color-text-on-bg-error-default)',
                              background: 'var(--tea-color-bg-error-default)',
                              border: '1px solid var(--tea-color-border-error-default)',
                              cursor: 'pointer',
                              boxShadow: 'var(--tea-shadow-xs)',
                            }}
                          >
                            解绑
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* Right: detail */}
          <section className="_asset-memory-detail-column">
            <div className="_asset-memory-detail-panel">
              {!selected ? (
                <div className="text-[12px] text-muted-foreground px-2 py-6">
                  请在左侧选中一个记忆块查看详情。
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
                />
              )}
            </div>
          </section>
        </div>
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
              tea.notify.success('已分配到 Agent');
              setShowAllocate(false);
              fetchBlocks();
            } catch (e: any) {
              tea.notify.error(e?.message || '分配失败');
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
