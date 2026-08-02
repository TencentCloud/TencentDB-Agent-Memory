import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Alert, Button, Card, Form, Input, Justify, Modal, Segment, Select, Table, Tag, Text, SearchBox, StatusTip, MetricsBoard,
} from 'tea-component';
import {
  ArrowLeftIcon,
  RefreshIcon,
  CodeIcon,
  ChevronRightIcon,
  DeleteIcon,
  UsergroupIcon,
  ViewListIcon,
  ViewModuleIcon,
} from 'tea-icons-react';
import { knowledgeApi, type CodeGraphDetail } from '@/lib/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import AllocateAssetDialog from '@/pages/ResourcePage/components/AllocateAssetDialog';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { AssetPageHeader } from '@/pages/ResourcePage/components/AssetPageHeader';
import './code-sources-panel.css';

// Markdown 渲染排版（内容排版，非 Tea 组件替换范围）——保留原实现，见 design-system 例外条款。
const mdComponents = {
  h2: ({ children, ...p }: any) => <h2 className="text-[13px] font-semibold mb-2 mt-4 text-foreground/85" {...p}>{children}</h2>,
  h3: ({ children, ...p }: any) => <h3 className="text-[12px] font-semibold mb-1 mt-3 font-mono text-foreground/85" {...p}>{children}</h3>,
  p: ({ children, ...p }: any) => <p className="text-[12px] text-muted-foreground mb-2 leading-relaxed" {...p}>{children}</p>,
  ul: ({ children, ...p }: any) => <ul className="text-[12px] text-muted-foreground list-disc pl-4 mb-2 space-y-0.5" {...p}>{children}</ul>,
  ol: ({ children, ...p }: any) => <ol className="text-[12px] text-muted-foreground list-decimal pl-4 mb-2 space-y-0.5" {...p}>{children}</ol>,
  li: ({ children, ...p }: any) => <li className="text-[12px]" {...p}>{children}</li>,
  code: ({ children, className, ...p }: any) => {
    if (className?.includes('language-')) return <pre className="rounded-lg bg-muted p-3 text-[11px] font-mono overflow-x-auto my-2 border border-border"><code {...p}>{children}</code></pre>;
    return <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono" {...p}>{children}</code>;
  },
  pre: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  hr: () => <hr className="my-3 border-border" />,
  strong: ({ children, ...p }: any) => <strong className="font-semibold text-foreground/85" {...p}>{children}</strong>,
  table: ({ children, ...p }: any) => <div className="overflow-x-auto my-2"><table className="w-full text-[11px] border-collapse border border-border" {...p}>{children}</table></div>,
  th: ({ children, ...p }: any) => <th className="border border-border px-2 py-1.5 bg-muted text-left text-[11px] font-semibold" {...p}>{children}</th>,
  td: ({ children, ...p }: any) => <td className="border border-border px-2 py-1.5 text-[11px]" {...p}>{children}</td>,
};

type SubView = 'list' | 'detail';
type ViewMode = 'card' | 'list';
type StatusFilter = 'all' | 'ready' | 'processing' | 'error';

const { scrollable } = Table.addons;

function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 校验是否为合法的 HTTP(S) Git 仓库地址（正则匹配）。
 * 要求：http/https 协议、host 含点（真实域名）、路径不含空格且以 .git 结尾。
 * 用正则而非 URL 解析 —— new URL() 会接受路径中的空格（如 /a b/repo.git），
 * 且不强制 .git 后缀，均不符合 code graph 注册的严格约束。
 * SSH（git@...）不在此判定为 true —— 由调用方单独提示"暂不支持 SSH"。
 */
const GIT_HTTP_URL_RE = /^https?:\/\/[^\s/]+\.[^\s/]+\/[^\s]+\.git$/i;
function isValidGitHttpUrl(raw: string): boolean {
  return GIT_HTTP_URL_RE.test(raw.trim());
}

type ScopeTab = 'team' | 'fixed';
const SCOPE_LABELS: Record<ScopeTab, string> = {
  team: '团队 Code 池',
  fixed: 'Agent 资产',
};

