import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Justify,
  MetricsBoard,
  Modal,
  Progress,
  SearchBox,
  Segment,
  Select,
  StatusTip,
  Table,
  TabPanel,
  Tabs,
  Tag,
  Text,
} from 'tea-component';
import {
  ArrowLeftIcon,
  CloseIcon,
  AttachIcon,
  SearchIcon,
  StarIcon,
  ChartBarIcon,
  LayersIcon as ArchitectureIcon,
  FileIcon,
  FolderIcon,
  BooksIcon,
  LoadingIcon,
  CheckCircleIcon,
  CloseCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  DeleteIcon,
  UsergroupIcon,
  ViewListIcon,
  ViewModuleIcon,
} from 'tea-icons-react';
import {
  knowledgeApi,
  wikiProgressPercent,
  wikiStageLabel,
  type WikiDetail,
  type WikiPage,
  type GraphData,
  type GraphNode,
} from '@/lib/knowledge-api';
import { useResizable } from '@/lib/useResizable';
import { useTeams, useAgents } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import AllocateAssetDialog from '@/pages/ResourcePage/components/AllocateAssetDialog';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { findExistingRawFilenames, formatOverwriteFilenames } from './wiki-upload-utils';
import { AssetPageHeader } from '@/pages/ResourcePage/components/AssetPageHeader';
import './wiki-sources-panel.css';

/** Wiki 仅允许上传 Markdown 类文件（.md / .markdown / .txt）。 */
const WIKI_ALLOWED_FILE_RE = /\.(md|txt|markdown)$/i;

// --- Markdown 渲染组件 ---
const mdComponents = {
  h1: ({ children, ...p }: any) => (
    <h1 className="text-xl font-bold mb-3 mt-0 pb-2 border-b border-border text-foreground" {...p}>
      {children}
    </h1>
  ),
  h2: ({ children, ...p }: any) => (
    <h2 className="text-lg font-semibold mb-2 mt-6 text-foreground/85" {...p}>
      {children}
    </h2>
  ),
  h3: ({ children, ...p }: any) => (
    <h3 className="text-base font-semibold mb-1.5 mt-4 text-foreground/85" {...p}>
      {children}
    </h3>
  ),
  h4: ({ children, ...p }: any) => (
    <h4 className="text-sm font-semibold mb-1 mt-3 text-foreground/85" {...p}>
      {children}
    </h4>
  ),
  p: ({ children, ...p }: any) => (
    <p className="text-sm leading-relaxed mb-3 text-foreground/70" {...p}>
      {children}
    </p>
  ),
  ul: ({ children, ...p }: any) => (
    <ul className="text-sm list-disc pl-5 mb-3 space-y-1 text-foreground/70" {...p}>
      {children}
    </ul>
  ),
  ol: ({ children, ...p }: any) => (
    <ol className="text-sm list-decimal pl-5 mb-3 space-y-1 text-foreground/70" {...p}>
      {children}
    </ol>
  ),
  li: ({ children, ...p }: any) => (
    <li className="text-sm leading-relaxed" {...p}>
      {children}
    </li>
  ),
  code: ({ children, className, ...p }: any) => {
    if (className?.includes('language-'))
      return (
        <pre className="rounded-lg bg-muted p-4 text-xs font-mono overflow-x-auto my-3 border border-border">
          <code {...p}>{children}</code>
        </pre>
      );
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono" {...p}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  hr: () => <hr className="my-5 border-border" />,
  strong: ({ children, ...p }: any) => (
    <strong className="font-semibold text-foreground/85" {...p}>
      {children}
    </strong>
  ),
  a: ({ children, href, ...p }: any) => (
    <a
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      href={href}
      {...p}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...p }: any) => (
    <blockquote
      className="border-l-[3px] border-primary/40 pl-4 italic text-muted-foreground my-3"
      {...p}
    >
      {children}
    </blockquote>
  ),
  table: ({ children, ...p }: any) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-xs border-collapse border border-border" {...p}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...p }: any) => (
    <th className="border border-border px-3 py-2 bg-muted text-left text-xs font-semibold" {...p}>
      {children}
    </th>
  ),
  td: ({ children, ...p }: any) => (
    <td className="border border-border px-3 py-2 text-xs" {...p}>
      {children}
    </td>
  ),
};

// Wiki 状态徽章：draft=建壳未加工（待用户点 ingest）；pending=排队；processing=加工中；ready=就绪；failed=失败；missing=KS 数据丢失。
// 走 Tea Tag 的语义 theme（soft 变体），随主题响应，不用硬编码调色板色。
const WIKI_STATUS_THEME: Record<WikiDetail['status'], 'warning' | 'success' | 'error' | 'default'> = {
  draft: 'warning',
  pending: 'warning',
  processing: 'warning',
  ready: 'success',
  failed: 'error',
  missing: 'error',
};
const WIKI_STATUS_KEY: Record<WikiDetail['status'], string> = {
  draft: 'wiki.status.draft',
  pending: 'wiki.status.pending',
  processing: 'wiki.status.processing',
  ready: 'wiki.status.ready',
  failed: 'wiki.status.failed',
  missing: 'wiki.status.missing',
};
function WikiStatusBadge({ status }: { status: WikiDetail['status'] }) {
  const { t } = useTranslation();
  const theme = WIKI_STATUS_THEME[status] ?? ('default' as const);
  const label = WIKI_STATUS_KEY[status] ? t(WIKI_STATUS_KEY[status]) : status;
  return (
    <Tag theme={theme} variant="soft" size="sm">
      {label}
    </Tag>
  );
}

const { scrollable } = Table.addons;

type SubView = 'list' | 'detail';
type DetailTab = 'overview' | 'graph' | 'pages' | 'search';
type ViewMode = 'card' | 'list';
type StatusFilter = 'all' | 'ready' | 'processing';

function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// --- Types ---
interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
}

const TYPE_COLORS: Record<string, string> = {
  entity: 'var(--tea-color-bg-brand-default)',
  concept: 'var(--tea-color-bg-warning-default)',
  source: 'var(--tea-color-bg-amber-default)',
  query: 'var(--tea-color-bg-success-default)',
  synthesis: 'var(--tea-color-bg-error-default)',
  overview: 'var(--tea-color-bg-yellow-default)',
  comparison: 'var(--tea-color-bg-secondary-active)',
  finding: 'var(--tea-color-bg-warning-default)',
  thesis: 'var(--tea-color-bg-error-default)',
  methodology: 'var(--tea-color-bg-success-default)',
  other: 'var(--tea-color-bg-tertiary-default)',
  raw: 'var(--tea-color-bg-secondary-default)',
};
const TYPE_COLOR_FALLBACK = 'var(--tea-color-text-tertiary)';

type WikiScopeTab = 'all' | 'team' | 'fixed' | 'scope';
const SCOPE_LABEL_KEYS: Record<WikiScopeTab, string> = {
  all: 'wiki.scope.all',
  team: 'wiki.scope.team',
  fixed: 'wiki.scope.fixed',
  scope: 'wiki.scope.scope',
};

/**
 * Owner 展示 —— 显示用户名而非 user_id。
 * useUserDisplayName 内部有全局缓存 + 只在首次 miss 时发 usersApi.get，
 * 同一 user_id 多行共享同一份缓存，扩展性 O(distinct user 数)，不是 O(行数)。
 * 抽子组件是因为 Rules of Hooks —— 不能在 .map 里循环调 hook。
 */
function WikiOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span title={t('wiki.detail.owner', { userId })}>
      @{name || userId}
      {userId === currentUserId && <span className="ml-1 text-xs text-primary">{t('wiki.detail.you')}</span>}
    </span>
  );
}

export default function WikiSourcesPanel() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<WikiDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [scopeTab, setScopeTab] = useState<WikiScopeTab>('team');
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
    } catch (e: any) {
      tea.notify.error(e?.message || t('wiki.notify.loadFixedFailed'));
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

  // Ingest progress
  const [ingestState, setIngestState] = useState<{
    active: boolean;
    wikiId: string;
    wiki: string;
    currentFile: string;
    detail: string;
    done: number;
    total: number;
    checkCount: number;
    lastCheckedAt: string;
    log: Array<{ file: string; status: 'done' | 'error'; error?: string }>;
  }>({
    active: false,
    wikiId: '',
    wiki: '',
    currentFile: '',
    detail: '',
    done: 0,
    total: 0,
    checkCount: 0,
    lastCheckedAt: '',
    log: [],
  });

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

  // Add doc（添加文档：文件 / 粘贴 markdown）
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [addDocTab, setAddDocTab] = useState<'file' | 'markdown'>('file');
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
    setLoading(true);
    // 立即清空旧数据 —— 否则切 tab 时会先看到上一个 tab 的列表，
    // 新数据到了才突然替换，视觉上就是"闪一下"。
    setSources([]);
    try {
      // 资产统一为团队维度（visibility=team），无 private/我的资产概念。
      // fixed tab 也是拿全量 team 资产，再按 fixedBoundIds 过滤。
      const d = await knowledgeApi.wiki.teamAssets(activeTeamId);
      if (seq !== fetchSeqRef.current) return; // 已被后续请求取代
      setSources(Array.isArray(d) ? d : []);
    } catch (e: any) {
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
      setPages(Array.isArray(p) ? p : (p as any)?.pages || []);
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
      (s) => s.wiki_id && (s.status === 'pending' || s.status === 'processing'),
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

  async function handleUnbindWiki(wikiId: string) {
    if (!agentFilter) return;
    const ok = await tea.confirm({
      message: t('wiki.confirm.unbind'),
      description: t('wiki.confirm.unbind.desc'),
      okText: t('wiki.confirm.unbind.ok'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.wiki.unbind(wikiId, agentFilter);
      tea.notify.success(t('wiki.notify.unbound'));
      if (selectedWikiId === wikiId) setSelectedWikiId('');
      await fetchFixedBindings();
      await fetchSources();
    } catch (e: any) {
      tea.notify.error(e?.message || t('wiki.notify.unbindFailed'));
    }
  }

  // --- Handlers ---
  const handleCreate = async () => {
    if (!newName.trim() || !activeTeamId) return;
    setSubmitting(true);
    try {
      await knowledgeApi.wiki.create(activeTeamId, newName.trim());
      tea.notify.success(t('wiki.notify.created', { name: newName.trim() }));
      setShowCreate(false);
      setNewName('');
      fetchSources();
    } catch (e: any) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleIngest = async (wikiId: string) => {
    // 防御：同一时间只允许一个 Wiki 提取，避免并发 ingest 导致后端排队混乱。
    // 按钮已按 ingestBusy 禁用，这里再挡一层防止绕过。
    if (ingestBusy) {
      tea.notify.warning(t('wiki.ingest.warning'));
      return;
    }
    const wiki = sources.find((s) => s.wiki_id === wikiId);
    const name = wiki?.name ?? wikiId;
    setIngestState({
      active: true,
      wikiId,
      wiki: name,
      currentFile: '',
      detail: t('wiki.ingest.triggering'),
      done: 0,
      total: 100,
      checkCount: 0,
      lastCheckedAt: '',
      log: [],
    });
    await knowledgeApi.wiki.ingestWithPolling(
      wikiId,
      {
        onProgress: (ev) => {
          setIngestState((prev) => {
            const next = { ...prev };
            const checkedAt = new Date(ev.ts).toLocaleTimeString();
            if (ev.type === 'file_start') {
              next.currentFile = ev.file || '';
              next.detail = ev.detail || t('wiki.ingest.processing');
              next.done = ev.done ?? prev.done;
              next.total = ev.total ?? prev.total;
              next.lastCheckedAt = checkedAt;
            } else if (ev.type === 'file_done') {
              next.done = ev.done ?? prev.done;
              next.total = ev.total ?? prev.total;
              next.detail = ev.detail || t('wiki.ingest.checked', { done: next.done, total: next.total });
              next.checkCount = prev.checkCount + 1;
              next.lastCheckedAt = checkedAt;
              if (ev.file) next.log = [...prev.log, { file: ev.file, status: 'done' }];
            } else if (ev.type === 'file_error') {
              next.done = ev.done ?? prev.done;
              next.detail = ev.detail || prev.detail;
              next.checkCount = prev.checkCount + 1;
              next.lastCheckedAt = checkedAt;
              next.log = [...prev.log, { file: ev.file || '', status: 'error', error: ev.error }];
            } else if (ev.type === 'batch_done') {
              next.done = ev.done ?? 100;
              next.total = ev.total ?? 100;
              next.detail = ev.detail || t('wiki.ingest.complete');
              next.lastCheckedAt = checkedAt;
            }
            return next;
          });
        },
        onComplete: (result) => {
          setIngestState((prev) => ({
            ...prev,
            active: false,
            done: 100,
            total: 100,
            detail: t('wiki.ingest.done', { count: result.ingested }),
            currentFile: '',
          }));
          tea.notify.success(t('wiki.notify.ingestComplete', { count: result.ingested }));
          fetchSources();
          fetchDetail(wikiId);
        },
        onError: (err) => {
          setIngestState((prev) => ({ ...prev, active: false, detail: t('wiki.ingest.error', { error: err }) }));
          tea.notify.error(err || t('wiki.notify.ingestFailed'));
        },
      },
      activeTeamId ?? '',
    );
    setIngestState((prev) =>
      prev.active
        ? { ...prev, active: false, detail: prev.log.length > 0 ? t('wiki.ingest.finished') : prev.detail }
        : prev,
    );
    fetchSources();
  };

  const handleDelete = async (wikiId: string, name: string) => {
    const ok = await tea.confirm({ message: t('wiki.confirm.delete', { name }), okText: t('common.delete') });
    if (!ok) return;
    try {
      await knowledgeApi.wiki.delete(wikiId);
      if (selectedWikiId === wikiId) setSubView('list');
      fetchSources();
    } catch (e: any) {
      tea.notify.error(e);
    }
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
        (page as any).id || (page as any).path,
      );
      setReadContent(r?.content || '');
    } catch (e: any) {
      setReadContent('');
      tea.notify.error(e?.message || t('wiki.notify.readPageFailed'));
    } finally {
      setReadLoading(false);
    }
  };

  const handleDeletePage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    const ref = (page as any).id || page.path;
    const ok = await tea.confirm({
      message: t('wiki.confirm.deletePage', { name: page.title || ref }),
      description: t('wiki.confirm.deletePage.desc'),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.wiki.pageDelete(selectedWikiId, [ref]);
      tea.notify.success(t('wiki.notify.pageDeleted'));
      if (selectedPage && ((selectedPage as any).id || selectedPage.path) === ref) {
        setSelectedPage(null);
        setReadContent('');
      }
      await fetchDetail(selectedWikiId);
    } catch (e: any) {
      tea.notify.error(e?.message || t('wiki.notify.pageDeleteFailed'));
    }
  };

  const handleDeleteRaw = async (filename: string) => {
    if (!selectedWikiId) return;
    const ok = await tea.confirm({
      message: t('wiki.confirm.deleteRaw', { name: filename }),
      description: t('wiki.confirm.deleteRaw.desc'),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await knowledgeApi.wiki.rawDelete(selectedWikiId, [filename]);
      tea.notify.success(t('wiki.notify.rawDeleted'));
      if (selectedPage?.path === `raw/${filename}`) {
        setSelectedPage(null);
        setReadContent('');
      }
      await fetchDetail(selectedWikiId);
    } catch (e: any) {
      tea.notify.error(e?.message || t('wiki.notify.rawDeleteFailed'));
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !selectedWikiId) return;
    setSearching(true);
    try {
      const r = await knowledgeApi.wiki.search(selectedWikiId, searchQuery, 20);
      setSearchResults((r as any)?.results || []);
    } catch (e: any) {
      tea.notify.error(e);
    } finally {
      setSearching(false);
    }
  };

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

  /**
   * 上传只写入原始文档，不会自动触发知识抽取；成功后立即给出明确的下一步操作，
   * 避免用户不知道还需要点击"开始抽取"。
   */
  const offerIngestAfterUpload = async (wikiId: string, uploadedCount: number) => {
    const shouldIngest = await tea.confirm({
      message: t('wiki.detail.uploaded', { count: uploadedCount }),
      description: t('wiki.detail.uploaded.desc'),
      okText: t('wiki.detail.uploaded.ok'),
      cancelText: t('wiki.detail.uploaded.cancel'),
    });
    if (shouldIngest) {
      void handleIngest(wikiId);
    } else {
      tea.notify.info(t('wiki.detail.uploaded.later'));
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
        await knowledgeApi.wiki.upload(activeTeamId, selectedWikiId, filename, doc.content);
      } catch (e: any) {
        failures.push({ filename, error: e?.message || String(e) });
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
      await offerIngestAfterUpload(selectedWikiId, valid.length);
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
      if (okCount > 0) await offerIngestAfterUpload(selectedWikiId, okCount);
    }
  };

  // 批量文件上传：支持多选 + 拖拽，并发上传
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, 'pending' | 'done' | 'error'>
  >({});
  // 原始文档列表刷新信号：RawFilesSection 维护自己独立的 state，只在 wikiId 变化时重载；
  // 上传成功后 fetchDetail 只刷新 pages/graph，不会触发它重拉。递增此 key 强制其 reload。
  const [rawRefreshKey, setRawRefreshKey] = useState(0);

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
        await knowledgeApi.wiki.upload(activeTeamId, selectedWikiId, f.name, content);
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
      await offerIngestAfterUpload(selectedWikiId, succeeded);
    } else {
      results.forEach((r, i) => {
        if (r.status === 'rejected')
          setUploadProgress((prev) => ({ ...prev, [pendingFiles[i].name]: 'error' }));
      });
      tea.notify.error(t('wiki.detail.upload.fail', { ok: succeeded, fail: failed }));
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
      if (succeeded > 0) await offerIngestAfterUpload(selectedWikiId, succeeded);
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
  const runningWiki = useMemo(
    () => sources.find((s) => s.status === 'pending' || s.status === 'processing') ?? null,
    [sources],
  );
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
  const hasManualIngestState =
    ingestState.active ||
    ingestState.log.length > 0 ||
    (ingestState.done > 0 && !!ingestState.detail);
  const displayIngestState = useMemo(() => {
    if (hasManualIngestState || !runningWiki) return ingestState;
    const stage = wikiStageLabel(runningWiki.status, runningWiki.internal_status);
    const pageHint =
      typeof runningWiki.page_count === 'number' ? t('wiki.ingest.currentPage', { count: runningWiki.page_count }) : '';
    return {
      active: true,
      wikiId: runningWiki.wiki_id ?? '',
      wiki: runningWiki.name,
      currentFile: '',
      detail: t('wiki.ingest.stateRecovery', { stage, pageHint }),
      done: wikiProgressPercent(runningWiki.status, runningWiki.internal_status),
      total: 100,
      checkCount: 0,
      lastCheckedAt: '',
      log: [],
    };
  }, [hasManualIngestState, ingestState, runningWiki]);
  const ingestBusy = displayIngestState.active || !!runningWiki;

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

  // ═══════════════════════════════════════════
  // DETAIL VIEW
  // ═══════════════════════════════════════════
  if (subView === 'detail') {
    const source = sources.find((s) => s.wiki_id === selectedWikiId);
    const wikiName = source?.name ?? '';
    // During pending/processing the backend gates page/search endpoints on ready,
    // so pages.length reads 0 — but wiki/get keeps an accurate page_count. Show the
    // preserved count greyed out instead of a scary zero.
    const isProcessing = source?.status === 'pending' || source?.status === 'processing';
    const preservedCount = source?.page_count ?? pages.length;

    return (
      <div className="_wiki-detail-root">
        <Card>
          <Card.Body className="_wiki-detail-header-body">
            <div className="_wiki-detail-breadcrumb">
              <Button type="text" onClick={() => { fetchSources(); setSubView('list'); }}>
                <ArrowLeftIcon size={12} /> {t('wiki.breadcrumb')}
              </Button>
              <span>/</span>
              <span>{wikiName}</span>
            </div>
            <div className="_wiki-detail-header-row">
              <div className="_wiki-detail-header-info">
                <BooksIcon size={18} />
                <span className="_wiki-detail-title">{wikiName}</span>
                {source && <WikiStatusBadge status={source.status} />}
                {isProcessing ? (
                  <Text theme="label" className="_wiki-processing">
                    {t('wiki.detail.pagesPreserved', { count: preservedCount })}
                  </Text>
                ) : (
                  <Text theme="label">{t('wiki.detail.pages', { count: pages.length })}</Text>
                )}
              </div>
              <div className="_wiki-detail-header-actions">
                <Button
                  type="text"
                  onClick={() => {
                    setShowAddDoc(true);
                    setAddDocTab('file');
                  }}
                >
                  <AttachIcon size={14} /> {t('wiki.detail.add')}
                </Button>
                <Button
                  type="primary"
                  onClick={() => handleIngest(selectedWikiId)}
                  disabled={ingestBusy}
                  loading={ingestBusy && displayIngestState.wiki === wikiName}
                >
                  {ingestBusy && displayIngestState.wiki === wikiName ? (
                    t('wiki.detail.processing')
                  ) : (
                    <>
                      <StarIcon size={14} /> Ingest
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Card.Body>
        </Card>

        {(displayIngestState.active || displayIngestState.log.length > 0) &&
          displayIngestState.wiki === wikiName && (
            <Card className="_wiki-detail-ingest-card">
              <Card.Body>
                <div className="_wiki-detail-ingest">
                  <div className="_wiki-detail-ingest-head">
                    <Text className="_wiki-detail-ingest-title">
                      {displayIngestState.active ? (
                        <LoadingIcon size={14} />
                      ) : (
                        <CheckCircleIcon size={14} />
                      )}{' '}
                      {t('wiki.detail.ingestTitle', { name: displayIngestState.wiki })}
                    </Text>
                    {!displayIngestState.active && (
                      <Button
                        type="text"
                        onClick={() => setIngestState((state) => ({ ...state, log: [] }))}
                      >
                        {t('wiki.detail.clear')}
                      </Button>
                    )}
                  </div>
                  {displayIngestState.total > 0 && (
                    <>
                      <Progress
                        percent={Math.round(
                          (displayIngestState.done / displayIngestState.total) * 100,
                        )}
                      />
                      <div className="_wiki-detail-ingest-meta">
                        <Text theme="label">{displayIngestState.detail}</Text>
                        <Text theme="label">
                          {displayIngestState.done}/{displayIngestState.total}
                        </Text>
                      </div>
                      {displayIngestState.checkCount > 0 && (
                        <Text theme="label">
                          {t('wiki.detail.queryCount', { count: displayIngestState.checkCount })}
                          {displayIngestState.lastCheckedAt
                            ? t('wiki.detail.lastQuery', { time: displayIngestState.lastCheckedAt })
                            : ''}
                        </Text>
                      )}
                    </>
                  )}
                  {displayIngestState.active && displayIngestState.currentFile && (
                    <Text theme="label" className="_wiki-detail-ingest-file">
                      <FileIcon size={12} /> {displayIngestState.currentFile}
                    </Text>
                  )}
                  {displayIngestState.log.length > 0 && (
                    <div className="_wiki-detail-ingest-log">
                      {displayIngestState.log.map((item, index) => (
                        <div key={`${item.file}-${index}`} className="_wiki-detail-ingest-log-item">
                          {item.status === 'done' ? (
                            <CheckCircleIcon size={12} />
                          ) : (
                            <CloseCircleIcon size={12} />
                          )}
                          <span className="_wiki-detail-ingest-log-file">{item.file}</span>
                          {item.error && (
                            <span className="_wiki-detail-ingest-log-error">{item.error}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card.Body>
            </Card>
          )}

        <Tabs
          activeId={activeTab}
          onActive={(tab) => setActiveTab(tab.id as DetailTab)}
          disableTabScrolling
          className="_wiki-detail-tabs"
          tabs={[
            {
              id: 'overview',
              label: (
                <span className="_wiki-detail-tab-label">
                  <ChartBarIcon size={14} />
                  {t('wiki.detail.tab.overview')}
                </span>
              ),
            },
            {
              id: 'graph',
              label: (
                <span className="_wiki-detail-tab-label">
                  <ArchitectureIcon size={14} />
                  {t('wiki.detail.tab.graph')}
                </span>
              ),
            },
            {
              id: 'pages',
              label: (
                <span className="_wiki-detail-tab-label">
                  <FileIcon size={14} />
                  {t('wiki.detail.tab.pages')}
                </span>
              ),
            },
            {
              id: 'search',
              label: (
                <span className="_wiki-detail-tab-label">
                  <SearchIcon size={14} />
                  {t('wiki.detail.tab.search')}
                </span>
              ),
            },
          ]}
        >
          <TabPanel id="overview">
            <div className="_wiki-detail-overview">
              <div
                className={`_wiki-detail-overview-stats${isProcessing ? ' _wiki-processing' : ''}`}
              >
                <MetricsBoard
                  title={t('wiki.detail.overview.totalPages')}
                  value={isProcessing ? preservedCount : pages.length}
                />
                <MetricsBoard
                  title={t('wiki.detail.overview.pageTypes')}
                  value={isProcessing ? '—' : types.length}
                />
                <MetricsBoard
                  title={t('wiki.detail.overview.edges')}
                  value={isProcessing ? '—' : edgeCount}
                />
              </div>
              {isProcessing && (
                <Alert type="info" className="_wiki-detail-overview-processing-hint">
                  {t('wiki.detail.processingHint')}
                </Alert>
              )}
              <Card bordered>
                <Card.Body title={t('wiki.detail.overview.typeDist')}>
                  {isProcessing ? (
                    <StatusTip
                      status="loading"
                      emptyText={t('wiki.detail.pagesPaused', { count: preservedCount })}
                    />
                  ) : types.length === 0 ? (
                    <StatusTip status="empty" emptyText={t('wiki.detail.overview.emptyPages')} />
                  ) : (
                    <div className="_wiki-detail-type-dist">
                      {types.map((type) => {
                        const count = typeCounts[type];
                        const pct = pages.length ? Math.round((count / pages.length) * 100) : 0;
                        return (
                          <div key={type} className="_wiki-detail-type-row">
                            <span className="_wiki-detail-type-label">
                              <span
                                className="_wiki-detail-type-dot"
                                style={{ background: TYPE_COLORS[type] || TYPE_COLOR_FALLBACK }}
                              />
                              {type}
                            </span>
                            <span className="_wiki-detail-type-bar">
                              <span
                                className="_wiki-detail-type-bar-fill"
                                style={{
                                  width: `${pct}%`,
                                  background: TYPE_COLORS[type] || TYPE_COLOR_FALLBACK,
                                }}
                              />
                            </span>
                            <Text theme="label" className="_wiki-detail-type-count">
                              {t('wiki.detail.typePct', { count, pct })}
                            </Text>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card.Body>
              </Card>
              <Card bordered>
                <Card.Body title={t('wiki.detail.overview.pageList')}>
                  {isProcessing ? (
                    <StatusTip
                      status="loading"
                      emptyText={t('wiki.detail.pagesPaused', { count: preservedCount })}
                    />
                  ) : pages.length === 0 ? (
                    <StatusTip status="empty" emptyText={t('wiki.detail.overview.emptyPageList')} />
                  ) : (
                    <div className="_wiki-detail-overview-grid">
                      {pages.slice(0, 9).map((page) => (
                        <button
                          key={(page as any).id || page.path}
                          onClick={() => {
                            handleReadPage(page);
                            setActiveTab('pages');
                          }}
                          className="_wiki-detail-overview-item"
                        >
                          <span
                            className="_wiki-detail-type-dot"
                            style={{ background: TYPE_COLORS[page.type] || TYPE_COLOR_FALLBACK }}
                          />
                          <span className="_wiki-detail-overview-item-title">{page.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </Card.Body>
              </Card>
            </div>
          </TabPanel>

          <TabPanel id="graph">
            <GraphTabContent
              graphData={graphData}
              graphLoading={graphLoading}
              selectedPage={selectedPage}
              readLoading={readLoading}
              displayContent={displayContent}
              metadata={metadata}
              onNodeClick={(node) => {
                const page =
                  pages.find((item) => ((item as any).id || item.path) === node.id) ||
                  ({ path: node.id, title: node.label, type: node.type } as WikiPage);
                handleReadPage(page);
              }}
              onClearSelection={() => setSelectedPage(null)}
            />
          </TabPanel>
          <TabPanel id="pages">
            <PagesTabContent
              pages={filteredPages}
              allPages={pages}
              types={types}
              typeCounts={typeCounts}
              pageTypeFilter={pageTypeFilter}
              setPageTypeFilter={setPageTypeFilter}
              selectedPage={selectedPage}
              readLoading={readLoading}
              displayContent={displayContent}
              metadata={metadata}
              wikiId={selectedWikiId}
              rawRefreshKey={rawRefreshKey}
              processing={isProcessing}
              preservedCount={preservedCount}
              onReadPage={handleReadPage}
              onDeletePage={handleDeletePage}
              onDeleteRaw={handleDeleteRaw}
              onReadRaw={(filename) => {
                const rawPage = {
                  path: `raw/${filename}`,
                  title: filename,
                  type: 'raw',
                } as WikiPage;
                setSelectedPage(rawPage);
                setReadContent('');
                setReadLoading(true);
                knowledgeApi.wiki
                  .rawRead(selectedWikiId, [filename])
                  .then((result: any) => setReadContent(result?.items?.[0]?.content || ''))
                  .catch((error: any) => {
                    setReadContent('');
                    tea.notify.error(error?.message || t('wiki.notify.readRawFailed'));
                  })
                  .finally(() => setReadLoading(false));
              }}
            />
          </TabPanel>
          <TabPanel id="search">
            <div className="_wiki-detail-search">
              <SearchBox
                value={searchQuery}
                onChange={setSearchQuery}
                onSearch={handleSearch}
                placeholder={t('wiki.detail.search.placeholder')}
              />
              {searching && <StatusTip status="loading" />}
              {!searching && searchResults.length > 0 && (
                <>
                  <Text theme="label">{t('wiki.detail.search.results', { count: searchResults.length })}</Text>
                  <div className="_wiki-detail-search-results">
                    {searchResults.map((result, index) => (
                      <button
                        key={`${result.path}-${index}`}
                        type="button"
                        className="_wiki-detail-search-item"
                        onClick={() => {
                          const page =
                            pages.find((item) => ((item as any).id || item.path) === result.path) ||
                            ({
                              path: result.path,
                              title: result.title,
                              type: result.type,
                            } as WikiPage);
                          handleReadPage(page);
                          setActiveTab('pages');
                        }}
                      >
                        <span className="_wiki-detail-search-item-head">
                          <span
                            className="_wiki-detail-type-dot"
                            style={{ background: TYPE_COLORS[result.type] || TYPE_COLOR_FALLBACK }}
                          />
                          <span className="_wiki-detail-search-item-title">{result.title}</span>
                          <Tag size="sm">{result.type}</Tag>
                          <Text theme="label" className="_wiki-detail-search-item-score">
                            {result.score.toFixed(1)}
                          </Text>
                        </span>
                        {result.snippet && (
                          <Text theme="label" className="_wiki-detail-search-item-snippet">
                            {result.snippet}
                          </Text>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {!searching && searchResults.length === 0 && searchQuery && (
                <StatusTip status="empty" emptyText={t('wiki.detail.search.empty')} />
              )}
              {!searching && isProcessing && searchResults.length === 0 && (
                <Alert type="info" className="_wiki-detail-search-paused">
                  {t('wiki.detail.searchPaused')}
                </Alert>
              )}
            </div>
          </TabPanel>
        </Tabs>

        {/* Add Doc Modal */}
        {showAddDoc && (
          <Modal
            visible
            caption={t('wiki.detail.addDoc.caption', { name: wikiName })}
            size="m"
            onClose={() => setShowAddDoc(false)}
            disableEscape={submitting}
          >
            <Modal.Body>
              <Alert type="info">{t('wiki.detail.addDoc.hint')}</Alert>
              <Tabs
                tabs={[
                  { id: 'file', label: t('wiki.detail.addDoc.file') },
                  { id: 'markdown', label: t('wiki.detail.addDoc.markdown') },
                ]}
                activeId={addDocTab}
                onActive={(tab) => setAddDocTab(tab.id as typeof addDocTab)}
              >
                <TabPanel id="file">
                  <div className="_wiki-detail-upload-panel">
                    <div
                      className="_wiki-detail-dropzone"
                      onClick={() => fileInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const all = Array.from(e.dataTransfer.files);
                        const allowed = all.filter((f) => WIKI_ALLOWED_FILE_RE.test(f.name));
                        const rejected = all.length - allowed.length;
                        if (rejected > 0) {
                          tea.notify.warning(
                            t('wiki.detail.ignored', { count: rejected }),
                          );
                        }
                        if (allowed.length > 0) setPendingFiles((prev) => [...prev, ...allowed]);
                      }}
                    >
                      <Text theme="weak">{t('wiki.detail.dropzone')}</Text>
                    </div>
                    {pendingFiles.length > 0 && (
                      <div className="_wiki-detail-upload-files">
                        {pendingFiles.map((f, i) => (
                          <div key={i} className="_wiki-detail-upload-file">
                            <span className="_wiki-detail-upload-file-name">{f.name}</span>
                            <span className="_wiki-detail-upload-file-size">
                              {(f.size / 1024).toFixed(1)}K
                            </span>
                            {uploadProgress[f.name] === 'done' && (
                              <span className="_wiki-detail-upload-file-success">
                                <CheckIcon size={12} />
                              </span>
                            )}
                            {uploadProgress[f.name] === 'error' && (
                              <span className="_wiki-detail-upload-file-error">
                                <CloseIcon size={12} />
                              </span>
                            )}
                            {uploadProgress[f.name] === 'pending' && (
                              <span className="_wiki-detail-upload-file-pending">…</span>
                            )}
                            {!submitting && (
                              <Button
                                type="text"
                                onClick={() =>
                                  setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                                }
                              >
                                {t('common.delete')}
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {pendingFiles.length > 0 && (
                      <div className="_wiki-detail-upload-footer">
                        <Text theme="weak">{t('wiki.detail.upload.footer', { count: pendingFiles.length })}</Text>
                        <Button
                          type="primary"
                          onClick={handleBatchUpload}
                          disabled={submitting}
                          loading={submitting}
                        >
                          {submitting ? t('wiki.detail.upload.submitting') : t('wiki.detail.upload.confirm')}
                        </Button>
                      </div>
                    )}
                  </div>
                </TabPanel>
                <TabPanel id="markdown">
                  <div className="_wiki-detail-upload-panel">
                    {mdDocs.map((doc, i) => (
                      <div key={i} className="_wiki-detail-markdown-doc">
                        <div className="_wiki-detail-markdown-doc-head">
                          <Input
                            size="full"
                            value={doc.filename}
                            onChange={(v) =>
                              setMdDocs((prev) =>
                                prev.map((d, j) => (j === i ? { ...d, filename: v } : d)),
                              )
                            }
                            width={100}
                            placeholder="filename.md"
                          />
                          {mdDocs.length > 1 && (
                            <Button
                              type="text"
                              onClick={() => setMdDocs((prev) => prev.filter((_, j) => j !== i))}
                            >
                              {t('common.delete')}
                            </Button>
                          )}
                        </div>
                        <Input.TextArea
                          size="full"
                          rows={6}
                          value={doc.content}
                          onChange={(v) =>
                            setMdDocs((prev) =>
                              prev.map((d, j) => (j === i ? { ...d, content: v } : d)),
                            )
                          }
                          placeholder={t('wiki.detail.md.placeholder')}
                        />
                      </div>
                    ))}
                    <Button
                      onClick={() => setMdDocs((prev) => [...prev, { filename: '', content: '' }])}
                    >
                      {t('wiki.detail.md.add')}
                    </Button>
                    <div className="_wiki-detail-upload-footer">
                      <Text theme="weak">
                        {t('wiki.detail.md.pending', { count: mdDocs.filter((d) => d.filename.trim() && d.content.trim()).length })}
                      </Text>
                      <Button
                        type="primary"
                        onClick={handleUploadMdBatch}
                        disabled={
                          submitting || mdDocs.every((d) => !d.filename.trim() || !d.content.trim())
                        }
                        loading={submitting}
                      >
                        {submitting ? t('wiki.detail.upload.submitting') : t('wiki.detail.upload.confirm')}
                      </Button>
                    </div>
                  </div>
                </TabPanel>
              </Tabs>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt,.markdown"
                multiple
                className="_wiki-detail-hidden-input"
                onChange={(e) => {
                  // accept 属性只是浏览器建议，用户可在选择器切换"所有文件"绕过，
                  // 这里做二次校验，与拖拽入口一致，避免二进制文件被读成乱码上传。
                  const all = Array.from(e.target.files ?? []);
                  const allowed = all.filter((f) => WIKI_ALLOWED_FILE_RE.test(f.name));
                  const rejected = all.length - allowed.length;
                  if (rejected > 0) {
                    tea.notify.warning(
                      t('wiki.detail.ignored', { count: rejected }),
                    );
                  }
                  if (allowed.length > 0) setPendingFiles((prev) => [...prev, ...allowed]);
                  e.target.value = '';
                }}
              />
            </Modal.Body>
          </Modal>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // LIST VIEW
  // ═══════════════════════════════════════════
  return (
    <div className="_asset-wiki-page">
      <AssetPageHeader
        title={t('wiki.title')}
        subtitle={
          <Text theme="label">
            {activeTeam
              ? t('wiki.subtitle.team', { name: activeTeam.name, count: stats.total })
              : t('wiki.subtitle.global', { count: stats.total })}
          </Text>
        }
        scope={
          <Segment
            value={scopeTab}
            onChange={(value) => setScopeTab(value as WikiScopeTab)}
            options={(['team', 'fixed'] as WikiScopeTab[]).map((tab) => ({
              value: tab,
              text: t(SCOPE_LABEL_KEYS[tab]),
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
              disabled={teamAgents.length === 0}
              placeholder={t('wiki.noAgentPlaceholder')}
              options={teamAgents.map((agent) => ({
                value: agent.id,
                text: `${agent.name}（${agent.id}）`,
              }))}
            />
          ) : undefined
        }
      />

      <Card className="_asset-wiki-content-card">
        <Card.Body>
          <div className="_asset-wiki-stats">
            <MetricsBoard title={t('wiki.metrics.total')} value={stats.total} />
            <MetricsBoard title={t('wiki.metrics.ready')} value={stats.ready} />
            <MetricsBoard title={t('wiki.metrics.processing')} value={stats.processing} />
            <MetricsBoard title={t('wiki.metrics.totalPages')} value={stats.totalPages} />
          </div>
          <Table.ActionPanel>
            <Justify
              left={
                <Button type="primary" onClick={() => setShowCreate(true)}>
                  {t('wiki.create')}
                </Button>
              }
              right={
                <div className="_asset-wiki-toolbar">
                  <SearchBox
                    value={keyword}
                    onChange={setKeyword}
                    placeholder={t('wiki.searchPlaceholder')}
                  />
                  <Segment
                    value={statusFilter}
                    onChange={(value) => setStatusFilter(value as StatusFilter)}
                    options={[
                      { value: 'all', text: t('wiki.filter.allStatus') },
                      { value: 'ready', text: t('wiki.filter.ready') },
                      { value: 'processing', text: t('wiki.filter.processing') },
                    ]}
                  />
                  <Segment
                    value={viewMode}
                    onChange={(value) => setViewMode(value as ViewMode)}
                    options={[
                      { value: 'card', text: <ViewModuleIcon /> },
                      { value: 'list', text: <ViewListIcon /> },
                    ]}
                  />
                </div>
              }
            />
          </Table.ActionPanel>

          {loading ? (
            <StatusTip status="loading" />
          ) : sources.length === 0 ? (
            <StatusTip
              status="empty"
              emptyText={
                <div className="_asset-wiki-empty">
                  <BooksIcon size="large" />
                  <Text>{t('wiki.empty.title')}</Text>
                  <Text theme="label">{t('wiki.empty.desc')}</Text>
                </div>
              }
            />
          ) : filteredSources.length === 0 ? (
            <StatusTip status="empty" emptyText={t('wiki.empty.filtered')} />
          ) : viewMode === 'card' ? (
            <div className="_asset-wiki-grid">
              {filteredSources.map((source) => (
                <div
                  key={source.wiki_id}
                  className="_asset-wiki-card"
                  onClick={() => openDetail(source.wiki_id)}
                >
                  <div className="_asset-wiki-card-head">
                    <BooksIcon size={16} />
                    <span className="_asset-wiki-card-name" title={source.name}>
                      {source.name}
                    </span>
                    <ChevronRightIcon size={14} className="_asset-wiki-card-chevron" />
                  </div>
                  <div className="_asset-wiki-card-meta">
                    <WikiStatusBadge status={source.status} />
                    <span>
                      {t('wiki.card.pagesAndTime', { pages: source.page_count ?? 0, time: formatShortTime(source.last_sync_at) })}
                    </span>
                  </div>
                  <div className="_asset-wiki-card-owner">
                    <UsergroupIcon size={12} />
                    {scopeTab === 'fixed' ? (
                      t('wiki.fixedAsset', { agent: agentFilter || t('wiki.noAgent') })
                    ) : source.owner_user_id ? (
                      <WikiOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                    ) : (
                      t('wiki.teamPool')
                    )}
                  </div>
                  <div className="_asset-wiki-card-id">{t('wiki.card.id', { id: source.wiki_id })}</div>
                  <WikiActions
                    source={source}
                    scopeTab={scopeTab}
                    ingestBusy={ingestBusy}
                    isCurrentIngesting={runningWikiIds.has(source.wiki_id)}
                    onIngest={handleIngest}
                    onAllocate={setAllocateTarget}
                    onUnbind={handleUnbindWiki}
                    onDelete={handleDelete}
                  />
                </div>
              ))}
            </div>
          ) : (
            <Table
              records={filteredSources}
              recordKey="wiki_id"
              addons={[scrollable({ minWidth: 1040 })]}
              columns={[
                {
                  key: 'name',
                  header: t('wiki.table.name'),
                  width: 240,
                  render: (source) => (
                    <button
                      type="button"
                      className="_asset-wiki-row-name"
                      onClick={() => openDetail(source.wiki_id)}
                    >
                      <BooksIcon size={14} />
                      <span>{source.name}</span>
                      <ChevronRightIcon size={12} />
                    </button>
                  ),
                },
                {
                  key: 'status',
                  header: t('wiki.table.status'),
                  width: 100,
                  render: (source) => <WikiStatusBadge status={source.status} />,
                },
                {
                  key: 'page_count',
                  header: t('wiki.table.pageCount'),
                  width: 80,
                  render: (source) => source.page_count ?? 0,
                },
                {
                  key: 'owner',
                  header: t('wiki.table.owner'),
                  width: 180,
                  render: (source) =>
                    scopeTab === 'fixed' ? (
                      <span className="_asset-wiki-inline-icon">
                        <UsergroupIcon size={12} />
                        {agentFilter || t('wiki.noAgent')}
                      </span>
                    ) : source.owner_user_id ? (
                      <WikiOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                    ) : (
                      <Text theme="label">{t('wiki.teamPool.short')}</Text>
                    ),
                },
                {
                  key: 'last_sync_at',
                  header: t('wiki.table.lastSync'),
                  width: 140,
                  render: (source) => (
                    <Text theme="label">{formatShortTime(source.last_sync_at)}</Text>
                  ),
                },
                {
                  key: 'wiki_id',
                  header: 'Wiki ID',
                  width: 220,
                  render: (source) => <span className="_asset-wiki-id">{source.wiki_id}</span>,
                },
                {
                  key: 'actions',
                  header: t('wiki.table.actions'),
                  width: 240,
                  fixed: 'right',
                  render: (source) => (
                    <WikiActions
                      source={source}
                      scopeTab={scopeTab}
                      ingestBusy={ingestBusy}
                      isCurrentIngesting={runningWikiIds.has(source.wiki_id)}
                      onIngest={handleIngest}
                      onAllocate={setAllocateTarget}
                      onUnbind={handleUnbindWiki}
                      onDelete={handleDelete}
                    />
                  ),
                },
              ]}
            />
          )}
        </Card.Body>
      </Card>

      {/* Create Modal */}
      {showCreate && (
        <Modal
          visible
          caption={t('wiki.create.caption')}
          size="s"
          onClose={() => setShowCreate(false)}
          disableEscape={submitting}
        >
          <Modal.Body>
            <Form>
              <Form.Item label={t('wiki.create.name')} required extra={t('wiki.create.extra')}>
                <Input
                  size="full"
                  value={newName}
                  onChange={setNewName}
                  placeholder={t('wiki.create.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={handleCreate}
              disabled={submitting || !newName.trim()}
              loading={submitting}
            >
              {submitting ? t('wiki.create.submitting') : t('wiki.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={submitting}>
              {t('common.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* Allocate Wiki → Agent (固定资产) */}
      {allocateTarget && (
        <AllocateAssetDialog
          assetType="llm_wiki"
          assetLabel={allocateTarget.name}
          agents={teamAgents}
          team={activeTeam ? { team_id: activeTeam.team_id, name: activeTeam.name } : null}
          onClose={() => setAllocateTarget(null)}
          onAllocate={async (agentId) => {
            if (!activeTeamId) throw new Error(t('wiki.error.selectTeam'));
            await knowledgeApi.wiki.allocate(activeTeamId, allocateTarget.wiki_id, agentId);
            tea.notify.success(t('wiki.notify.allocated'));
            await fetchSources();
            if (scopeTab === 'fixed') await fetchFixedBindings();
          }}
        />
      )}
    </div>
  );
}

function WikiActions({
  source,
  scopeTab,
  ingestBusy,
  isCurrentIngesting,
  onIngest,
  onAllocate,
  onUnbind,
  onDelete,
}: {
  source: WikiDetail;
  scopeTab: WikiScopeTab;
  ingestBusy: boolean;
  /** 当前这条 wiki 自身是否处于 ingest（pending / processing）状态 */
  isCurrentIngesting: boolean;
  onIngest: (wikiId: string) => void;
  onAllocate: (target: { wiki_id: string; name: string }) => void;
  onUnbind: (wikiId: string) => void;
  onDelete: (wikiId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="_asset-wiki-actions" onClick={(event) => event.stopPropagation()}>
      <Button type="weak" disabled={ingestBusy} onClick={() => onIngest(source.wiki_id)}>
        <StarIcon size={14} /> {isCurrentIngesting ? t('wiki.action.ingestBusy') : ingestBusy ? t('wiki.action.queuing') : t('wiki.action.ingest')}
      </Button>
      {scopeTab === 'fixed' ? (
        <Button type="weak" onClick={() => onUnbind(source.wiki_id)}>
          {t('wiki.action.unbind')}
        </Button>
      ) : (
        <Button
          type="weak"
          disabled={source.status !== 'ready'}
          tooltip={
            source.status === 'ready'
              ? undefined
              : t('wiki.action.allocate.disabled')
          }
          onClick={() => onAllocate({ wiki_id: source.wiki_id, name: source.name })}
        >
          {t('wiki.action.allocate')}
        </Button>
      )}
      <Button
        type="icon"
        tooltip={t('wiki.action.delete')}
        onClick={() => onDelete(source.wiki_id, source.name)}
      >
        <DeleteIcon size={14} />
      </Button>
    </div>
  );
}

// ═══════════════════════════════════════════
// Resize Handle
// ═══════════════════════════════════════════
function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return <div className="_wiki-detail-resize-handle" onMouseDown={onMouseDown} />;
}

// ═══════════════════════════════════════════
// Graph Tab (with resizable right panel)
// ═══════════════════════════════════════════
function GraphTabContent({
  graphData,
  graphLoading,
  selectedPage,
  readLoading,
  displayContent,
  metadata,
  onNodeClick,
  onClearSelection,
}: {
  graphData: GraphData | null;
  graphLoading: boolean;
  selectedPage: WikiPage | null;
  readLoading: boolean;
  displayContent: string;
  metadata: Record<string, string> | null;
  onNodeClick: (node: GraphNode) => void;
  onClearSelection: () => void;
}) {
  const { t } = useTranslation();
  const { width: rightW, onMouseDown } = useResizable(320, 200, 500, 'right');

  return (
    <div
      className="_wiki-detail-split"
      style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}
    >
      <div className="_wiki-detail-split-main">
        <KnowledgeGraphEmbed
          data={graphData}
          loading={graphLoading}
          onNodeClick={onNodeClick}
          highlightNode={selectedPage ? (selectedPage as any).id || selectedPage.path : null}
        />
      </div>
      <ResizeHandle onMouseDown={onMouseDown} />
      <div className="_wiki-detail-split-side" style={{ width: rightW }}>
        {selectedPage ? (
          <>
            <div className="_wiki-detail-side-head">
              <Text className="_wiki-detail-side-title">{selectedPage.title}</Text>
              <Button type="text" onClick={onClearSelection}>
                <CloseIcon size={14} />
              </Button>
            </div>
            {metadata && (
              <div className="_wiki-detail-side-tags">
                {metadata.type && <Tag size="sm">{metadata.type}</Tag>}
                {metadata.tags &&
                  metadata.tags
                    .replaceAll('[', '')
                    .replaceAll(']', '')
                    .split(',')
                    .filter(Boolean)
                    .map((tag) => (
                      <Tag key={tag.trim()} size="sm">
                        {tag.trim()}
                      </Tag>
                    ))}
              </div>
            )}
            <div className="_wiki-detail-side-content">
              {readLoading ? (
                <StatusTip status="loading" />
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {displayContent}
                </ReactMarkdown>
              )}
            </div>
          </>
        ) : (
          <div className="_wiki-detail-side-empty">
            <ArchitectureIcon size="large" />
            <Text theme="label">{t('wiki.detail.graph.clickToView')}</Text>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// Pages Tab (with resizable left panel)
// ═══════════════════════════════════════════
function PagesTabContent({
  pages,
  allPages,
  types,
  typeCounts,
  pageTypeFilter,
  setPageTypeFilter,
  selectedPage,
  readLoading,
  displayContent,
  metadata,
  wikiId,
  rawRefreshKey,
  processing,
  preservedCount,
  onReadPage,
  onReadRaw,
  onDeletePage,
  onDeleteRaw,
}: {
  pages: WikiPage[];
  allPages: WikiPage[];
  types: string[];
  typeCounts: Record<string, number>;
  pageTypeFilter: string;
  setPageTypeFilter: (v: string) => void;
  selectedPage: WikiPage | null;
  readLoading: boolean;
  displayContent: string;
  metadata: Record<string, string> | null;
  wikiId: string;
  rawRefreshKey: number;
  /** Wiki is ingesting → page/ls is gated on ready, so the list reads empty. */
  processing?: boolean;
  /** Accurate page count from wiki/get, shown instead of a scary 0. */
  preservedCount?: number;
  onReadPage: (p: WikiPage) => void;
  onReadRaw: (filename: string) => void;
  onDeletePage: (p: WikiPage) => Promise<void> | void;
  onDeleteRaw: (filename: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const { width: leftW, onMouseDown } = useResizable(260, 180, 400, 'left');

  return (
    <div
      className="_wiki-detail-split"
      style={{ height: 'calc(100vh - 280px)', minHeight: '400px' }}
    >
      <div className="_wiki-detail-split-side-left" style={{ width: leftW }}>
        <div className="_wiki-detail-type-filter">
          <button
            className={`_wiki-detail-filter-tag${pageTypeFilter === 'all' ? ' is-active' : ''}`}
            onClick={() => setPageTypeFilter('all')}
          >
            {t('wiki.detail.pages.all', { count: allPages.length })}
          </button>
          {types.map((type) => (
            <button
              key={type}
              className={`_wiki-detail-filter-tag${pageTypeFilter === type ? ' is-active' : ''}`}
              onClick={() => setPageTypeFilter(type)}
            >
              <span
                className="_wiki-detail-type-dot"
                style={{ background: TYPE_COLORS[type] || TYPE_COLOR_FALLBACK }}
              />
              {type} {typeCounts[type]}
            </button>
          ))}
        </div>
        <div className="_wiki-detail-page-list">
          {processing && pages.length === 0 ? (
            <StatusTip
              status="loading"
              emptyText={t('wiki.detail.pagesPaused', { count: preservedCount ?? 0 })}
            />
          ) : (
            pages.map((page) => {
            const active =
              selectedPage &&
              ((selectedPage as any).id || selectedPage.path) === ((page as any).id || page.path);
            return (
              <div
                key={(page as any).id || page.path}
                className={`_wiki-detail-page-row${active ? ' is-active' : ''}`}
              >
                <button className="_wiki-detail-page-item" onClick={() => onReadPage(page)}>
                  <span
                    className="_wiki-detail-type-dot"
                    style={{ background: TYPE_COLORS[page.type] || TYPE_COLOR_FALLBACK }}
                  />
                  <span className="_wiki-detail-page-item-title">{page.title}</span>
                </button>
                <Button
                  type="text"
                  className="_wiki-detail-page-delete"
                  onClick={() => onDeletePage(page)}
                  tooltip={t('wiki.detail.pages.deletePage')}
                >
                  {t('wiki.detail.pages.delete')}
                </Button>
              </div>
            );
            })
          )}
        </div>
        <RawFilesSection
          wikiId={wikiId}
          refreshKey={rawRefreshKey}
          onRead={onReadRaw}
          onDelete={onDeleteRaw}
        />
      </div>
      <ResizeHandle onMouseDown={onMouseDown} />
      <div className="_wiki-detail-split-content">
        {selectedPage ? (
          <div className="_wiki-detail-content-inner">
            <div className="_wiki-detail-content-head">
              <span
                className="_wiki-detail-type-dot _wiki-detail-type-dot-lg"
                style={{ background: TYPE_COLORS[selectedPage.type] || TYPE_COLOR_FALLBACK }}
              />
              <h1 className="_wiki-detail-content-title">{selectedPage.title}</h1>
            </div>
            {metadata && (
              <div className="_wiki-detail-side-tags">
                {metadata.type && <Tag size="sm">{metadata.type}</Tag>}
                {metadata.tags &&
                  metadata.tags
                    .replaceAll('[', '')
                    .replaceAll(']', '')
                    .split(',')
                    .filter(Boolean)
                    .map((tag) => (
                      <Tag key={tag.trim()} size="sm">
                        {tag.trim()}
                      </Tag>
                    ))}
                {metadata.created && <Text theme="label">{t('wiki.detail.created', { date: metadata.created })}</Text>}
              </div>
            )}
            {readLoading ? (
              <StatusTip status="loading" />
            ) : (
              <Card className="_wiki-detail-content-card">
                <Card.Body>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {displayContent}
                  </ReactMarkdown>
                </Card.Body>
              </Card>
            )}
          </div>
        ) : (
          <div className="_wiki-detail-side-empty">
            <BooksIcon size="large" />
            <Text theme="label">{t('wiki.detail.pages.selectPage')}</Text>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// Raw Files Section — 原始文档列表，默认展开
// ═══════════════════════════════════════════
function RawFilesSection({
  wikiId,
  refreshKey,
  onRead,
  onDelete,
}: {
  wikiId: string;
  refreshKey?: number;
  onRead: (filename: string) => void;
  onDelete: (filename: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<{ filename: string; size: number }[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    if (!wikiId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    knowledgeApi.wiki
      .rawList(wikiId)
      .then((r: any) => setFiles(r?.files || []))
      .catch((e: any) => tea.notify.error(e?.message || t('wiki.notify.loadRawFailed')))
      .finally(() => setLoading(false));
  }, [wikiId]);

  // refreshKey 变化（如上传成功后）时强制重载原始文档列表，无需用户手动刷新。
  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  async function handleDelete(filename: string) {
    await onDelete(filename);
    reload();
  }

  // 加载中显示占位提示，避免请求期间直接渲染空态（return null）导致用户无感知。
  if (loading)
    return (
      <div className="_wiki-detail-rawfiles-loading">
        <FolderIcon size={12} /> {t('wiki.detail.rawFiles.loading')}
      </div>
    );
  if (files.length === 0) return null;

  return (
    <div className="_wiki-detail-rawfiles">
      <button className="_wiki-detail-rawfiles-toggle" onClick={() => setExpanded(!expanded)}>
        <span>
          <FolderIcon size={12} /> {t('wiki.detail.rawFiles.title', { count: files.length })}
        </span>
        <ChevronRightIcon size={12} className={expanded ? 'is-open' : ''} />
      </button>
      {expanded && (
        <div className="_wiki-detail-rawfiles-list">
          {files.map((file) => (
            <div key={file.filename} className="_wiki-detail-rawfiles-item">
              <button onClick={() => onRead(file.filename)}>
                <FileIcon size={12} />
                <span>{file.filename}</span>
                <em>{(file.size / 1024).toFixed(1)}K</em>
              </button>
              <Button
                type="text"
                className="_wiki-detail-page-delete"
                onClick={() => void handleDelete(file.filename)}
                tooltip={t('wiki.detail.rawFiles.deleteRaw')}
              >
                {t('common.delete')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// Knowledge Graph Embed (lazy loaded sigma)
// ═══════════════════════════════════════════
const KnowledgeGraphLazy = lazy(() => import('./KnowledgeGraph'));

function KnowledgeGraphEmbed({
  data,
  loading,
  onNodeClick,
  highlightNode,
}: {
  data: GraphData | null;
  loading: boolean;
  onNodeClick: (node: GraphNode) => void;
  highlightNode: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<StatusTip status="loading" loadingText={t('wiki.detail.graph.loading')} />}>
      <KnowledgeGraphLazy
        data={data}
        loading={loading}
        onNodeClick={onNodeClick}
        highlightNode={highlightNode}
        className="_wiki-detail-graph-embed"
      />
    </Suspense>
  );
}