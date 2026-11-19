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
import {
  findExistingRawFilenames,
  formatOverwriteFilenames,
  readUploadFile,
} from '../utils/wiki-upload-utils';
import { maxBytesForFile } from '../utils/wiki-format-store';
import {
  INGEST_POLL_INTERVAL_MS,
  INITIAL_INGEST_POLL_HEALTH,
  advanceIngestPollHealth,
  ingestPollWindowMinutes,
  shouldReleaseTakeover,
  TAKEOVER_MAX_HOLD_MS,
  type IngestPollPauseReason,
  type TakeoverRecord,
} from '../utils/ingest-poll-policy';
import {
  RAW_PREVIEW_ERROR_KEYS,
  type DetailTab,
  type SearchResult,
  type StatusFilter,
  type SubView,
  type ViewMode,
  type WikiScopeTab,
} from '../constants/wiki-constants';

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
   * 因预算耗尽 / 连续读取失败而**暂停**自动检查的 wiki，值为暂停原因。
   *
   * 暂停只停轮询，不改变状态展示：若此时读到的是真实终态，卡片会按终态渲染
   * （附「重新检查」入口只是为了让用户能主动再拉一次，而不是被无限空转绑架）。
   */
  const [pollPause, setPollPause] = useState<Record<string, IngestPollPauseReason>>({});
  /**
   * `pollPause` 的镜像 ref。
   *
   * 为什么需要：暂停是**立即生效**的语义 —— 判定 timeout 的那一刻就必须停止
   * 发请求。但 `setPollPause` 触发的重渲染与 effect 清理是异步的（React 批处理
   * 下尤其明显），在这段窗口里 setInterval 仍会继续 tick。若只靠 state 过滤，
   * 暂停后还会白白多发若干请求（实测 300 次上限却打出 307 次）。
   * ref 在同一 tick 内即可见，保证"判停即停"。
   */
  const pollPauseRef = useRef<Record<string, IngestPollPauseReason>>({});
  /**
   * 每个 wiki 的轮询预算（ref，不触发渲染）。跨阶段 scanning→ingesting→
   * rebuilding 保留，避免每次 internal_status 变化都重新计数。
   */
  const pollHealthRef = useRef<Map<string, typeof INITIAL_INGEST_POLL_HEALTH>>(new Map());
  /**
   * 每个 wiki 的「resume 版本号」。
   *
   * 场景：用户在 poll 回调已经计算出 `newlyPaused={X:'timeout'}` 但 `setPollPause`
   * 还没 flush 的那短暂窗口里点了「重新检查」—— `resetPollBudget(X)` 会清 ref 并
   * `setPollPause(prev=>去掉 X)`，但 poll 回调里排在队列后的 `setPollPause(prev=>
   * {...prev, X:'timeout'})` 会把 pause 加回来。用户看到 UI 短暂暂停。
   *
   * 修复：resume 时版本号 +1；poll 回调在**读 attempts 之前**记录当前版本，在
   * **写 pause 之前**对比 —— 若版本已变，则本轮 attempts 结果和 pause 判定全部
   * 丢弃（重 arm 的意图比陈旧的预算判定优先）。
   */
  const pollResumeTickRef = useRef<Map<string, number>>(new Map());
  /**
   * 已提交、但新任务尚未被观察到的 wiki。
   *
   * 这是「只显示最后一次提交的状态」的屏蔽：提交后到新任务真正开跑之间，
   * wiki 行上可能仍是上一个任务写下的状态（ready/failed）。若不加屏蔽，前端
   * 会把上一个任务的终态漏给用户 —— 表现为"刚提交却显示就绪"。
   *
   * ⚠️ 历史缺陷（issue #1917）：解除条件曾经只有「轮询采样到 processing」。
   * `processing` 是毫秒级瞬态（重复导入走 sha256 跳过 → 秒级 ready；LLM 未配置
   * → 直接 failed），2s 采样必然错过，于是屏蔽永久残留 → 真实终态被伪装成
   * "加工中"（失败原因看不到）+ 轮询永不停止。
   * 现在改为 `shouldReleaseTakeover(rec, observed, now)`：processing / 读数比
   * 提交前基线更新 / 兜底超时，任一成立即解除。
   */
  const [pendingTakeover, setPendingTakeover] = useState<Map<string, TakeoverRecord>>(
    () => new Map(),
  );
  /**
   * `pendingTakeover` 的镜像 ref。
   *
   * 轮询回调里需要**同步**判断"哪些该解除"（以便同时清掉兜底定时器），
   * 而 state 在闭包里可能是旧值、也不便读。ref 与 state 始终同步维护。
   */
  const takeoverRef = useRef<Map<string, TakeoverRecord>>(new Map());

  /** 统一写入口：同时更新 ref / state / 兜底定时器，避免三处各写一份。 */
  const commitTakeover = useCallback(
    (updater: (prev: Map<string, TakeoverRecord>) => Map<string, TakeoverRecord>) => {
      const next = updater(takeoverRef.current);
      if (next === takeoverRef.current) return next;
      takeoverRef.current = next;
      setPendingTakeover(next);
      return next;
    },
    [],
  );

  /**
   * 屏蔽的兜底解除定时器（per wiki）。
   *
   * 为什么需要真定时器，而不只靠渲染期判超时：一旦轮询停止（终态、或 network
   * 暂停、或用户离开详情页），就不会再有 setState 驱动重渲染，渲染期的超时判断
   * 永远得不到执行 —— 屏蔽又会变成"不可达退出条件"。这里在**提交时**就挂一个
   * 定时器，到点无条件解除，保证任何路径下都不会永久屏蔽。
   */
  const takeoverTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /** 解除若干 wiki 的屏蔽，并清掉各自的兜底定时器。 */
  const releaseTakeover = useCallback(
    (wikiIds: readonly string[]) => {
      if (wikiIds.length === 0) return;
      for (const id of wikiIds) {
        const timer = takeoverTimersRef.current.get(id);
        if (timer !== undefined) {
          clearTimeout(timer);
          takeoverTimersRef.current.delete(id);
        }
      }
      commitTakeover((prev) => {
        if (!wikiIds.some((id) => prev.has(id))) return prev;
        const next = new Map(prev);
        for (const id of wikiIds) next.delete(id);
        return next;
      });
    },
    [commitTakeover],
  );

  /**
   * 登记一次屏蔽，并挂上兜底定时器（到点无条件解除）。
   *
   * 定时器是"绝不永久屏蔽"的最终保证：即使之后轮询停止（终态 / 暂停 / 用户切走）
   * 导致不再有重渲染，兜底时间一到 UI 也必须回到真实状态。
   */
  const armTakeover = useCallback(
    (wikiId: string, baselineUpdatedAt: string) => {
      commitTakeover((prev) => {
        const next = new Map(prev);
        next.set(wikiId, { baselineUpdatedAt, submittedAt: Date.now() });
        return next;
      });
      const existing = takeoverTimersRef.current.get(wikiId);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        takeoverTimersRef.current.delete(wikiId);
        commitTakeover((prev) => {
          if (!prev.has(wikiId)) return prev;
          const next = new Map(prev);
          next.delete(wikiId);
          return next;
        });
      }, TAKEOVER_MAX_HOLD_MS);
      takeoverTimersRef.current.set(wikiId, timer);
    },
    [commitTakeover],
  );

  // 卸载时清掉所有兜底定时器（避免测试/热重载下的 timer 泄漏）
  useEffect(() => {
    const timers = takeoverTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  /** 清除某 wiki 的预算与暂停标记（提交新任务 / 手动重新检查时调用）。 */
  const resetPollBudget = useCallback((wikiId: string) => {
    pollHealthRef.current.delete(wikiId);
    // Bump resume 版本：挤掉 poll 回调里排在本次 reset 之后 flush 的陈旧 pause 写入。
    pollResumeTickRef.current.set(
      wikiId,
      (pollResumeTickRef.current.get(wikiId) ?? 0) + 1,
    );
    if (wikiId in pollPauseRef.current) {
      const next = { ...pollPauseRef.current };
      delete next[wikiId];
      pollPauseRef.current = next;
    }
    setPollPause((prev) => {
      if (!(wikiId in prev)) return prev;
      const next = { ...prev };
      delete next[wikiId];
      return next;
    });
  }, []);

  // Detail view state（Wiki 详情：图谱 / 页面 / 搜索 Tab）
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedPage, setSelectedPage] = useState<WikiPage | null>(null);
  const [readContent, setReadContent] = useState('');
  const [readLoading, setReadLoading] = useState(false);
  // 原始文档预览：
  // - format='native'：PDF/HTML/文本 → 原始字节交浏览器原生渲染（真正无损）
  // - format='html'  ：OOXML 等 → 转换后的 HTML（有损）
  // - 其余           ：Markdown 渲染
  // - error：转换失败时给出可读原因，而不是空白面板
  const [rawPreview, setRawPreview] = useState<{
    format?: 'native' | 'client' | 'html' | 'markdown';
    error?: string;
  }>({});
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
    setRawPreview({});
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

  /**
   * 需要轮询的 wiki 集合。
   *
   * 三类来源：
   *   1. 后端真值 pending / processing；
   *   2. pendingTakeover 中「已提交、新任务尚未被观察到」的（行上可能还是旧终态）；
   *   3. 排除已暂停自动检查的（预算耗尽 / 连续失败）。
   *
   * 一旦某 wiki 变成终态且已解除屏蔽，它就会从本集合消失 → key 变化 → effect
   * 清理定时器 → **轮询真正停止**（issue #1917 的核心诉求）。
   */
  const pollTargets = useMemo(
    () =>
      sources.filter(
        (s) =>
          s.wiki_id &&
          (s.status === 'pending' || s.status === 'processing' || pendingTakeover.has(s.wiki_id)) &&
          !pollPause[s.wiki_id],
      ),
    [sources, pendingTakeover, pollPause],
  );

  /** 参与轮询的 wiki + 状态签名；只有它变化才重建定时器（避免每次 setSources 重启）。 */
  const pollTargetsKey = useMemo(
    () =>
      pollTargets
        .map((s) => `${s.wiki_id}:${s.status}:${s.internal_status ?? ''}`)
        .join('|'),
    [pollTargets],
  );

  useEffect(() => {
    if (pollTargets.length === 0) return;
    // 只取 wiki_id：effect 刻意不依赖 sources 的其余字段，避免每轮 setSources
    // 都把定时器重建一次（那会让「预算」跟着抖动，且高频抖动 clearInterval）。
    const targetIds = pollTargets.map((s) => s.wiki_id);
    let cancelled = false;

    const poll = async () => {
      // 暂停判定必须在**发请求之前**用 ref 读：state 要等重渲染才可见，
      // 中间窗口会让 setInterval 继续空转（实测会超出预算若干次）。
      const live = targetIds.filter((id) => !pollPauseRef.current[id]);
      if (live.length === 0) return;

      // 记录本轮开始时每个 wiki 的 resume 版本。后续写 health / pause 之前比对；
      // 若用户在 await 期间点了「重新检查」，resetPollBudget 会 bump 这个 wiki
      // 的版本，本轮关于它的 health/pause 判定作废（否则 pause 会被加回去，
      // UI 闪回暂停态）。
      const resumeTickAtStart = new Map(
        live.map((id) => [id, pollResumeTickRef.current.get(id) ?? 0]),
      );

      const results = await Promise.all(
        live.map(async (wikiId) => {
          try {
            return { ok: true as const, detail: await knowledgeApi.wiki.get(wikiId) };
          } catch {
            return { ok: false as const, detail: null };
          }
        }),
      );
      if (cancelled) return;

      // ① 推进每个 wiki 的轮询预算（跨阶段保留；失败即累计，成功即清零）
      const newlyPaused: Record<string, IngestPollPauseReason> = {};
      live.forEach((wikiId, i) => {
        // 本轮期间该 wiki 被 resume 过 → 跳过 health 和 pause 写入
        // （health 已被 resetPollBudget 清零，别再写回；pause 本就该空）
        if ((pollResumeTickRef.current.get(wikiId) ?? 0) !== resumeTickAtStart.get(wikiId)) {
          return;
        }
        const health = pollHealthRef.current.get(wikiId) ?? INITIAL_INGEST_POLL_HEALTH;
        const next = advanceIngestPollHealth(health, results[i].ok);
        pollHealthRef.current.set(wikiId, {
          attempts: next.attempts,
          consecutiveFailures: next.consecutiveFailures,
        });
        if (next.pauseReason) newlyPaused[wikiId] = next.pauseReason;
      });

      // ② 合并 KS 真值
      const map = new Map(
        results
          .map((r) => r.detail)
          .filter((d): d is WikiDetail => !!d)
          .map((d) => [d.wiki_id, d]),
      );
      if (map.size > 0) {
        setSources((prev) =>
          prev.map((s) => (map.get(s.wiki_id) ? { ...s, ...map.get(s.wiki_id)! } : s)),
        );
      }

      // ③ 解除屏蔽：processing / 读数比提交前基线更新 / 兜底超时，任一成立即可。
      //    旧实现只认 processing，快速成功（sha256 跳过）与快速失败（LLM 未配置）
      //    都会永久卡在屏蔽态 —— 那是 #1917 的根因。
      const now = Date.now();
      const releaseNow: string[] = [];
      for (const [wikiId, rec] of takeoverRef.current) {
        if (shouldReleaseTakeover(rec, map.get(wikiId) ?? null, now)) releaseNow.push(wikiId);
      }
      // timeout 暂停时也强制解除屏蔽（`network` 保留，见下方说明）
      const pausedIds = Object.keys(newlyPaused);
      const timeoutIds = pausedIds.filter((id) => newlyPaused[id] === 'timeout');

      // ④ 记录暂停（停止后续轮询；展示仍按 KS 真值，不做伪装）
      if (pausedIds.length > 0) {
        // 先写 ref：下一个 tick 立刻生效，不等重渲染
        pollPauseRef.current = { ...pollPauseRef.current, ...newlyPaused };
        setPollPause((prev) => ({ ...prev, ...newlyPaused }));
      }
      /**
       * timeout 暂停时强制解除屏蔽，`network` 保留：
       * 暂停后该 wiki 被移出轮询目标集合，此后**再也观察不到它**。若继续屏蔽，
       * UI 会永久停在"加工中"，正是 #1917 要消灭的现象；而 timeout 说明已观察
       * 10 分钟且多数读数有效，此时展示的终态不可能是"上一个任务的残留"。
       * `network` 相反：最后一次读数不可信，保持"加工中 + 暂停说明"更诚实。
       * （另有一道兜底定时器，见 armTakeover。）
       */
      releaseTakeover([...releaseNow, ...timeoutIds]);

      // ⑤ 计数与详情刷新：本轮已暂停的不再刷新「最近检查」，否则会误导用户
      //    「自动检查还在跑」。
      const pausedThisRound = pausedIds.length > 0;
      if (!pausedThisRound) {
        setPollCount((n) => n + 1);
        setPollAt(new Date().toLocaleTimeString());
      }
      if (selectedWikiId && map.has(selectedWikiId)) {
        const d = map.get(selectedWikiId)!;
        if (d.status === 'ready' || d.status === 'failed') {
          pollHealthRef.current.delete(selectedWikiId);
          void fetchDetail(selectedWikiId);
        }
      }
    };

    void poll();
    const timer = window.setInterval(poll, INGEST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // effect 只依赖 pollTargetsKey（id+status+internal_status 签名）而**不**依赖
    // pollTargets 本身：每轮 setSources 都会产生新的数组引用，若依赖它，定时器
    // 会被每 2 秒重建一次（预算抖动 + 节奏漂移）。key 相同说明参与轮询的成员
    // 与状态完全一致，用旧闭包里的 targetIds 是安全的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollTargetsKey, selectedWikiId, fetchDetail]);

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
     * 屏蔽「上一个任务留下的终态」。
     *
     * 判据统一收敛到 `shouldReleaseTakeover`（与轮询 effect 共用同一函数）：
     *   - 读到 processing            → 新任务在跑，无需屏蔽；
     *   - 读数 updated_at 比基线新   → 必产生于提交之后，不可能是旧任务；
     *   - 超过 TAKEOVER_MAX_HOLD_MS  → 兜底解除。
     *
     * 在**渲染期**也算一次（而不只在轮询回调里）：若轮询压根没启动（快速终态
     * 导致 key 未变化），这里仍能靠 updated_at / 兜底超时解除，不会永久卡住。
     */
    const takeoverRec = selectedWikiId ? pendingTakeover.get(selectedWikiId) : undefined;
    const awaitingTakeover = !!takeoverRec &&
      !shouldReleaseTakeover(
        takeoverRec,
        { status: rawStatus, updated_at: wiki?.updated_at ?? null },
        Date.now(),
      );
    const staleTerminal =
      awaitingTakeover && (rawStatus === 'ready' || rawStatus === 'failed');
    const status = staleTerminal ? 'processing' : rawStatus;
    // 陈旧终态不展示上一个任务的 internal_status / page_count（那属于旧任务）
    const internalStatus = staleTerminal ? null : (wiki?.internal_status ?? null);
    const pageCount = staleTerminal ? null : (wiki?.page_count ?? null);
    /**
     * 自动检查已暂停的原因。
     *
     * ⚠️ 判据必须用**展示态**（`status`，已含屏蔽），不能用 `staleTerminal`：
     * 长任务真实处于 processing 时同样会耗尽预算，那种情况下卡片也必须说明
     * 「已停止自动检查」，否则用户盯着不再更新的"第 N 次检查"无从判断。
     * 真实终态（ready/failed）不展示暂停文案 —— 结论比过程重要。
     */
    const showingInFlight = status === 'pending' || status === 'processing';
    const pauseReason: IngestPollPauseReason | undefined =
      showingInFlight && selectedWikiId ? pollPause[selectedWikiId] : undefined;

    const inFlight = showingInFlight;
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

    // 文案优先级：暂停说明 > 终态 > 加工中。
    //
    // 暂停说明放最前，是因为此时"第 N 次检查"已经不再更新，继续展示会让用户
    // 误以为自动检查还在跑。文案必须如实说明「已停止自动检查 + 后台可能仍在
    // 处理 + 可重新检查」，而不是宣称任务完成或失败。
    //
    // 加工中的文案必须带"第 N 次检查"与页数提示 —— 这是用户判断"进度真的在动"
    // 的唯一依据，任何重构都不得省略 attempt / pageHint 模板参数（历史回归教训）。
    let detail: string;
    if (pauseReason === 'timeout') {
      detail = t('wiki.ingest.pollPaused.timeout', {
        minutes: ingestPollWindowMinutes(),
      });
    } else if (pauseReason === 'network') {
      detail = t('wiki.ingest.pollPaused.network');
    } else if (status === 'ready') {
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
      /** true = 自动检查已暂停（卡片需展示暂停说明与「重新检查」）。 */
      paused: !!pauseReason,
      pauseReason,
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
  }, [sources, selectedWikiId, pollAt, pollCount, pendingTakeover, pollPause, t]);

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
   * pending/processing），由 pollTargets 驱动的轮询 effect 接管后续刷新。
   */
  const submitAddAndIngest = async (params: {
    wikiId: string;
    mode: 'files' | 'markdown' | 'external' | 'reingest';
    // encoding 必须保留并透传：Knowledge 默认按 base64 解码，手工粘贴 MD
    // 需显式 'utf8'，否则被判非法 base64。见 import-and-ingest-modal.tsx 注释。
    files?: { filename: string; content: string; encoding?: 'utf8' | 'base64' }[];
    markdown?: { filename: string; content: string; encoding?: 'utf8' | 'base64' }[];
    source_url?: string;
    provider_id?: string;
    page_ids?: string[];
  }): Promise<void> => {
    const { wikiId, mode } = params;
    if (!wikiId) return;

    /**
     * 提交前抓该 wiki 行上的 `updated_at` 作为基线。
     *
     * 用途：`import-and-ingest` 在返回前 KS 已把行写成 `pending` 并刷新
     * `updated_at`，所以轮询读到的任何「比基线新」的行都必然来自**新任务**，
     * 可以安全解除屏蔽；而提交之前就已发出、在飞的那次 `wiki/get` 拿回的是
     * 旧任务的读数（updated_at 不会比基线新），仍会被正确屏蔽 —— 既不会永久
     * 卡住，也不会闪一下旧终态。
     */
    const baselineUpdatedAt =
      sources.find((s) => s.wiki_id === wikiId)?.updated_at ?? '';

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
      // pollTargets 驱动的轮询 effect 会据它自动启动 2s 轮询，直到终态或有界暂停。
      setRawRefreshKey((k) => k + 1);
      await fetchSources();

      if (!res.ok) {
        const msg = res.error_message || t('wiki.notify.ingestFailed');
        tea.notify.error(msg);
        fetchDetail(wikiId);
        return;
      }

      // ✅ 复合请求被接受（任务真的排上了）才显示进度卡片：
      // 复位"已清除"标记让卡片出现，并把检查计数清零——否则第二次导入会
      // 接着上一次的数字往下数。
      //
      // ⚠ 此前这套复位放在**发请求之前**：文件超限被 413/FILE_TOO_LARGE 拒时
      // 卡片已经弹出并进入轮询态，用户看到"报错了却在跑进度"的矛盾画面。
      // 现在改为"确认受理后才复位"，被拒则完全不展示进度。
      setIngestCardCleared(false);
      setPollCount(0);
      setPollAt('');
      // 提交新任务 → 预算与暂停标记全部作废，从头计数（否则上一轮耗尽的
      // 300 次预算会让新任务一提交就被判 timeout）。
      resetPollBudget(wikiId);
      // 屏蔽"上一个任务留下的终态"：记录基线 updated_at + 提交时刻，并挂上
      // 兜底定时器（到点无条件解除）—— 解除判据见 shouldReleaseTakeover。
      armTakeover(wikiId, baselineUpdatedAt);

      // 触发一次立即刷新，避免等下一拍轮询才反映新状态
      fetchDetail(wikiId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      tea.notify.error(msg);
      setRawRefreshKey((k) => k + 1);
      fetchDetail(wikiId);
    }
  };

  /**
   * 手动「重新检查」：清掉暂停标记与预算，立刻拉一次真值并恢复轮询。
   *
   * 与「重新抽取」的区别：本函数**不触发 ingest**，只是重新开始观察。用户的
   * 诉求通常是"到底跑完没有"，不该被迫重启一轮 LLM 抽取（既慢又花钱）。
   */
  const resumeIngestPolling = useCallback(
    (wikiId: string) => {
      if (!wikiId) return;
      resetPollBudget(wikiId);
      setPollCount(0);
      setPollAt('');
      // 立刻拉一次，避免用户再等 2s 才看到变化
      void knowledgeApi.wiki
        .get(wikiId)
        .then((detail) => {
          setSources((prev) =>
            prev.map((s) => (s.wiki_id === wikiId ? { ...s, ...detail } : s)),
          );
          // 读到终态时**不能**无条件解除屏蔽：若新任务未真正开跑（KS 的 updated_at
          // 没刷新），这个 ready/failed 其实是上一次任务的残留 —— 直接 release
          // 就会把陈旧终态漏给用户，正是 #1917 的原始症状。
          // 统一走 shouldReleaseTakeover：updated_at > baseline / 兜底超时任一满足
          // 才解除；否则保留屏蔽（渲染层仍按"加工中 + 暂停说明"展示），由后续
          // 轮询 / 兜底定时器处理。
          if (detail.status === 'ready' || detail.status === 'failed') {
            const rec = takeoverRef.current.get(wikiId);
            if (shouldReleaseTakeover(rec, detail, Date.now())) {
              releaseTakeover([wikiId]);
              void fetchDetail(wikiId);
            }
          }
        })
        .catch((e: unknown) => {
          tea.notify.error((e instanceof Error ? e.message : String(e)) || t('wiki.notify.loadDetailFailed'));
        });
    },
    [resetPollBudget, releaseTakeover, fetchDetail, t],
  );

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
    setRawPreview({});
    setSubView('detail');
    fetchDetail(wikiId);
  };

  const handleReadPage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    // 切换页面时先清空旧内容再进入 loading —— 否则派生的 metadata（来自 readContent）
    // 会在新内容返回前残留上一个文档的标签，视觉上就是"闪一下旧文档"。
    setSelectedPage(page);
    setReadContent('');
    // wiki 页是 markdown，按 markdown 渲染
    setRawPreview({});
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

  /**
   * 读取原始文档（raw/sources/ 下的上传文件）用于预览。
   *
   * 预览要的是**渲染原始文档本身**，不是把内容转成文本再显示：
   * - 富文档（docx/pptx/xlsx/pdf/odt/...）→ KS 转成完整 HTML（保留分页幻灯片、
   *   Excel 行列头、分页页面等原始版式）→ 前端 iframe 沙箱渲染；
   * - 文本类（md/txt/csv）→ 原文 → Markdown 渲染。
   * 形态由后端 `preview_format` 告知，前端据此选渲染器。
   * 转换失败时展示可读原因而非空白面板。
   */
  const handleReadRaw = async (filename: string) => {
    if (!selectedWikiId) return;
    setSelectedPage({ path: `raw/${filename}`, title: filename, type: 'raw' });
    setReadContent('');
    setRawPreview({});
    setReadLoading(true);
    try {
      const r = await knowledgeApi.wiki.rawRead(selectedWikiId, [filename]);
      const item = r?.items?.[0];
      if (!item || item.not_found) {
        setRawPreview({ error: t('wiki.notify.rawNotFound') });
        return;
      }
      // 只看 preview_error，不要求 binary —— html/htm 是文本源（binary=false），
      // 但预览同样要经转换层，失败时一样要给出可读原因。
      if (item.preview_error) {
        setRawPreview({
          error: RAW_PREVIEW_ERROR_KEYS[item.preview_error] ?? t('wiki.rawPreview.failed'),
        });
        return;
      }
      setReadContent(item.content || '');
      setRawPreview({ format: item.preview_format ?? 'markdown' });
    } catch (e: unknown) {
      setRawPreview({
        error: (e instanceof Error ? e.message : String(e)) || t('wiki.notify.readRawFailed'),
      });
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
          setRawPreview({});
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
    // 前端预校验：按格式注册表下发的 maxBytes 拦超限文件，**不发请求**。
    // 此前无此检查，超限文件要走完 base64 编码 + Panel/KS 往返才被 413 拒，
    // 大文件白等且报错文案是写死的"512KB"（与实际档位不符，误导）。
    const maxOf = (f: File) => maxBytesForFile(f.name);
    const oversize = pendingFiles.filter((f) => {
      const max = maxOf(f);
      return max !== undefined && f.size > max;
    });
    if (oversize.length) {
      for (const f of oversize) {
        setUploadProgress((prev) => ({ ...prev, [f.name]: 'error' }));
        tea.notify.error(
          t('wiki.detail.upload.fileTooLarge', {
            filename: f.name,
            maxMB: ((maxOf(f) ?? 0) / 1024 / 1024).toFixed(1),
          }),
        );
      }
    }
    const uploadables = pendingFiles.filter((f) => !oversize.includes(f));
    if (!uploadables.length) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    // 并发上传所有文件（仅未超限的）
    const results = await Promise.allSettled(
      uploadables.map(async (f) => {
        const { content, encoding } = await readUploadFile(f);
        await knowledgeApi.wiki.upload({
          teamId: activeTeamId,
          wikiId: selectedWikiId,
          filename: f.name,
          content,
          encoding,
        });
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
    rawPreview,
    setRawPreview,
    handleReadRaw,
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
    /** 手动「重新检查」：清预算并立即拉一次真值（不触发 ingest）。 */
    resumeIngestPolling,
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