/**
 * Owner 展示 —— 走 user-profile-store 全局缓存，同一 owner 多行共享。
 * 抽子组件是 Rules of Hooks 要求（不能在 .map 里循环调 hook）。
 */
function CodeOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
  const name = useUserDisplayName(userId);
  return (
    <span title={`Owner: ${userId}`}>
      @{name || userId}
      {userId === currentUserId && <span className="_codelist-card-meta-you">（你）</span>}
    </span>
  );
}

// 状态 → Tea Tag 语义主题映射（soft 变体），对齐 Memory 的 statusTheme。
function statusLabel(s: string) {
  const map: Record<string, [string, 'default' | 'success' | 'warning' | 'error']> = {
    ready: ['就绪', 'success'],
    pending: ['排队中', 'warning'],
    processing: ['构建中', 'warning'],
    failed: ['失败', 'error'],
    cloning: ['克隆中', 'warning'],
    indexing: ['索引中', 'warning'],
    syncing: ['同步中', 'warning'],
    error: ['错误', 'error'],
    missing: ['已丢失', 'error'],
  };
  const [label, theme] = map[s] ?? [s, 'default'];
  const hint = (s === 'pending' || s === 'processing') ? ' · 可能需要数分钟' : '';
  return <Tag theme={theme} variant="soft" size="sm">{label}{hint}</Tag>;
}

