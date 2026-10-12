/**
 * useCodeSources —— Code 资产页的全部状态与数据逻辑。
 * 组件层只保留 JSX 渲染，状态 / 数据逻辑集中在此。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  knowledgeApi,
  type CodeGraphDetail,
  type SourceProviderMeta,
} from '@/lib/api/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { isValidGitHttpUrl, formatRepoName, type ScopeTab, type StatusFilter, type SubView, type ViewMode } from '../constants/code-constants';

export function useCodeSources() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<CodeGraphDetail[]>([]);
  const [loading, setLoading] = useState(false);
  // 默认展示 Agent 资产（fixed），避免用户误以为自己的资产在「团队资产」里
  const [scopeTab, setScopeTab] = useState<ScopeTab>('fixed');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [inFlight, setInFlight] = useState<CodeGraphDetail[]>([]);

  // Detail view state
  const [subView, setSubView] = useState<SubView>('list');
  const [selectedCgId, setSelectedCgId] = useState('');

  // Register dialog state
  const [showRegister, setShowRegister] = useState(false);
  const [formRepo, setFormRepo] = useState('');
  const [formBranch, setFormBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);

  // 外部来源（如工蜂）：'' = 公开仓
  const [formSourceType, setFormSourceType] = useState('');
  const [sourceProviders, setSourceProviders] = useState<SourceProviderMeta[]>([]);
  /**
   * 弹窗内临时填写的凭据字段值（按 provider.form_fields 动态存）；
   * 仅内存，提交后立即清空，绝不落 localStorage。
   * key = 字段 name（`secret` / `username` / 未来其它）。
   */
  const [formCredential, setFormCredential] = useState<Record<string, string>>({});
  const setCredentialField = (name: string, value: string) =>
    setFormCredential((prev) => ({ ...prev, [name]: value }));

  // Allocate-to-agent dialog state
  const [allocateTarget, setAllocateTarget] = useState<{
    cgId: string;
    repo: string;
    branch: string;
  } | null>(null);
  const [selectedCodeAsset, setSelectedCodeAsset] = useState<{
    cgId: string;
    repo: string;
    branch: string;
  } | null>(null);
  const { activeTeamId, activeTeam } = useTeams();
  const auth = readAuth();
  const currentUser = auth?.user_id ?? '';
  // 固定资产 tab 只列自己 owner 的 agent（与 ChatMemory / Skills 面板一致，
  // 也符合文档 §4.2 权限规则：agent-fixed 只允许查看 caller 自己 owner 的 agent）。
  const { agents: allAgents } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () =>
      allAgents
        .filter((a) => a.owner_user_id === currentUser)
        .map((a) => ({ id: a.agent_id, name: a.name })),
    [allAgents, currentUser],
  );
  // fixed tab 下选中的 agent_id
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [fixedBoundIds, setFixedBoundIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (teamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !teamAgents.some((a) => a.id === agentFilter)) {
      setAgentFilter(teamAgents[0].id);
    }
  }, [teamAgents, agentFilter]);

  const fetchFixedBindings = useCallback(async () => {
    if (!agentFilter) {
      setFixedBoundIds(new Set());
      return;
    }
    try {
      const items = await knowledgeApi.code.agentFixed(agentFilter);
      setFixedBoundIds(new Set(items.map((it) => it.knowledge_id)));
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('code.notify.loadFixedFailed'));
      setFixedBoundIds(new Set());
    }
  }, [agentFilter, t]);

  useEffect(() => {
    if (scopeTab === 'fixed') void fetchFixedBindings();
  }, [scopeTab, fetchFixedBindings]);

  const displaySources = useMemo(() => {
    // inFlight = 刚注册或刚点过「同步」的仓库，其状态由 code.get 轮询实时刷新。
    // 同 id 时以 inFlight 为准覆盖 sources：否则详情头只会显示 202 那一刻
    // teamAssets 快照里的状态，轮询结果永远反映不到界面上。
    if (inFlight.length === 0) return sources;
    const inFlightMap = new Map(inFlight.map((x) => [x.code_graph_id, x]));
    const sourceIds = new Set(sources.map((s) => s.code_graph_id));
    // 还没进 teamAssets 的（刚注册、meta 尚未登记）排在最前占位
    const extras = inFlight.filter((x) => x.code_graph_id && !sourceIds.has(x.code_graph_id));
    return [...extras, ...sources.map((s) => inFlightMap.get(s.code_graph_id) ?? s)];
  }, [sources, inFlight]);

  const scopeSources = useMemo(() => {
    if (scopeTab === 'team') return displaySources;
    if (scopeTab === 'fixed') {
      if (!agentFilter) return [];
      return displaySources.filter(
        (source) => source.code_graph_id && fixedBoundIds.has(source.code_graph_id),
      );
    }
    return displaySources;
  }, [displaySources, scopeTab, agentFilter, fixedBoundIds]);

  // 统计只跟随当前资产范围，避免搜索或状态筛选让概览数据失真。
  const stats = useMemo(
    () => ({
      total: scopeSources.length,
      ready: scopeSources.filter((source) => source.status === 'ready').length,
      processing: scopeSources.filter(
        (source) => source.status === 'pending' || source.status === 'processing',
      ).length,
      totalFiles: scopeSources.reduce((total, source) => total + (source.stats?.files ?? 0), 0),
    }),
    [scopeSources],
  );

  const filteredSources = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return scopeSources.filter((source) => {
      const isProcessing = source.status === 'pending' || source.status === 'processing';
      const isError = source.status === 'failed' || source.status === 'missing';
      if (statusFilter === 'ready' && source.status !== 'ready') return false;
      if (statusFilter === 'processing' && !isProcessing) return false;
      if (statusFilter === 'error' && !isError) return false;
      if (!normalizedKeyword) return true;
      return [
        source.repo_name,
        source.repo_url,
        source.branch,
        source.code_graph_id,
        source.owner_user_id ?? '',
        source.commit_hash ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedKeyword));
    });
  }, [scopeSources, keyword, statusFilter]);

  // Detail: search & explore
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState('');
  const [exploreQuery, setExploreQuery] = useState('');
  const [exploring, setExploring] = useState(false);
  const [exploreResult, setExploreResult] = useState('');

  // 请求序号防竞态：快速切换 tab 时，先发的请求可能后返回，
  // 旧 tab 的数据会覆盖新 tab 的数据。每次 fetch 递增序号，
  // 响应回来时校验序号是否仍是最新，不是就丢弃。
  const fetchSeqRef = useRef(0);

  const fetchSources = useCallback(async () => {
    if (!activeTeamId) {
      setSources([]);
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    // 立即清空旧数据 —— 否则切 tab 时会先看到上一个 tab 的列表，
    // 新数据到了才突然替换，视觉上就是"闪一下"。
    setSources([]);
    try {
      // 资产统一为团队维度（visibility=team），无 private/我的资产概念。
      // fixed tab 也是拿全量 team 资产，再按 fixedBoundIds 过滤。
      const data = await knowledgeApi.code.teamAssets(activeTeamId);
      if (seq !== fetchSeqRef.current) return; // 已被后续请求取代
      setSources(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error(e);
      setSources([]);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [activeTeamId, scopeTab]);

  // 触发 fetchSources：依赖原始参数 + fetchSources，并用 key 去重防止短时间内重复触发。
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    const key = `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchSources();
  }, [activeTeamId, scopeTab, fetchSources]);

  // inFlight 的 ref 镜像：poll 闭包通过 ref 读取最新值，
  // 避免把 inFlight 放进 effect 依赖——否则每次 setInFlight（即使内容不变、
  // 只是数组引用变了）都会重新触发 effect → 立即 poll → 又 setInFlight → 死循环。
  const inFlightRef = useRef<CodeGraphDetail[]>([]);
  inFlightRef.current = inFlight;
  const hasInFlight = inFlight.length > 0;

  useEffect(() => {
    if (!activeTeamId || !hasInFlight) return;
    const poll = async () => {
      const items = inFlightRef.current;
      if (items.length === 0) return;
      const toRemove: string[] = [];
      const updates: CodeGraphDetail[] = [];
      for (const item of items) {
        if (!item.code_graph_id) continue;
        try {
          const detail = await knowledgeApi.code.get(item.code_graph_id);
          if (detail.status === 'ready') {
            try {
              await knowledgeApi.code.registerMeta(activeTeamId, detail.code_graph_id);
            } catch (e: unknown) {
              // 幂等：asset 已存在 / 409 → 忽略；其它真错报出来便于排查
              // （callback S2S 是主力，这里只是兜底，但失败要可见）
              const msg = e instanceof Error ? e.message : String(e);
              if (!/already|exist|409|registered|ok/i.test(msg)) {
                tea.notify.error(t('code.notify.metaFailed', { msg }));
              }
            }
            toRemove.push(detail.code_graph_id);
            void fetchSources();
          } else {
            // 只在状态真正变化时才记录更新，避免无意义的 setInFlight 触发重渲染
            if (detail.status !== item.status) updates.push(detail);
          }
        } catch {
          /* ignore transient poll errors */
        }
      }
      if (toRemove.length > 0 || updates.length > 0) {
        setInFlight((prev) => {
          let next = prev;
          if (toRemove.length > 0) {
            const removeSet = new Set(toRemove);
            next = next.filter((x) => !removeSet.has(x.code_graph_id));
          }
          if (updates.length > 0) {
            const updMap = new Map(updates.map((u) => [u.code_graph_id, u]));
            next = next.map((x) => updMap.get(x.code_graph_id) ?? x);
          }
          return next;
        });
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 8000);
    return () => clearInterval(timer);
  }, [hasInFlight, activeTeamId, fetchSources, t]);

  async function handleUnbindCode(codeGraphId: string) {
    if (!agentFilter) return;
    const ok = await tea.confirm({
      message: t('code.confirm.unbind'),
      description: t('code.confirm.unbind.desc'),
      okText: t('code.confirm.unbind.ok'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.code.unbind(codeGraphId, agentFilter);
      tea.notify.success(t('code.notify.unbound'));
      if (selectedCodeAsset?.cgId === codeGraphId) setSelectedCodeAsset(null);
      await fetchFixedBindings();
      await fetchSources();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('code.notify.unbindFailed'));
    }
  }

  /**
   * 打开注册弹窗时加载来源清单。失败静默降级（表单退化为仅公开仓）。
   *
   * 不再查"当前用户已配置的来源"——凭据挂在**资源**上，注册前无 resource_id，
   * 该概念已不成立；注册后如果失败，用户可在列表页对具体资源重新配置。
   */
  const openRegister = useCallback(async () => {
    setShowRegister(true);
    if (!activeTeamId) return;
    try {
      const providers = await knowledgeApi.source.providers(activeTeamId);
      setSourceProviders(providers);
    } catch {
      setSourceProviders([]);
    }
  }, [activeTeamId]);

  const handleRegister = async () => {
    const repo = formRepo.trim();
    if (!repo || !formBranch.trim() || !activeTeamId) return;
    if (!isValidGitHttpUrl(repo)) {
      tea.notify.error(t('code.register.invalidUrl'));
      return;
    }
    // 私有仓：按 provider.form_fields 校验必填字段
    const provider = sourceProviders.find((p) => p.id === formSourceType);
    if (provider) {
      for (const f of provider.form_fields) {
        if (f.required && !(formCredential[f.name] ?? '').trim()) {
          tea.notify.error(t('code.register.tokenRequired'));
          return;
        }
      }
    }
    setSubmitting(true);
    try {
      // 私有仓：create 时把凭据一并传过去，KS 在入队建图前先落凭据，
      // 避免「create 立即 clone、凭据尚未写入」的时序窗口（否则私有仓必 401）。
      const secret = (formCredential.secret ?? '').trim();
      const username = (formCredential.username ?? '').trim();
      const detail = await knowledgeApi.code.create({
        teamId: activeTeamId,
        repoUrl: repo,
        branch: formBranch.trim(),
        repoName: repo,
        ...(provider && secret
          ? {
              providerId: formSourceType,
              secret,
              ...(username ? { username } : {}),
            }
          : {}),
      });

      setShowRegister(false);
      setFormRepo('');
      setFormBranch('main');
      setFormSourceType('');
      setFormCredential({});
      setScopeTab('team');
      setInFlight((prev) => [
        ...prev.filter((x) => x.code_graph_id !== detail.code_graph_id),
        detail,
      ]);
      tea.notify.info(t('code.notify.registered'));
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSync = async (cgId: string) => {
    try {
      await knowledgeApi.code.sync(cgId);
      // sync 是异步的，202 只代表已入队。这里把该仓库放回 inFlight（与 handleRegister 对齐），
      // 交给上面的 GET 轮询直到 status 回到 ready；否则只会拉一次 teamAssets 快照，
      // 详情头会永远停在那一刻的「构建中」。
      const current =
        sources.find((s) => s.code_graph_id === cgId) ??
        inFlightRef.current.find((x) => x.code_graph_id === cgId);
      if (current) {
        setInFlight((prev) => [
          ...prev.filter((x) => x.code_graph_id !== cgId),
          { ...current, status: 'processing' },
        ]);
      }
      void fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    }
  };

  const handleDelete = async (cgId: string) => {
    const source = sources.find((s) => s.code_graph_id === cgId);
    if (!source) return;
    const ok = await tea.confirm({
      message: t('code.confirm.delete', {
        name: formatRepoName(source.repo_name, source.repo_url),
        branch: source.branch,
      }),
      okText: t('code.action.delete'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.code.delete(cgId);
      // 乐观更新：立即从本地列表移除。后端删除是最终一致的，删除刚成功时再拉 teamAssets
      // 可能仍返回该仓库，导致列表不变、需手动刷新页面才消失。这里先本地摘除，
      // fetchSources 仅作兜底对齐。
      setSources((prev) => prev.filter((x) => x.code_graph_id !== cgId));
      setInFlight((prev) => prev.filter((x) => x.code_graph_id !== cgId));
      if (selectedCodeAsset?.cgId === cgId) setSelectedCodeAsset(null);
      if (selectedCgId === cgId) setSubView('list');
      tea.notify.success(t('code.notify.deleted'));
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    }
  };

  const openDetail = (cgId: string) => {
    setSelectedCgId(cgId);
    setSearchQuery('');
    setSearchResult('');
    setExploreQuery('');
    setExploreResult('');
    setSubView('detail');
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResult('');
    try {
      const res = await knowledgeApi.code.search({ codeGraphId: selectedCgId, query: searchQuery, kind: 'any', limit: 20 });
      setSearchResult(res?.text || JSON.stringify(res, null, 2));
    } catch (e: unknown) {
      setSearchResult('');
      tea.notify.error(e);
    } finally {
      setSearching(false);
    }
  };

  const handleExplore = async () => {
    if (!exploreQuery.trim()) return;
    setExploring(true);
    setExploreResult('');
    try {
      const res = await knowledgeApi.code.explore(selectedCgId, exploreQuery);
      setExploreResult(res?.text || JSON.stringify(res, null, 2));
    } catch (e: unknown) {
      setExploreResult('');
      tea.notify.error(e);
    } finally {
      setExploring(false);
    }
  };

  const selected = displaySources.find((source) => source.code_graph_id === selectedCgId);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    sources,
    displaySources,
    loading,
    scopeTab,
    setScopeTab,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    viewMode,
    setViewMode,
    inFlight,
    setInFlight,
    subView,
    setSubView,
    selectedCgId,
    setSelectedCgId,
    // register
    showRegister,
    setShowRegister,
    formRepo,
    setFormRepo,
    formBranch,
    setFormBranch,
    submitting,
    setSubmitting,
    // 外部来源
    formSourceType,
    setFormSourceType,
    sourceProviders,
    formCredential,
    setCredentialField,
    setFormCredential,
    openRegister,
    // allocate
    allocateTarget,
    setAllocateTarget,
    selectedCodeAsset,
    setSelectedCodeAsset,
    agentFilter,
    setAgentFilter,
    // detail
    searchQuery,
    setSearchQuery,
    searching,
    searchResult,
    setSearchResult,
    exploreQuery,
    setExploreQuery,
    exploring,
    exploreResult,
    setExploreResult,
    selected,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    handleUnbindCode,
    handleRegister,
    handleSync,
    handleDelete,
    openDetail,
    handleSearch,
    handleExplore,
    // computed
    scopeSources,
    stats,
    filteredSources,
  };
}

export type CodeSourcesStore = ReturnType<typeof useCodeSources>;
