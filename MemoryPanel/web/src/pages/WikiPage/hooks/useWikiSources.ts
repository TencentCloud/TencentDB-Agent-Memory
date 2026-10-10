/**
 * useWikiSources —— Wiki 资产页的全部状态与数据逻辑。
 * 组件层只保留 JSX 渲染，状态 / 数据逻辑集中在此。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knowledgeApi, wikiProgressPercent, wikiStageLabel, type GraphData, type WikiDetail, type WikiPage, type SourceProviderMeta, type WikiCrawlOptions, type WikiSourceListResult } from '@/lib/api/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import { findExistingRawFilenames, formatOverwriteFilenames } from '../utils/wiki-upload-utils';
import { type DetailTab, type SearchResult, type StatusFilter, type SubView, type ViewMode, type WikiScopeTab } from '../constants/wiki-constants';

export function useWikiSources() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<WikiDetail[]>([]);
  const [loading, setLoading] = useState(false);
  // 默认展示 Agent 资产（fixed），避免用户误以为自己的资产在「团队资产」里
  const [scopeTab, setScopeTab] = useState<WikiScopeTab>('fixed');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [subView, setSubView] = useState<SubView>('list');
  const [selectedWikiId, setSelectedWikiId] = useState('');

  // Create wiki
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const uploadInFlightRef = useRef(false);

  // Allocate-to-agent
  const [allocateTarget, setAllocateTarget] = useState<{ wiki_id: string; name: string } | null>(
    null,
  );
  const [fixedBoundIds, setFixedBoundIds] = useState<Set<string>>(new Set());
  const { activeTeamId, activeTeam } = useTeams();
  // 「可配置范围」tab 需要当前用户身份；改用 team role 判定。
  const auth = readAuth();
  const currentUser = auth?.user_id ?? '';
  // 固定资产 tab 只列自己 owner 的 agent（与 ChatMemory / Skills 面板一致，
  // 也符合文档 §4.2 权限规则：agent-fixed 只允许查看 caller 自己 owner 的 agent）。
  // 之前用 readActiveTeamAgents 返回全量 team agent，导致用户能看到别人的 agent。
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

  // ── 外部来源（iWiki 等）注册流程 ──
  // '' = 本地上传（不走外部来源，直接上传文件）
  const [formSourceType, setFormSourceType] = useState<string>('');
  const [sourceProviders, setSourceProviders] = useState<SourceProviderMeta[]>([]);
  /**
   * 弹窗内临时填写的凭据（按 provider.form_fields 动态存）；
   * 仅内存，提交后立即清空，绝不落 localStorage。
   */
  const [formCredential, setFormCredential] = useState<Record<string, string>>({});
  const setCredentialField = (name: string, value: string) =>
    setFormCredential((prev) => ({ ...prev, [name]: value }));

  const [formSourceUrl, setFormSourceUrl] = useState<string>('');
  /**
   * 遍历策略：tree=遍历子文档，links=遍历文本超链接。
   * 固定默认 'tree' —— UI 不暴露「跟随来源」选项，未手动切换时也按 tree 走，
   * 与 iWiki 的 defaultCrawlMode 一致，避免"看起来没选"实则走 provider 兜底。
   */
  const [crawlMode, setCrawlMode] = useState<WikiCrawlOptions['mode']>('tree');
  // links 策略的最大遍历深度：固定 1（只取入口页直接链接到的文档），UI 不暴露该选项。
  const CRAWL_MAX_DEPTH = 1;
  /** 该 wiki 是否已在 KS 存过凭据（决定详情页要不要弹令牌填写页）。 */
  const [credConfigured, setCredConfigured] = useState(false);
  const [savingCred, setSavingCred] = useState(false);
  const [fetchingTree, setFetchingTree] = useState(false);
  const [treeResult, setTreeResult] = useState<WikiSourceListResult | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  /** 外部来源流程中刚创建的 wiki_id（列树 / 导入都用它）。 */
  const [pendingWikiId, setPendingWikiId] = useState<string>('');

  /** 打开创建弹窗时拉取已启用的 wiki 来源。 */
  const openCreate = async () => {
    setShowCreate(true);
    setFormSourceType('');
    setFormCredential({});
    setFormSourceUrl('');
    setTreeResult(null);
    setSelectedPageIds([]);
    if (!activeTeamId) return;
    try {
      const items = await knowledgeApi.source.wikiProviders(activeTeamId);
      setSourceProviders(items);
    } catch {
      setSourceProviders([]);
    }
  };

  /** 拉取远端文档树。wikiId 省略 → 用新建流程的 pendingWikiId。 */
  const fetchWikiTree = async (wikiId?: string, crawl?: WikiCrawlOptions) => {
    const target = wikiId ?? pendingWikiId;
    if (!activeTeamId || !formSourceType || !formSourceUrl.trim() || !target) return;
    setFetchingTree(true);
    try {
      const res = await knowledgeApi.source.wikiList({
        teamId: activeTeamId,
        wikiId: target,
        sourceUrl: formSourceUrl.trim(),
        providerId: formSourceType,
        ...(crawl ?? (crawlMode ? { crawl: { mode: crawlMode, maxDepth: CRAWL_MAX_DEPTH } } : {})),
      });
      setTreeResult(res);
      // 默认全选非目录节点
      setSelectedPageIds(res.pages.filter((p) => !p.isDir).map((p) => p.externalId));
    } catch (e: unknown) {
      tea.notify.error(e);
      setTreeResult(null);
    } finally {
      setFetchingTree(false);
    }
  };

  /** 导入选中的文档（拉取 + 写盘，不触发 ingest）。wikiId 省略 → 用 pendingWikiId。 */
  const importWikiPages = async (wikiId?: string) => {
    const target = wikiId ?? pendingWikiId;
    if (!activeTeamId || !formSourceType || !formSourceUrl.trim() || !target) return;
    setImporting(true);
    try {
      await knowledgeApi.source.wikiImport({
        teamId: activeTeamId,
        wikiId: target,
        sourceUrl: formSourceUrl.trim(),
        providerId: formSourceType,
        pageIds: selectedPageIds,
      });
      // 关闭弹窗并清空外部来源临时状态
      setShowCreate(false);
      setShowAddDoc(false);
      setFormSourceUrl('');
      setTreeResult(null);
      setSelectedPageIds([]);
      setFormCredential({});
      setPendingWikiId('');
      fetchSources();
      // 与手工上传对齐：导入只写原始文档，抽取交由用户选择
      // 「开始抽取」或「稍后处理」，避免用户不知道还需手动抽取。
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setImporting(false);
    }
  };

  /**
   * 打开「添加文档」弹窗时预拉 wiki 来源列表（详情页外部来源 tab 用）。
   * 与 openCreate 的差异：不清空外部来源表单（用户可能在已创建的 wiki 里直接切 tab）。
   */
  const loadWikiProviders = async () => {
    if (!activeTeamId) return;
    try {
      setSourceProviders(await knowledgeApi.source.wikiProviders(activeTeamId));
    } catch {
      setSourceProviders([]);
    }
  };

  /**
   * 详情页「添加」入口：按 wiki_id 查凭据状态（设计 §3.1 ②）。
   *
   * 已有凭据 → 直接拉文档树（不再要求用户重填令牌）；
   * 无凭据   → 留在填写页，等用户填完令牌由 ensureCredential 落库。
   *
   * 来源地址从 wiki 落库的 source_url 回填：已有 wiki 不必重填，用户可改。
   */
  const openAddDocExternal = async (wiki: WikiDetail) => {
    if (!activeTeamId) return;
    setAddDocTab('external');
    // 用落库的来源回填（可改），避免已有 wiki 让用户重填
    if (wiki.source_type) setFormSourceType(wiki.source_type);
    if (wiki.source_url) setFormSourceUrl(wiki.source_url);
    setSelectedPageIds([]);
    setTreeResult(null);
    try {
      setSourceProviders(await knowledgeApi.source.wikiProviders(activeTeamId));
    } catch {
      setSourceProviders([]);
    }
    if (!wiki.source_type) return;
    try {
      const cred = await knowledgeApi.source.credentialStatus({
        teamId: activeTeamId,
        resourceType: 'wiki',
        resourceId: wiki.wiki_id,
      });
      setCredConfigured(!!cred);
      // 已配凭据且地址已落库 → 直接列树，跳过令牌填写
      if (cred && wiki.source_url) {
        await fetchWikiTree(wiki.wiki_id);
      }
    } catch {
      setCredConfigured(false);
    }
  };

  /**
   * 详情页外部来源：保存令牌到 KS（按 wiki_id 落库），成功后立即列树。
   *
   * 必须先存凭据再拉树 —— KS 侧 /list 是从 credentialStore 读令牌的，
   * 不先存就是 401 NEED_CREDENTIAL（这正是之前"填了令牌也没用"的根因）。
   */
  const ensureCredential = async (wikiId: string) => {
    if (!activeTeamId || !formSourceType) return false;
    const provider = sourceProviders.find((p) => p.id === formSourceType);
    if (!provider) return false;
    const secret = (formCredential.secret ?? '').trim();
    if (!secret) {
      tea.notify.error(t('code.register.tokenRequired'));
      return false;
    }
    setSavingCred(true);
    try {
      await knowledgeApi.source.credentialPut({
        teamId: activeTeamId,
        resourceType: 'wiki',
        resourceId: wikiId,
        providerId: provider.id,
        credKind: provider.auth_method,
        secret,
        ...((formCredential.username ?? '').trim()
          ? { username: (formCredential.username ?? '').trim() }
          : {}),
      });
      setCredConfigured(true);
      // 提交后立刻清空内存里的明文令牌，不留在前端状态
      setFormCredential({});
      await fetchWikiTree(wikiId);
      return true;
    } catch (e: unknown) {
      tea.notify.error(e);
      return false;
    } finally {
      setSavingCred(false);
    }
  };

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
      const items = await knowledgeApi.wiki.agentFixed(agentFilter);
      setFixedBoundIds(new Set(items.map((it) => it.knowledge_id)));
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('wiki.notify.loadFixedFailed'));
      setFixedBoundIds(new Set());
    }
  }, [agentFilter]);

  useEffect(() => {
    if (scopeTab === 'fixed') void fetchFixedBindings();
  }, [scopeTab, fetchFixedBindings]);

  // 按归属 tab 过滤
  const scopeSources = useMemo(() => {
    if (scopeTab === 'team') return sources;
    if (scopeTab === 'fixed') {
      if (!agentFilter) return [];
      return sources.filter((source) => source.wiki_id && fixedBoundIds.has(source.wiki_id));
    }
    return sources;
  }, [sources, scopeTab, agentFilter, fixedBoundIds]);

  // 统计只受资产范围影响，避免搜索或状态筛选让概览数据失真。
  const stats = useMemo(
    () => ({
      total: scopeSources.length,
      ready: scopeSources.filter((source) => source.status === 'ready').length,
      processing: scopeSources.filter(
        (source) => source.status === 'pending' || source.status === 'processing',
      ).length,
      totalPages: scopeSources.reduce((sum, source) => sum + (source.page_count ?? 0), 0),
    }),
    [scopeSources],
  );

  const filteredSources = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return scopeSources.filter((source) => {
      const isProcessing = source.status === 'pending' || source.status === 'processing';
      if (statusFilter === 'ready' && source.status !== 'ready') return false;
      if (statusFilter === 'processing' && !isProcessing) return false;
      if (!normalizedKeyword) return true;
      return (
        source.name.toLowerCase().includes(normalizedKeyword) ||
        source.wiki_id.toLowerCase().includes(normalizedKeyword) ||
        (source.owner_user_id ?? '').toLowerCase().includes(normalizedKeyword)
      );
    });
  }, [scopeSources, keyword, statusFilter]);

  /** 用户点「清除」后隐藏进度卡片；再次提交或切换 wiki 时复位。 */
  const [ingestCardCleared, setIngestCardCleared] = useState(false);
  /** 最近一次轮询拿到 KS 真值的时间 —— 加工中展示"最近更新"，让用户确认进度在动。 */
  const [pollAt, setPollAt] = useState('');
  /** 本轮轮询的检查次数（每次成功轮询 +1），展示"第 N 次检查 / 已实际查询 N 次"。 */
  const [pollCount, setPollCount] = useState(0);
  /**
   * 已提交、但新任务尚未真正开跑（还没进入 processing）的 wiki id 集合。
   *
   * 这是「只显示最后一次提交的状态」的关键屏蔽：提交后到新任务被 dequeue
   * 之前，wiki 行上仍是上一个任务写下的状态（可能是 ready/failed）。若不加
   * 屏蔽，前端会把上一个任务的终态漏给用户 —— 表现为"刚提交却显示就绪""显示
   * 前一个任务的完成页数"等中间态。
   *
   * 处于该集合时：终态一律当作"加工中"展示（沿用 KS 的加工中文案与进度），
   * 直到轮询看到该 wiki 真正进入 processing（新任务已接管）后解除。
   */
  const [pendingTakeover, setPendingTakeover] = useState<Set<string>>(new Set());

  // Detail view state（Wiki 详情：图谱 / 页面 / 搜索 Tab）
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedPage, setSelectedPage] = useState<WikiPage | null>(null);
  const [readContent, setReadContent] = useState('');
  const [readLoading, setReadLoading] = useState(false);
  const [pageTypeFilter, setPageTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Add doc（添加文档：文件 / 粘贴 markdown / 外部来源）
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [addDocTab, setAddDocTab] = useState<'file' | 'markdown' | 'external'>('file');
  // 批量 markdown：每条 { filename, content }，可增删
  const [mdDocs, setMdDocs] = useState<Array<{ filename: string; content: string }>>([
    { filename: '', content: '' },
  ]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Fetch ---
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
    // 切 team 时静默刷新（保留旧列表直到新数据到达），不闪空不骨架屏；
    // 切 tab 仍清空 + loading（避免看到上一个 tab 的列表）。
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    if (!teamChanged) {
      setLoading(true);
      // 立即清空旧数据 —— 否则切 tab 时会先看到上一个 tab 的列表，
      // 新数据到了才突然替换，视觉上就是"闪一下"。
      setSources([]);
    }
    try {
      // 资产统一为团队维度（visibility=team），无 private/我的资产概念。
      // fixed tab 也是拿全量 team 资产，再按 fixedBoundIds 过滤。
      const d = await knowledgeApi.wiki.teamAssets(activeTeamId);
      if (seq !== fetchSeqRef.current) return; // 已被后续请求取代
      setSources(Array.isArray(d) ? d : []);
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

  // 切 team 时退出详情并清掉旧 wiki 的本地态，避免仍展示上一个 team 的页面/图谱/正文。
  const prevTeamIdRef = useRef(activeTeamId);
  useEffect(() => {
    if (prevTeamIdRef.current === activeTeamId) return;
    prevTeamIdRef.current = activeTeamId;
    setSubView('list');
    setSelectedWikiId('');
    setActiveTab('overview');
    setSelectedPage(null);
    setSearchQuery('');
    setSearchResults([]);
    setPageTypeFilter('all');
    setPages([]);
    setGraphData(null);
    setReadContent('');
    setShowAddDoc(false);
  }, [activeTeamId]);

  const fetchDetail = useCallback(async (wikiId: string) => {
    setGraphLoading(true);
    // 两个子请求各自兜底，外层 catch 抓不到；用标志位感知任一失败后统一提示，
    // 避免加载失败时详情页静默空白、用户无从判断。
    let hadError = false;
    try {
      const [g, p] = await Promise.all([
        knowledgeApi.wiki.graph(wikiId).catch(() => {
          hadError = true;
          return null;
        }),
        knowledgeApi.wiki.pages(wikiId).catch(() => {
          hadError = true;
          return [];
        }),
      ]);
      setGraphData(g);
      setPages(Array.isArray(p) ? p : (p as { pages?: WikiPage[] } | null)?.pages || []);
    } finally {
      setGraphLoading(false);
    }
    if (hadError) tea.notify.error(t('wiki.notify.loadDetailFailed'));
  }, []);

  const runningWikiKey = useMemo(
    () =>
      sources
        .filter((s) => s.status === 'pending' || s.status === 'processing')
        .map((s) => `${s.wiki_id}:${s.status}:${s.internal_status ?? ''}`)
        .join('|'),
    [sources],
  );

  useEffect(() => {
    const running = sources.filter(
      (s) =>
        s.wiki_id &&
        // 除了 pending/processing，还要覆盖"已提交但新任务尚未接管"的 wiki：
        // 它表面上是终态（上一个任务留下的），实际还有新任务在排队，必须继续
        // 轮询才能观察到新任务真正开跑的时刻。
        (s.status === 'pending' || s.status === 'processing' || pendingTakeover.has(s.wiki_id)),
    );
    if (running.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      const items = await Promise.all(
        running.map(async (s) => {
          try {
            return await knowledgeApi.wiki.get(s.wiki_id);
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const map = new Map(items.filter(Boolean).map((w) => [w!.wiki_id, w!]));
      setSources((prev) =>
        prev.map((s) => (map.get(s.wiki_id) ? { ...s, ...map.get(s.wiki_id)! } : s)),
      );
      // 新任务真正开跑（processing）→ 解除该 wiki 的屏蔽，之后就展示它的真实进度。
      setPendingTakeover((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set(prev);
        for (const w of map.values()) {
          if (w && next.has(w.wiki_id) && w.status === 'processing') {
            next.delete(w.wiki_id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // 每次成功轮询递增检查计数 + 记录时间 —— 进度卡片据此展示
      // "第 N 次检查：…"与"已实际查询 N 次，最近 HH:MM:SS"，让用户确认进度在动。
      setPollCount((n) => n + 1);
      setPollAt(new Date().toLocaleTimeString());
      if (selectedWikiId && map.has(selectedWikiId)) {
        const d = map.get(selectedWikiId)!;
        if (d.status === 'ready' || d.status === 'failed') void fetchDetail(selectedWikiId);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runningWikiKey, selectedWikiId, fetchDetail]);

  /**
   * 详情页进度卡片的会话阶段机（纯派生，不引入独立数据源）。
   *
   * - sources 里当前 wiki 变成 pending/processing → 'active'
   * - 会话中曾 'active'，之后看到终态 → 停在 'done'（显示结果直到用户清除）
   * - 进入详情页时 wiki 已是终态且本会话没见过 active → 'idle'（不显示卡片）
   */
  const prevSessionRef = useRef<'idle' | 'active' | 'done'>('idle');
  const displayIngestState = useMemo(() => {
    const wiki = sources.find((s) => s.wiki_id === selectedWikiId);
    const name = wiki?.name ?? '';
    const rawStatus = wiki?.status ?? 'draft';
    /**
     * 屏蔽"上一个任务留下的终态"：已提交但新任务尚未接管（pendingTakeover）
     * 时，wiki 行上的 ready/failed 属于上一个任务，绝不能展示给用户。
     * 这段时间一律按"加工中"呈现（沿用 KS 的加工中文案与档位进度），
     * 直到新任务真正进入 processing 解除屏蔽、展示它的真实进度。
     */
    const awaitingTakeover = selectedWikiId ? pendingTakeover.has(selectedWikiId) : false;
    const staleTerminal =
      awaitingTakeover && (rawStatus === 'ready' || rawStatus === 'failed');
    const status = staleTerminal ? 'processing' : rawStatus;
    // 陈旧终态不展示上一个任务的 internal_status / page_count（那属于旧任务）
    const internalStatus = staleTerminal ? null : (wiki?.internal_status ?? null);
    const pageCount = staleTerminal ? null : (wiki?.page_count ?? null);

    const inFlight = status === 'pending' || status === 'processing';
    const isTerminal = status === 'ready' || status === 'failed';
    // 会话迁移：active → （终态）→ done。
    // 注：ready 之后进度卡片会自动收起（终态由标题栏徽章 + 页数体现），
    // session 主要用于 failed —— 出错原因要显式告知，故保留到用户点「清除」。
    const session =
      inFlight ? 'active'
      : isTerminal && prevSessionRef.current === 'active' ? 'done'
      : isTerminal && prevSessionRef.current === 'done' ? 'done'
      : 'idle';
    if (session !== prevSessionRef.current) prevSessionRef.current = session;

    const stage = wikiStageLabel(status as WikiDetail['status'], internalStatus);
    const pageHint =
      typeof pageCount === 'number' && pageCount > 0
        ? t('wiki.ingest.currentPage', { count: pageCount })
        : '';

    // 加工中的文案必须带"第 N 次检查"与页数提示 —— 这是用户判断"进度真的在动"
    // 的唯一依据，任何重构都不得省略 attempt / pageHint 模板参数（历史回归教训）。
    //
    // pending / draft 同样按正常阶段文案展示（"扫描文件"档位），不再自造
    // "排队中，等待上一次任务让位"之类文案 —— 状态行只描述 KS 真实状态。
    let detail: string;
    if (status === 'ready') {
      detail = t('wiki.ingest.done', { count: pageCount ?? 0 });
    } else if (status === 'failed') {
      detail = wiki?.sync_error || t('wiki.ingest.failed');
    } else {
      detail = t('knowledgeApi.ingest.check', { attempt: Math.max(pollCount, 1), stage, pageHint });
    }

    return {
      active: session === 'active',
      /** 'done' 会话 = 本会话内观察到"加工中 → 终态"迁移，仍展示结果卡片。 */
      session,
      /** 屏蔽后的展示状态 —— 徽章与卡片共用，保证两者永远一致。 */
      status: status as WikiDetail['status'],
      wikiId: selectedWikiId,
      wiki: name,
      currentFile: '',
      detail,
      done: wikiProgressPercent(status as WikiDetail['status'], internalStatus),
      total: 100,
      checkCount: session === 'active' ? pollCount : 0,
      lastCheckedAt: session === 'active' ? pollAt : '',
      log: [] as { file: string; status: 'error' | 'done'; error?: string }[],
    };
  }, [sources, selectedWikiId, pollAt, pollCount, pendingTakeover]);

  async function handleUnbindWiki(wikiId: string) {
    if (!agentFilter) return;
    await confirmThenRun(
      {
        message: t('wiki.confirm.unbind'),
        description: t('wiki.confirm.unbind.desc'),
        okText: t('wiki.confirm.unbind.ok'),
      },
      async () => {
        await knowledgeApi.wiki.unbind(wikiId, agentFilter);
        tea.notify.success(t('wiki.notify.unbound'));
        if (selectedWikiId === wikiId) setSelectedWikiId('');
        await fetchFixedBindings();
        await fetchSources();
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.unbindFailed')),
    );
  }

  // --- Handlers ---
  const handleCreate = async () => {
    if (!newName.trim() || !activeTeamId) return;

    // 外部来源：校验必填凭据字段
    const provider = sourceProviders.find((p) => p.id === formSourceType);
    if (provider) {
      for (const f of provider.form_fields) {
        if (f.required && !(formCredential[f.name] ?? '').trim()) {
          tea.notify.error(t('code.register.tokenRequired'));
          return;
        }
      }
      if (!formSourceUrl.trim()) {
        tea.notify.error(t('wiki.register.sourceUrl'));
        return;
      }
    }

    setSubmitting(true);
    try {
      const detail = await knowledgeApi.wiki.create(
        activeTeamId,
        newName.trim(),
        provider ? formSourceUrl.trim() : undefined,
        provider ? formSourceType : undefined,
      );

      // 外部来源：只保存凭据，**不在此处拉取文档列表**。
      // 拉取放到详情页「添加」里按需触发，新建流程与手工新建保持一致
      // （建完即关闭），避免每次新建都被迫等待整棵文档树。
      if (provider) {
        const secret = (formCredential.secret ?? '').trim();
        const username = (formCredential.username ?? '').trim();
        await knowledgeApi.source.credentialPut({
          teamId: activeTeamId,
          resourceType: 'wiki',
          resourceId: detail.wiki_id,
          providerId: provider.id,
          credKind: provider.auth_method,
          secret,
          ...(username ? { username } : {}),
        });
        // 提交后立刻清空内存里的明文令牌
        setFormCredential({});
      }

      tea.notify.success(t('wiki.notify.created', { name: newName.trim() }));
      setShowCreate(false);
      setNewName('');
      setFormSourceUrl('');
      setTreeResult(null);
      setSelectedPageIds([]);
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  /** 所有正在 ingest（pending / processing）的 wiki_id 集合，用于列表中逐卡片判断按钮状态。 */
  const runningWikiIds = useMemo(
    () =>
      new Set(
        sources
          .filter((s) => s.status === 'pending' || s.status === 'processing')
          .map((s) => s.wiki_id),
      ),
    [sources],
  );
  /**
   * 当前详情页这个 wiki 自身是否正在抽取（pending / processing）。
   *
   * 用于顶栏「导入文档」按钮的禁用判定：只关心**当前 wiki**，不因其它
   * 知识库在跑就被连带禁用。
   *
   * 背景（设计 2026-09-21 §3.3）：KS 侧是 per-wiki SerialQueue（不同 wiki
   * 各自独立队列、天然可并行），且同 wiki 重跑由 onBusy:'replace' 安全切换
   * （取消旧任务 + 排队新任务）。因此原先"同一时间只允许一个 Wiki 提取"的
   * 全局互斥（基于不带 wikiId 过滤的 runningWiki）已不再必要，反而会误伤
   * 无关知识库的导入入口。
   *
   * 注意：displayIngestState / ingestBusy 仍保持全局语义 —— 顶部进度条需要
   * 在页面刷新后恢复**任意**在跑 wiki 的进度（stateRecovery），不能收窄。
   */
  const isCurrentWikiIngesting = (wikiId: string): boolean => {
    if (!wikiId) return false;
    const self = sources.find(
      (s) => s.wiki_id === wikiId && (s.status === 'pending' || s.status === 'processing'),
    );
    return !!self;
  };

  /**
   * 导入并抽取（设计 2026-09-21 合并入口）。
   *
   * 一次复合请求完成"写 raw + 触发 ingest"；打断旧任务由 Panel/KS 的
   * onBusy:'replace' 在后台完成，用户不可感知（无 confirm、无 Alert）。
   *
   * 本函数不自己轮询进度 —— 提交后立即 fetchSources 拿到新状态（KS 真值，
   * pending/processing），由 runningWikiKey 轮询 effect 接管后续刷新。
   */
  const submitAddAndIngest = async (params: {
    wikiId: string;
    mode: 'files' | 'markdown' | 'external' | 'reingest';
    files?: { filename: string; content: string }[];
    markdown?: { filename: string; content: string }[];
    source_url?: string;
    provider_id?: string;
    page_ids?: string[];
  }): Promise<void> => {
    const { wikiId, mode } = params;
    if (!wikiId) return;

    // 提交即进入新一轮：复位"已清除"标记让卡片重新出现，
    // 并把检查计数清零——否则第二次导入会接着上一次的数字往下数。
    setIngestCardCleared(false);
    setPollCount(0);
    setPollAt('');
    // 屏蔽"上一个任务留下的终态"：从现在起直到新任务真正进入 processing，
    // 该 wiki 上任何 ready/failed 都视为陈旧值、不展示给用户。
    setPendingTakeover((prev) => {
      const next = new Set(prev);
      next.add(wikiId);
      return next;
    });

    try {
      const res = await knowledgeApi.wiki.importAndIngest({
        wiki_id: wikiId,
        mode,
        ...(params.files ? { files: params.files } : {}),
        ...(params.markdown ? { markdown: params.markdown } : {}),
        ...(params.source_url ? { source_url: params.source_url } : {}),
        ...(params.provider_id ? { provider_id: params.provider_id } : {}),
        ...(params.page_ids ? { page_ids: params.page_ids } : {}),
      });

      // 复合请求已回执：无论成功与否都可能改动 raw。
      // fetchSources 拉回新状态（pending/processing）—— sources 是唯一真相源，
      // runningWikiKey 轮询 effect 会据它自动启动 2s 轮询直到终态。
      setRawRefreshKey((k) => k + 1);
      await fetchSources();

      if (!res.ok) {
        const msg = res.error_message || t('wiki.notify.ingestFailed');
        tea.notify.error(msg);
        fetchDetail(wikiId);
        return;
      }

      // 触发一次立即刷新，避免等下一拍轮询才反映新状态
      fetchDetail(wikiId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      tea.notify.error(msg);
      setRawRefreshKey((k) => k + 1);
      fetchDetail(wikiId);
    }
  };

  const handleIngest = async (wikiId: string) => {
    if (!wikiId) return;
    // 列表页 ingest 只做抽取，与详情页「导入文档」Modal 在"三 tab 全空"时的
    // 「重新抽取」路径完全一致：走同一个复合端点 import-and-ingest
    // （mode: 'reingest'），由 KS 的 onBusy:'replace' 原子完成"取消旧任务 +
    // 排队新任务"。
    await submitAddAndIngest({ wikiId, mode: 'reingest' });
  };

  const handleDelete = async (wikiId: string, name: string) => {
    await confirmThenRun(
      {
        message: t('wiki.confirm.delete', { name }),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.delete(wikiId);
        if (selectedWikiId === wikiId) setSubView('list');
        fetchSources();
      },
    );
  };

  const openDetail = (wikiId: string) => {
    setSelectedWikiId(wikiId);
    setActiveTab('overview');
    setSelectedPage(null);
    setSearchQuery('');
    setSearchResults([]);
    setPageTypeFilter('all');
    // 切换到另一个 wiki 详情时，必须清空上一个 wiki 的详情级数据（页面列表 / 图谱 / 已读正文）。
    // 否则新 wiki 的 fetchDetail 返回前，概览/图谱/页面 tab 会一闪而过上一个 wiki 的内容。
    setPages([]);
    setGraphData(null);
    setReadContent('');
    setSubView('detail');
    fetchDetail(wikiId);
  };

  const handleReadPage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    // 切换页面时先清空旧内容再进入 loading —— 否则派生的 metadata（来自 readContent）
    // 会在新内容返回前残留上一个文档的标签，视觉上就是"闪一下旧文档"。
    setSelectedPage(page);
    setReadContent('');
    setReadLoading(true);
    try {
      const r = await knowledgeApi.wiki.read(
        selectedWikiId,
        (page as { id?: string }).id || page.path,
      );
      setReadContent(r?.content || '');
    } catch (e: unknown) {
      setReadContent('');
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('wiki.notify.readPageFailed'));
    } finally {
      setReadLoading(false);
    }
  };

  const handleDeletePage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    const ref = (page as { id?: string }).id || page.path;
    await confirmThenRun(
      {
        message: t('wiki.confirm.deletePage', { name: page.title || ref }),
        description: t('wiki.confirm.deletePage.desc'),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.pageDelete(selectedWikiId, [ref]);
        tea.notify.success(t('wiki.notify.pageDeleted'));
        if (selectedPage && ((selectedPage as { id?: string }).id || selectedPage.path) === ref) {
          setSelectedPage(null);
          setReadContent('');
        }
        await fetchDetail(selectedWikiId);
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.pageDeleteFailed')),
    );
  };

  const handleDeleteRaw = async (filename: string) => {
    if (!selectedWikiId) return;
    await confirmThenRun(
      {
        message: t('wiki.confirm.deleteRaw', { name: filename }),
        description: t('wiki.confirm.deleteRaw.desc'),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.rawDelete(selectedWikiId, [filename]);
        tea.notify.success(t('wiki.notify.rawDeleted'));
        if (selectedPage?.path === `raw/${filename}`) {
          setSelectedPage(null);
          setReadContent('');
        }
        await fetchDetail(selectedWikiId);
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.rawDeleteFailed')),
    );
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !selectedWikiId) return;
    setSearching(true);
    try {
      const r = await knowledgeApi.wiki.search(selectedWikiId, searchQuery, 20);
      setSearchResults((r as { results?: SearchResult[] }).results || []);
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSearching(false);
    }
  };

  // 原始文档列表刷新信号：RawFilesSection 维护自己独立的 state，只在 wikiId 变化时重载；
  // 上传成功后 fetchDetail 只刷新 pages/graph，不会触发它重拉。递增此 key 强制其 reload。
  const [rawRefreshKey, setRawRefreshKey] = useState(0);

  const confirmOverwrite = async (filenames: readonly string[]): Promise<boolean> => {
    try {
      const { files } = await knowledgeApi.wiki.rawList(selectedWikiId);
      const existing = findExistingRawFilenames(
        filenames,
        files.map((file) => file.filename),
      );
      if (existing.length === 0) return true;

      return tea.confirm({
        message: t('wiki.detail.overwrite.title', { count: existing.length }),
        description: t('wiki.detail.overwrite.desc', { files: formatOverwriteFilenames(existing) }),
        okText: t('wiki.detail.overwrite.ok'),
        cancelText: t('common.cancel'),
      });
    } catch (e: unknown) {
      tea.notify.error(e instanceof Error ? e : t('wiki.notify.uploadCancelled'));
      return false;
    }
  };


  const handleUploadMdBatch = async () => {
    if (!activeTeamId || !selectedWikiId) return;
    const valid = mdDocs.filter((d) => d.filename.trim() && d.content.trim());
    if (valid.length === 0) return;
    if (uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setSubmitting(true);
    if (!(await confirmOverwrite(valid.map((doc) => doc.filename.trim())))) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    const failures: Array<{ filename: string; error: string }> = [];
    for (const doc of valid) {
      const filename = doc.filename.trim();
      try {
        await knowledgeApi.wiki.upload({ teamId: activeTeamId, wikiId: selectedWikiId, filename, content: doc.content });
      } catch (e: unknown) {
        failures.push({ filename, error: e instanceof Error ? e.message : String(e) });
      }
    }
    uploadInFlightRef.current = false;
    setSubmitting(false);
    if (failures.length === 0) {
      tea.notify.success(t('wiki.detail.upload.success', { count: valid.length }));
      setMdDocs([{ filename: '', content: '' }]);
      setShowAddDoc(false);
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
    } else {
      const okCount = valid.length - failures.length;
      // 每个失败文件都列出原因，最多展示 3 个，超出折叠
      const shown = failures
        .slice(0, 3)
        .map((f) => `${f.filename}: ${f.error}`)
        .join('\n');
      const more = failures.length > 3 ? t('wiki.detail.upload.more', { count: failures.length - 3 }) : '';
      tea.notify.error(t('wiki.detail.upload.partialFail', { ok: okCount, fail: failures.length, detail: `${shown}${more}` }));
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
    }
  };

  // 批量文件上传：支持多选 + 拖拽，并发上传
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, 'pending' | 'done' | 'error'>
  >({});

  const handleBatchUpload = async () => {
    if (!activeTeamId || !selectedWikiId || pendingFiles.length === 0) return;
    if (uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setSubmitting(true);
    if (!(await confirmOverwrite(pendingFiles.map((file) => file.name)))) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    setUploadProgress(Object.fromEntries(pendingFiles.map((f) => [f.name, 'pending'])));
    // 并发上传所有文件
    const results = await Promise.allSettled(
      pendingFiles.map(async (f) => {
        const content = await f.text();
        await knowledgeApi.wiki.upload({ teamId: activeTeamId, wikiId: selectedWikiId, filename: f.name, content });
        setUploadProgress((prev) => ({ ...prev, [f.name]: 'done' }));
      }),
    );
    uploadInFlightRef.current = false;
    setSubmitting(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    if (failed === 0) {
      tea.notify.success(t('wiki.detail.upload.successFiles', { count: succeeded }));
      setPendingFiles([]);
      setUploadProgress({});
      setShowAddDoc(false);
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
      // 文件上传入口此前遗漏了这一步，导致用户上传完成后不知道还需手动抽取。
    } else {
      results.forEach((r, i) => {
        if (r.status === 'rejected')
          setUploadProgress((prev) => ({ ...prev, [pendingFiles[i].name]: 'error' }));
      });
      tea.notify.error(t('wiki.detail.upload.fail', { ok: succeeded, fail: failed }));
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
    }
  };

  // --- Computed ---
  const typeCounts = useMemo(
    () =>
      pages.reduce<Record<string, number>>((a, p) => {
        a[p.type] = (a[p.type] || 0) + 1;
        return a;
      }, {}),
    [pages],
  );
  const types = useMemo(() => Object.keys(typeCounts).sort(), [typeCounts]);
  const filteredPages = useMemo(
    () => (pageTypeFilter === 'all' ? pages : pages.filter((p) => p.type === pageTypeFilter)),
    [pages, pageTypeFilter],
  );
  const edgeCount = graphData?.edges?.length || 0;

  const { displayContent, metadata } = useMemo(() => {
    const text = readContent;
    // Case 1: standard --- fenced frontmatter
    const fenced = text.match(/^---\n([\s\S]*?)\n---\n*/);
    if (fenced) {
      const body = text.slice(fenced[0].length);
      const meta: Record<string, string> = {};
      fenced[1].split('\n').forEach((l) => {
        const [k, ...v] = l.split(':');
        if (k?.trim() && v.length) meta[k.trim()] = v.join(':').trim();
      });
      return { displayContent: body, metadata: Object.keys(meta).length > 0 ? meta : null };
    }
    // Case 2: unfenced frontmatter (type: xxx\ntitle: xxx\n... at the start)
    const lines = text.split('\n');
    const fmLines: string[] = [];
    let i = 0;
    // skip leading blank lines
    while (i < lines.length && !lines[i].trim()) i++;
    // collect key: value lines (must have key at start, no leading whitespace, colon present)
    while (i < lines.length) {
      const line = lines[i];
      if (/^[a-zA-Z_][\w-]*\s*:/.test(line)) {
        fmLines.push(line);
        i++;
      } else {
        break;
      }
    }
    if (fmLines.length >= 2) {
      const meta: Record<string, string> = {};
      fmLines.forEach((l) => {
        const [k, ...v] = l.split(':');
        if (k?.trim() && v.length) meta[k.trim()] = v.join(':').trim();
      });
      // skip blank lines after frontmatter
      while (i < lines.length && !lines[i].trim()) i++;
      return {
        displayContent: lines.slice(i).join('\n'),
        metadata: Object.keys(meta).length > 0 ? meta : null,
      };
    }
    return { displayContent: text, metadata: null };
  }, [readContent]);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    sources,
    loading,
    scopeTab,
    setScopeTab,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    viewMode,
    setViewMode,
    subView,
    setSubView,
    selectedWikiId,
    setSelectedWikiId,
    // create
    showCreate,
    setShowCreate,
    newName,
    setNewName,
    submitting,
    setSubmitting,
    // allocate
    allocateTarget,
    setAllocateTarget,
    fixedBoundIds,
    agentFilter,
    setAgentFilter,
    // detail
    activeTab,
    setActiveTab,
    pages,
    setPages,
    graphData,
    setGraphData,
    graphLoading,
    setGraphLoading,
    ingestCardCleared,
    setIngestCardCleared,
    selectedPage,
    setSelectedPage,
    readContent,
    setReadContent,
    readLoading,
    setReadLoading,
    pageTypeFilter,
    setPageTypeFilter,
    searchQuery,
    setSearchQuery,
    searchResults,
    setSearchResults,
    searching,
    setSearching,
    // add doc
    showAddDoc,
    setShowAddDoc,
    addDocTab,
    setAddDocTab,
    mdDocs,
    setMdDocs,
    pendingFiles,
    setPendingFiles,
    uploadProgress,
    setUploadProgress,
    rawRefreshKey,
    setRawRefreshKey,
    fileInputRef,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    fetchDetail,
    handleUnbindWiki,
    handleCreate,
    // 外部来源（iWiki 等）
    formSourceType,
    setFormSourceType,
    sourceProviders,
    formCredential,
    setFormCredential,
    setCredentialField,
    formSourceUrl,
    setFormSourceUrl,
    treeResult,
    selectedPageIds,
    setSelectedPageIds,
    fetchingTree,
    importing,
    credConfigured,
    crawlMode,
    setCrawlMode,
    savingCred,
    fetchWikiTree,
    importWikiPages,
    loadWikiProviders,
    openAddDocExternal,
    ensureCredential,
    openCreate,
    handleIngest,
    isCurrentWikiIngesting,
    submitAddAndIngest,
    handleDelete,
    openDetail,
    handleReadPage,
    handleDeletePage,
    handleDeleteRaw,
    handleSearch,
    handleUploadMdBatch,
    handleBatchUpload,
    // computed
    scopeSources,
    stats,
    filteredSources,
    typeCounts,
    types,
    filteredPages,
    edgeCount,
    runningWikiIds,
    displayIngestState,
    displayContent,
    metadata,
  };
}

export type WikiSourcesStore = ReturnType<typeof useWikiSources>;