export default function CodeSourcesPanel() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<CodeGraphDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [scopeTab, setScopeTab] = useState<ScopeTab>('team');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('codePanel.viewMode') : null;
    return saved === 'list' ? 'list' : 'card';
  });
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [inFlight, setInFlight] = useState<CodeGraphDetail[]>([]);

  // Detail view state
  const [subView, setSubView] = useState<SubView>('list');
  const [selectedCgId, setSelectedCgId] = useState('');

  // Register dialog state
  const [showRegister, setShowRegister] = useState(false);
  const [formRepo, setFormRepo] = useState('');
  const [formBranch, setFormBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);

  // Allocate-to-agent dialog state
  const [allocateTarget, setAllocateTarget] = useState<{ cgId: string; repo: string; branch: string } | null>(null);
  const [selectedCodeAsset, setSelectedCodeAsset] = useState<{ cgId: string; repo: string; branch: string } | null>(null);
  const { activeTeamId, activeTeam } = useTeams();
  const auth = readAuth();
  const currentUser = auth?.user_id ?? '';
  // 固定资产 tab 只列自己 owner 的 agent（与 ChatMemory / Skills 面板一致，
  // 也符合文档 §4.2 权限规则：agent-fixed 只允许查看 caller 自己 owner 的 agent）。
  const { agents: allAgents } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () => allAgents
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
    if (!agentFilter) { setFixedBoundIds(new Set()); return; }
    try {
      const items = await knowledgeApi.code.agentFixed(agentFilter);
      setFixedBoundIds(new Set(items.map((it) => it.knowledge_id)));
    } catch (e: any) {
      tea.notify.error(e?.message || '加载固定资产失败');
      setFixedBoundIds(new Set());
    }
  }, [agentFilter]);

  useEffect(() => {
    if (scopeTab === 'fixed') void fetchFixedBindings();
  }, [scopeTab, fetchFixedBindings]);

  const displaySources = useMemo(() => {
    // team tab 下合并 inFlight（刚注册的仓库还在构建中，列表里先占位显示）
    if (scopeTab === 'team') {
      const ids = new Set(sources.map((s) => s.code_graph_id));
      const extras = inFlight.filter((x) => x.code_graph_id && !ids.has(x.code_graph_id));
      return [...extras, ...sources];
    }
    return sources;
  }, [sources, inFlight, scopeTab]);

  const scopeSources = useMemo(() => {
    if (scopeTab === 'team') return displaySources;
    if (scopeTab === 'fixed') {
      if (!agentFilter) return [];
      return displaySources.filter((source) => source.code_graph_id && fixedBoundIds.has(source.code_graph_id));
    }
    return displaySources;
  }, [displaySources, scopeTab, agentFilter, fixedBoundIds]);

  // 统计只跟随当前资产范围，避免搜索或状态筛选让概览数据失真。
  const stats = useMemo(() => ({
    total: scopeSources.length,
    ready: scopeSources.filter((source) => source.status === 'ready').length,
    processing: scopeSources.filter((source) => source.status === 'pending' || source.status === 'processing').length,
    totalFiles: scopeSources.reduce((total, source) => total + (source.stats?.files ?? 0), 0),
  }), [scopeSources]);

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
    if (!activeTeamId) { setSources([]); setLoading(false); return; }
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
            } catch (e: any) {
              // 幂等：asset 已存在 / 409 → 忽略；其它真错报出来便于排查
              // （callback S2S 是主力，这里只是兜底，但失败要可见）
              const msg = e?.message || String(e);
              if (!/already|exist|409|registered|ok/i.test(msg)) {
                tea.notify.error(`注册 meta 失败: ${msg}`);
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
    const timer = setInterval(() => { void poll(); }, 8000);
    return () => clearInterval(timer);
  }, [hasInFlight, activeTeamId, fetchSources]);

  async function handleUnbindCode(codeGraphId: string) {
    if (!agentFilter) return;
    const ok = await tea.confirm({
      message: '确认解绑该代码图谱？',
      description: '将从当前 agent 移除该代码图谱绑定。',
      okText: '解绑',
    });
    if (!ok) return;
    try {
      await knowledgeApi.code.unbind(codeGraphId, agentFilter);
      tea.notify.success('已解绑');
      if (selectedCodeAsset?.cgId === codeGraphId) setSelectedCodeAsset(null);
      await fetchFixedBindings();
      await fetchSources();
    } catch (e: any) {
      tea.notify.error(e?.message || '解绑失败');
    }
  }

  const handleRegister = async () => {
    const repo = formRepo.trim();
    if (!repo || !formBranch.trim() || !activeTeamId) return;
    // 防御性校验：按钮已按 validUrl 禁用，这里再挡一层防止绕过
    if (!isValidGitHttpUrl(repo)) {
      tea.notify.error('请输入合法的 HTTPS Git 仓库地址，且必须以 .git 结尾（如 https://gitlab.example.com/namespace/repo.git），不能含空格。');
      return;
    }
    setSubmitting(true);
    try {
      const detail = await knowledgeApi.code.create(activeTeamId, repo, formBranch.trim(), repo);
      setShowRegister(false); setFormRepo(''); setFormBranch('main');
      setScopeTab('team');
      setInFlight((prev) => [...prev.filter((x) => x.code_graph_id !== detail.code_graph_id), detail]);
      tea.notify.info('仓库已注册，正在构建代码图谱，可能需要数分钟');
      fetchSources();
    } catch (e: any) { tea.notify.error(e); }
    finally { setSubmitting(false); }
  };

  const handleSync = async (cgId: string) => {
    try { await knowledgeApi.code.sync(cgId); fetchSources(); }
    catch (e: any) { tea.notify.error(e); }
  };

  const handleDelete = async (cgId: string) => {
    const source = sources.find(s => s.code_graph_id === cgId);
    if (!source) return;
    const ok = await tea.confirm({
      message: `确定要删除仓库「${source.repo_name || source.repo_url} (${source.branch})」吗？`,
      okText: '删除',
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
      tea.notify.success('已删除');
      fetchSources();
    } catch (e: any) { tea.notify.error(e); }
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
      const res = await knowledgeApi.code.search(selectedCgId, searchQuery, 'any', 20);
      setSearchResult(res?.text || JSON.stringify(res, null, 2));
    } catch (e: any) {
      setSearchResult(`Error: ${e.message}`);
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
    } catch (e: any) {
      setExploreResult(`Error: ${e.message}`);
    } finally {
      setExploring(false);
    }
  };

  const selected = displaySources.find((source) => source.code_graph_id === selectedCgId);

  // ══════════════════════════════════ 详情视图 ══════════════════════════════════
  if (subView === 'detail') {
    const selRepo = selected?.repo_name ?? '';
    const selBranch = selected?.branch ?? '';
    return (
      <div className="_codedetail-root">
        {/* 返回面包屑 */}
        <div className="_codedetail-breadcrumb">
          <Button type="link" onClick={() => setSubView('list')}>
            <span className="_codedetail-inline-icon"><ArrowLeftIcon size={14} /> Code_Graph</span>
          </Button>
          <span className="_codedetail-breadcrumb-sep">/</span>
          <span className="_codedetail-breadcrumb-current _codedetail-mono">{selRepo}</span>
        </div>

        {/* 头部 */}
        <Card>
          <Card.Body className="_codedetail-header-body">
            <div className="_codedetail-header-row">
              <div className="_codedetail-header-left">
                <CodeIcon size={18} />
                <span className="_codedetail-title" title={selRepo}>{selRepo}</span>
                <Text theme="label">{selBranch}</Text>
                {selected?.commit_hash && <Text theme="label" className="_codedetail-mono">@ {selected.commit_hash}</Text>}
                {selected && statusLabel(selected.status)}
                {selected?.last_sync_at && <Text theme="label">{new Date(selected.last_sync_at).toLocaleString()}</Text>}
              </div>
              <div className="_codedetail-header-actions">
                <Button type="primary" onClick={() => handleSync(selectedCgId)}>
                  <span className="_codedetail-inline-icon"><RefreshIcon size={14} />{t('common.refresh', { defaultValue: '同步' })}</span>
                </Button>
              </div>
            </div>
          </Card.Body>
        </Card>

        {selected?.sync_error && <Alert type="error" className="_codedetail-error">{selected.sync_error}</Alert>}

        {/* 统计 */}
        {selected?.stats && (
          <div className="_codedetail-stats">
            <MetricsBoard title={t('common.type', { defaultValue: '文件' })} value={selected.stats.files?.toLocaleString() ?? '-'} />
            <MetricsBoard title="Nodes" value={selected.stats.nodes?.toLocaleString() ?? '-'} />
            <MetricsBoard title="Edges" value={selected.stats.edges?.toLocaleString() ?? '-'} />
          </div>
        )}

        {/* 仓库信息 */}
        {selected && (
          <Card>
            <Card.Body title={t('code.repos', { defaultValue: '仓库信息' })}>
              <div className="_codedetail-info-grid">
                <Text theme="label">Code Graph ID</Text>
                <Text className="_codedetail-mono">{selected.code_graph_id}</Text>
                <Text theme="label">Git URL</Text>
                <Text className="_codedetail-mono">{selected.repo_url || '—'}</Text>
                <Text theme="label">{t('common.updatedAt', { defaultValue: '最后同步' })}</Text>
                <Text>{selected.last_sync_at ? new Date(selected.last_sync_at).toLocaleString() : '—'}</Text>
              </div>
            </Card.Body>
          </Card>
        )}

        {/* 代码搜索 */}
        <Card>
          <Card.Body title={t('code.symbols', { defaultValue: '代码搜索' })}>
            <div className="_codedetail-search-row">
              <SearchBox
                size="full"
                value={searchQuery}
                onChange={(v) => setSearchQuery(v)}
                onSearch={() => void handleSearch()}
                placeholder={t('code.searchPlaceholder', { defaultValue: '搜索代码符号或文件...' })}
              />
            </div>
            {searching && <StatusTip status="loading" />}
            {!searching && searchResult && (
              <div className="_codedetail-result-box">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{searchResult}</ReactMarkdown>
              </div>
            )}
          </Card.Body>
        </Card>

        {/* 代码探索 */}
        <Card>
          <Card.Body title="代码探索">
            <Text theme="label" parent="div" className="_codedetail-hint">
              一次返回相关文件的完整原文与调用关系，让 AI 直接拿到上下文，无需再逐个 grep / 读文件。适合"这个功能是怎么实现的"。
            </Text>
            <div className="_codedetail-search-row">
              <SearchBox
                size="full"
                value={exploreQuery}
                onChange={(v) => setExploreQuery(v)}
                onSearch={() => void handleExplore()}
                placeholder="用自然语言或符号名描述要理解的功能 / 流程，返回相关文件原文…"
              />
            </div>
            {exploring && <StatusTip status="loading" />}
            {!exploring && exploreResult && (
              <div className="_codedetail-result-box">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{exploreResult}</ReactMarkdown>
              </div>
            )}
          </Card.Body>
        </Card>
      </div>
    );
  }

  // ══════════════════════════════════ 列表视图 ══════════════════════════════════
  return (
    <div className="_asset-code-page">
      <AssetPageHeader
        title="Code_Graph"
        scope={(
          <Segment
            value={scopeTab}
            onChange={(value) => setScopeTab(value as ScopeTab)}
            options={(['team', 'fixed'] as ScopeTab[]).map((tab) => ({ value: tab, text: SCOPE_LABELS[tab] }))}
          />
        )}
        agent={scopeTab === 'fixed' ? (
          <Select
            appearance="button"
            matchButtonWidth
            value={agentFilter}
            onChange={setAgentFilter}
            disabled={teamAgents.length === 0}
            placeholder="无可选 Agent"
            options={teamAgents.map((agent) => ({ value: agent.id, text: `${agent.name}（${agent.id}）` }))}
          />
        ) : undefined}
        subtitle={activeTeam ? `${activeTeam.name} · 共 ${stats.total} 个仓库` : `共 ${stats.total} 个仓库`}
        actions={scopeTab !== 'fixed' ? (
          <Button
            onClick={() => setAllocateTarget(selectedCodeAsset)}
            disabled={!selectedCodeAsset}
            tooltip={!selectedCodeAsset ? '请先选中一条代码资产' : undefined}
          >
            分配到 Agent
          </Button>
        ) : undefined}
      />

      <Card className="_asset-code-content-card">
          <Card.Body>
            <div className="_asset-code-stats">
              <MetricsBoard title="仓库总数" value={stats.total} />
              <MetricsBoard title="已就绪" value={stats.ready} />
              <MetricsBoard title="处理中" value={stats.processing} />
              <MetricsBoard title="文件总数" value={stats.totalFiles} />
            </div>
            <Table.ActionPanel>
              <Justify
                left={<Button type="primary" onClick={() => setShowRegister(true)}>+ 注册仓库</Button>}
                right={(
                  <div className="_asset-code-toolbar">
                    <SearchBox
                      value={keyword}
                      onChange={setKeyword}
                      placeholder="搜索名称 / 分支 / ID"
                    />
                    <Segment
                      value={statusFilter}
                      onChange={(value) => setStatusFilter(value as StatusFilter)}
                      options={[
                        { value: 'all', text: '全部状态' },
                        { value: 'ready', text: '就绪' },
                        { value: 'processing', text: '处理中' },
                        { value: 'error', text: '异常' },
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
                )}
              />
            </Table.ActionPanel>

            {loading ? (
              <StatusTip status="loading" />
            ) : displaySources.length === 0 ? (
              <StatusTip
                status="empty"
                emptyText={(
                  <div className="_asset-code-empty">
                    <CodeIcon size="large" />
                    <Text>暂无已注册仓库</Text>
                    <Text theme="label">点击上方“+ 注册仓库”注册第一个</Text>
                  </div>
                )}
              />
            ) : filteredSources.length === 0 ? (
              <StatusTip status="empty" emptyText="没有匹配的仓库，试试调整搜索或筛选条件。" />
            ) : viewMode === 'card' ? (
              <div className="_codelist-grid">
                {filteredSources.map((source) => {
                  const isSelected = selectedCodeAsset?.cgId === source.code_graph_id;
                  const repoLabel = source.repo_name || source.repo_url;
                  return (
                    <div
                      key={source.code_graph_id}
                      className={`_codelist-card ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => setSelectedCodeAsset({ cgId: source.code_graph_id, repo: repoLabel, branch: source.branch })}
                    >
                      <button
                        type="button"
                        className="_codelist-card-head _codelist-card-name-trigger"
                        onClick={(event) => { event.stopPropagation(); openDetail(source.code_graph_id); }}
                        title={`查看 ${repoLabel} 详情`}
                      >
                        <CodeIcon size={16} />
                        <span className="_codelist-card-name">{repoLabel}</span>
                        <ChevronRightIcon size={14} className="_codelist-card-chevron" />
                      </button>
                      <div className="_codelist-card-meta">
                        {statusLabel(source.status)}
                        <span>分支 {source.branch}</span>
                        {source.commit_hash && <span className="_codedetail-mono">@ {source.commit_hash}</span>}
                        {source.stats && <span>{source.stats.nodes.toLocaleString()} nodes · {source.stats.files.toLocaleString()} files</span>}
                        <span>{formatShortTime(source.last_sync_at)}</span>
                      </div>
                      <div className="_codelist-card-owner">
                        <UsergroupIcon size={12} />
                        {scopeTab === 'fixed' ? (
                          `固定资产 · ${agentFilter || '未选择 Agent'}`
                        ) : source.owner_user_id ? (
                          <CodeOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                        ) : (
                          '团队 Code 池'
                        )}
                      </div>
                      <div className="_codelist-card-id">ID：{source.code_graph_id}</div>
                      <div className="_codelist-card-actions" onClick={(event) => event.stopPropagation()}>
                        {scopeTab === 'fixed' ? (
                          <Button type="weak" onClick={() => handleUnbindCode(source.code_graph_id)}>
                            <span className="_codelist-inline-icon"><UsergroupIcon size={14} />解绑</span>
                          </Button>
                        ) : (
                          <Button type="weak" onClick={() => setAllocateTarget({ cgId: source.code_graph_id, repo: repoLabel, branch: source.branch })}>分配</Button>
                        )}
                        <Button type="icon" tooltip="同步" onClick={() => handleSync(source.code_graph_id)}>
                          <RefreshIcon size={14} />
                        </Button>
                        <Button type="icon" tooltip="删除" onClick={() => handleDelete(source.code_graph_id)}>
                          <DeleteIcon size={14} />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Table
                records={filteredSources}
                recordKey="code_graph_id"
                addons={[scrollable({ minWidth: 1120 })]}
                columns={[
                  {
                    key: 'repo_name',
                    header: '仓库',
                    width: 250,
                    render: (source) => (
                      <button
                        type="button"
                        className="_codelist-row-name"
                        onClick={() => openDetail(source.code_graph_id)}
                        title={`查看 ${source.repo_name || source.repo_url} 详情`}
                      >
                        <CodeIcon size={14} />
                        <span>{source.repo_name || source.repo_url}</span>
                        <ChevronRightIcon size={12} />
                      </button>
                    ),
                  },
                  {
                    key: 'status',
                    header: '状态',
                    width: 120,
                    render: (source) => statusLabel(source.status),
                  },
                  {
                    key: 'branch',
                    header: '分支 / Commit',
                    width: 190,
                    render: (source) => (
                      <span className="_codelist-branch">
                        <span>{source.branch}</span>
                        {source.commit_hash && <span className="_codedetail-mono">@ {source.commit_hash}</span>}
                      </span>
                    ),
                  },
                  {
                    key: 'stats',
                    header: '图谱统计',
                    width: 150,
                    render: (source) => source.stats ? `${source.stats.nodes.toLocaleString()} nodes · ${source.stats.files.toLocaleString()} files` : '—',
                  },
                  {
                    key: 'owner',
                    header: '归属',
                    width: 180,
                    render: (source) => scopeTab === 'fixed' ? (
                      <span className="_codelist-inline-icon"><UsergroupIcon size={12} />{agentFilter || '未选择 Agent'}</span>
                    ) : source.owner_user_id ? (
                      <CodeOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                    ) : (
                      <Text theme="label">团队池</Text>
                    ),
                  },
                  {
                    key: 'last_sync_at',
                    header: '最后更新时间',
                    width: 140,
                    render: (source) => <Text theme="label">{formatShortTime(source.last_sync_at)}</Text>,
                  },
                  {
                    key: 'code_graph_id',
                    header: 'Code Graph ID',
                    width: 200,
                    render: (source) => <span className="_codelist-id">{source.code_graph_id}</span>,
                  },
                  {
                    key: 'actions',
                    header: '操作',
                    width: 280,
                    fixed: 'right',
                    render: (source) => {
                      const repoLabel = source.repo_name || source.repo_url;
                      return (
                        <div className="_codelist-table-actions">
                          {scopeTab === 'fixed' ? (
                            <Button type="link" onClick={() => handleUnbindCode(source.code_graph_id)}>解绑</Button>
                          ) : (
                            <Button type="link" onClick={() => setAllocateTarget({ cgId: source.code_graph_id, repo: repoLabel, branch: source.branch })}>分配</Button>
                          )}
                          <Button type="link" onClick={() => handleSync(source.code_graph_id)}>同步</Button>
                          <Button type="link" onClick={() => handleDelete(source.code_graph_id)} className="_codelist-delete-action">删除</Button>
                        </div>
                      );
                    },
                  },
                ]}
              />
            )}
          </Card.Body>
      </Card>

      {/* Register Modal */}
      {showRegister && (() => {
        const trimmedRepo = formRepo.trim();
        const isSsh = trimmedRepo.startsWith('git@');
        const validUrl = isValidGitHttpUrl(trimmedRepo);
        // 已输入内容、非 SSH、但又不是合法 http(s) 地址 → 提示格式错误。
        const showUrlError = !!trimmedRepo && !isSsh && !validUrl;
        return (
        <Modal visible caption="注册代码仓库" size="m" onClose={() => setShowRegister(false)} disableEscape={submitting}>
          <Modal.Body>
            <Form>
              <Form.Item label="Git URL" required extra="注册后将自动 clone 并建立代码索引。">
                <Input
                  size="full"
                  value={formRepo}
                  onChange={setFormRepo}
                  placeholder="https://gitlab.example.com/namespace/repo.git"
                />
              </Form.Item>
              {isSsh && (
                <Form.Item><Alert type="warning">当前版本不支持 SSH 格式的仓库地址，请改用 HTTPS 格式（如 https://gitlab.example.com/namespace/repo.git）。</Alert></Form.Item>
              )}
              {showUrlError && (
                <Form.Item><Alert type="error">请输入合法的 HTTP(S) Git 仓库地址，且必须以 .git 结尾（如 https://gitlab.example.com/namespace/repo.git），不能含空格。</Alert></Form.Item>
              )}
              <Form.Item label="分支" required>
                <Input size="full" value={formBranch} onChange={setFormBranch} placeholder="main" />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" onClick={handleRegister} disabled={submitting || !formBranch.trim() || !validUrl} loading={submitting}>
              {submitting ? '注册中…' : '注册'}
            </Button>
            <Button onClick={() => setShowRegister(false)} disabled={submitting}>取消</Button>
          </Modal.Footer>
        </Modal>
        );
      })()}

      {/* Allocate Code-Graph → Agent (固定资产) */}
      {allocateTarget && (
        <AllocateAssetDialog
          assetType="code_graph"
          assetLabel={`${allocateTarget.repo} (${allocateTarget.branch})`}
          agents={teamAgents}
          team={activeTeam ? { team_id: activeTeam.team_id, name: activeTeam.name } : null}
          onClose={() => setAllocateTarget(null)}
          onAllocate={async (agentId) => {
            if (!activeTeamId) throw new Error('请先选择 team');
            await knowledgeApi.code.allocate(activeTeamId, allocateTarget.cgId, agentId);
            tea.notify.success('已分配到 Agent');
            await fetchSources();
            if (scopeTab === 'fixed') await fetchFixedBindings();
          }}
        />
      )}
    </div>
  );
}
