import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  Modal,
  Segment,
  Select,
  Table,
  Tag,
  Text,
  SearchBox,
  StatusTip,
  MetricsBoard,
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
  h2: ({ children, ...p }: any) => (
    <h2 className="text-[13px] font-semibold mb-2 mt-4 text-foreground/85" {...p}>
      {children}
    </h2>
  ),
  h3: ({ children, ...p }: any) => (
    <h3 className="text-[12px] font-semibold mb-1 mt-3 font-mono text-foreground/85" {...p}>
      {children}
    </h3>
  ),
  p: ({ children, ...p }: any) => (
    <p className="text-[12px] text-muted-foreground mb-2 leading-relaxed" {...p}>
      {children}
    </p>
  ),
  ul: ({ children, ...p }: any) => (
    <ul className="text-[12px] text-muted-foreground list-disc pl-4 mb-2 space-y-0.5" {...p}>
      {children}
    </ul>
  ),
  ol: ({ children, ...p }: any) => (
    <ol className="text-[12px] text-muted-foreground list-decimal pl-4 mb-2 space-y-0.5" {...p}>
      {children}
    </ol>
  ),
  li: ({ children, ...p }: any) => (
    <li className="text-[12px]" {...p}>
      {children}
    </li>
  ),
  code: ({ children, className, ...p }: any) => {
    if (className?.includes('language-'))
      return (
        <pre className="rounded-lg bg-muted p-3 text-[11px] font-mono overflow-x-auto my-2 border border-border">
          <code {...p}>{children}</code>
        </pre>
      );
    return (
      <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono" {...p}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  hr: () => <hr className="my-3 border-border" />,
  strong: ({ children, ...p }: any) => (
    <strong className="font-semibold text-foreground/85" {...p}>
      {children}
    </strong>
  ),
  table: ({ children, ...p }: any) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-[11px] border-collapse border border-border" {...p}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...p }: any) => (
    <th
      className="border border-border px-2 py-1.5 bg-muted text-left text-[11px] font-semibold"
      {...p}
    >
      {children}
    </th>
  ),
  td: ({ children, ...p }: any) => (
    <td className="border border-border px-2 py-1.5 text-[11px]" {...p}>
      {children}
    </td>
  ),
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

/**
 * 从 Git URL 提取可读的仓库名称。
 *
 * repo_name 可能为空（旧数据），此时回退到 URL 会显得很长。
 * 这里从 URL 中提取最后两段路径作为 `namespace/repo` 格式：
 *   https://gitlab.example.com/namespace/repo.git → namespace/repo
 *   https://github.com/org/project.git → org/project
 *   https://git.woa.com/group/sub/repo.git → sub/repo
 * 如果只有一段路径，直接返回该段（去掉 .git 后缀）。
 * 解析失败时返回原始 URL（保底）。
 */
function formatRepoName(repoName: string, repoUrl: string): string {
  if (repoName && !repoName.startsWith('http')) return repoName;
  const url = repoName || repoUrl;
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0];
  } catch {
    // fallback
  }
  return url;
}

type ScopeTab = 'team' | 'fixed';

/**
 * Owner 展示 —— 走 user-profile-store 全局缓存，同一 owner 多行共享。
 * 抽子组件是 Rules of Hooks 要求（不能在 .map 里循环调 hook）。
 */
function CodeOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span title={t('code.detail.owner', { userId })}>
      @{name || userId}
      {userId === currentUserId && (
        <span className="_codelist-card-meta-you">{t('code.detail.you')}</span>
      )}
    </span>
  );
}

// 状态 → Tea Tag 语义主题映射（soft 变体），对齐 Memory 的 statusTheme。
function statusLabel(t: (key: string, options?: Record<string, unknown>) => string, s: string) {
  const map: Record<string, [string, 'default' | 'success' | 'warning' | 'error']> = {
    ready: [t('code.status.ready'), 'success'],
    pending: [t('code.status.pending'), 'warning'],
    processing: [t('code.status.processing'), 'warning'],
    failed: [t('code.status.failed'), 'error'],
    cloning: [t('code.status.cloning'), 'warning'],
    indexing: [t('code.status.indexing'), 'warning'],
    syncing: [t('code.status.syncing'), 'warning'],
    error: [t('code.status.error'), 'error'],
    missing: [t('code.status.missing'), 'error'],
  };
  const [label, theme] = map[s] ?? [s, 'default'];
  const hint = s === 'pending' || s === 'processing' ? t('code.statusHint.processing') : '';
  return (
    <Tag theme={theme} variant="soft" size="sm">
      {label}
      {hint}
    </Tag>
  );
}

export default function CodeSourcesPanel() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<CodeGraphDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [scopeTab, setScopeTab] = useState<ScopeTab>('team');
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
  // 私有仓库认证：none=公开；token=access_token URL 注入；ssh=私钥注入
  const [formAuthMethod, setFormAuthMethod] = useState<'none' | 'token' | 'ssh'>('none');
  const [formToken, setFormToken] = useState('');
  const [formTokenUsername, setFormTokenUsername] = useState('');
  const [formSshKey, setFormSshKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
    } catch (e: any) {
      tea.notify.error(e?.message || t('code.notify.loadFixedFailed'));
      setFixedBoundIds(new Set());
    }
  }, [agentFilter, t]);

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
    } catch (e: any) {
      tea.notify.error(e?.message || t('code.notify.unbindFailed'));
    }
  }

  const handleRegister = async () => {
    const repo = formRepo.trim();
    if (!repo || !formBranch.trim() || !activeTeamId) return;
    // 防御性校验：按钮已按 canSubmit 禁用，这里再挡一层防止绕过
    const isSsh = repo.startsWith('git@');
    const authedSsh = isSsh && formAuthMethod === 'ssh' && !!formSshKey.trim();
    if (!isValidGitHttpUrl(repo) && !authedSsh) {
      tea.notify.error(t('code.register.invalidUrl'));
      return;
    }
    if (formAuthMethod === 'token' && !formToken.trim()) {
      tea.notify.error(t('code.register.tokenRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const auth =
        formAuthMethod === 'none'
          ? undefined
          : {
              auth_method: formAuthMethod,
              ...(formAuthMethod === 'token'
                ? {
                    access_token: formToken.trim(),
                    token_username: formTokenUsername.trim() || undefined,
                  }
                : { ssh_private_key: formSshKey.trim() }),
            };
      const detail = await knowledgeApi.code.create(activeTeamId, repo, formBranch.trim(), repo, auth);
      setShowRegister(false);
      setFormRepo('');
      setFormBranch('main');
      setFormAuthMethod('none');
      setFormToken('');
      setFormTokenUsername('');
      setFormSshKey('');
      setScopeTab('team');
      setInFlight((prev) => [
        ...prev.filter((x) => x.code_graph_id !== detail.code_graph_id),
        detail,
      ]);
      tea.notify.info(t('code.notify.registered'));
      fetchSources();
    } catch (e: any) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSync = async (cgId: string) => {
    try {
      await knowledgeApi.code.sync(cgId);
      fetchSources();
    } catch (e: any) {
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
    } catch (e: any) {
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
    const selRepo = selected ? formatRepoName(selected.repo_name, selected.repo_url) : '';
    const selBranch = selected?.branch ?? '';
    return (
      <div className="_codedetail-root">
        {/* 返回面包屑 */}
        <div className="_codedetail-breadcrumb">
          <Button type="link" onClick={() => setSubView('list')}>
            <span className="_codedetail-inline-icon">
              <ArrowLeftIcon size={14} /> {t('code.detail.breadcrumb')}
            </span>
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
                <span className="_codedetail-title" title={selRepo}>
                  {selRepo}
                </span>
                <Text theme="label">{t('code.detail.branch', { branch: selBranch })}</Text>
                {selected?.commit_hash && (
                  <Text theme="label" className="_codedetail-mono">
                    @ {selected.commit_hash}
                  </Text>
                )}
                {selected && statusLabel(t, selected.status)}
                {selected?.last_sync_at && (
                  <Text theme="label">{new Date(selected.last_sync_at).toLocaleString()}</Text>
                )}
              </div>
              <div className="_codedetail-header-actions">
                <Button type="primary" onClick={() => handleSync(selectedCgId)}>
                  <span className="_codedetail-inline-icon">
                    <RefreshIcon size={14} />
                    {t('code.action.sync')}
                  </span>
                </Button>
              </div>
            </div>
          </Card.Body>
        </Card>

        {selected?.sync_error && (
          <Alert type="error" className="_codedetail-error">
            {selected.sync_error}
          </Alert>
        )}

        {/* 统计 */}
        {selected?.stats && (
          <div className="_codedetail-stats">
            <MetricsBoard
              title={t('code.detail.files')}
              value={selected.stats.files?.toLocaleString() ?? '-'}
            />
            <MetricsBoard
              title={t('code.detail.nodes')}
              value={selected.stats.nodes?.toLocaleString() ?? '-'}
            />
            <MetricsBoard
              title={t('code.detail.edges')}
              value={selected.stats.edges?.toLocaleString() ?? '-'}
            />
          </div>
        )}

        {/* 仓库信息 */}
        {selected && (
          <Card>
            <Card.Body title={t('code.detail.repoInfo')}>
              <div className="_codedetail-info-grid">
                <Text theme="label">Code Graph ID</Text>
                <Text className="_codedetail-mono">{selected.code_graph_id}</Text>
                <Text theme="label">Git URL</Text>
                <Text className="_codedetail-mono">{selected.repo_url || '—'}</Text>
                <Text theme="label">{t('code.detail.lastSync')}</Text>
                <Text>
                  {selected.last_sync_at ? new Date(selected.last_sync_at).toLocaleString() : '—'}
                </Text>
              </div>
            </Card.Body>
          </Card>
        )}

        {/* 代码搜索 */}
        <Card>
          <Card.Body title={t('code.detail.search')}>
            <Text theme="label" parent="div" className="_codedetail-hint">
              {t('code.detail.search.hint')}
            </Text>
            <div className="_codedetail-search-row">
              <SearchBox
                size="full"
                value={searchQuery}
                onChange={(v) => setSearchQuery(v)}
                onSearch={() => void handleSearch()}
                placeholder={t('code.detail.search.placeholder')}
              />
            </div>
            {searching && <StatusTip status="loading" />}
            {!searching && searchResult && (
              <div className="_codedetail-result-box">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {searchResult}
                </ReactMarkdown>
              </div>
            )}
          </Card.Body>
        </Card>

        {/* 代码探索 */}
        <Card>
          <Card.Body title={t('code.detail.explore')}>
            <Text theme="label" parent="div" className="_codedetail-hint">
              {t('code.detail.explore.hint')}
            </Text>
            <div className="_codedetail-search-row">
              <SearchBox
                size="full"
                value={exploreQuery}
                onChange={(v) => setExploreQuery(v)}
                onSearch={() => void handleExplore()}
                placeholder={t('code.detail.explore.placeholder')}
              />
            </div>
            {exploring && <StatusTip status="loading" />}
            {!exploring && exploreResult && (
              <div className="_codedetail-result-box">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {exploreResult}
                </ReactMarkdown>
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
        title={t('code.title')}
        scope={
          <Segment
            value={scopeTab}
            onChange={(value) => setScopeTab(value as ScopeTab)}
            options={(['team', 'fixed'] as ScopeTab[]).map((tab) => ({
              value: tab,
              text: t(`code.scope.${tab}`),
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
              placeholder={t('code.noAgent')}
              options={teamAgents.map((agent) => ({
                value: agent.id,
                text: `${agent.name}（${agent.id}）`,
              }))}
            />
          ) : undefined
        }
        subtitle={
          activeTeam
            ? t('code.subtitle.team', { name: activeTeam.name, count: stats.total })
            : t('code.subtitle.global', { count: stats.total })
        }
        actions={
          scopeTab !== 'fixed' ? (
            <Button
              onClick={() => setAllocateTarget(selectedCodeAsset)}
              disabled={!selectedCodeAsset}
              tooltip={!selectedCodeAsset ? t('code.allocate.disabled') : undefined}
            >
              {t('code.allocateToAgent')}
            </Button>
          ) : undefined
        }
      />

      <Card className="_asset-code-content-card">
        <Card.Body>
          <div className="_asset-code-stats">
            <MetricsBoard title={t('code.metrics.total')} value={stats.total} />
            <MetricsBoard title={t('code.metrics.ready')} value={stats.ready} />
            <MetricsBoard title={t('code.metrics.processing')} value={stats.processing} />
            <MetricsBoard title={t('code.metrics.totalFiles')} value={stats.totalFiles} />
          </div>
          <Table.ActionPanel>
            <Justify
              left={
                <Button type="primary" onClick={() => setShowRegister(true)}>
                  + {t('code.register')}
                </Button>
              }
              right={
                <div className="_asset-code-toolbar">
                  <SearchBox
                    value={keyword}
                    onChange={setKeyword}
                    placeholder={t('code.searchPlaceholder')}
                  />
                  <Segment
                    value={statusFilter}
                    onChange={(value) => setStatusFilter(value as StatusFilter)}
                    options={[
                      { value: 'all', text: t('code.filter.allStatus') },
                      { value: 'ready', text: t('code.status.ready') },
                      { value: 'processing', text: t('code.status.processing') },
                      { value: 'error', text: t('code.filter.error') },
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
          ) : displaySources.length === 0 ? (
            <StatusTip
              status="empty"
              emptyText={
                <div className="_asset-code-empty">
                  <CodeIcon size="large" />
                  <Text>{t('code.empty.title')}</Text>
                  <Text theme="label">{t('code.empty.desc')}</Text>
                </div>
              }
            />
          ) : filteredSources.length === 0 ? (
            <StatusTip status="empty" emptyText={t('code.empty.filtered')} />
          ) : viewMode === 'card' ? (
            <div className="_codelist-grid">
              {filteredSources.map((source) => {
                const isSelected = selectedCodeAsset?.cgId === source.code_graph_id;
                const repoLabel = formatRepoName(source.repo_name, source.repo_url);
                return (
                  <div
                    key={source.code_graph_id}
                    className={`_codelist-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() =>
                      setSelectedCodeAsset({
                        cgId: source.code_graph_id,
                        repo: repoLabel,
                        branch: source.branch,
                      })
                    }
                  >
                    <button
                      type="button"
                      className="_codelist-card-head _codelist-card-name-trigger"
                      onClick={(event) => {
                        event.stopPropagation();
                        openDetail(source.code_graph_id);
                      }}
                      title={t('code.detail.viewDetail', { name: repoLabel })}
                    >
                      <CodeIcon size={16} />
                      <span className="_codelist-card-name">{repoLabel}</span>
                      <ChevronRightIcon size={14} className="_codelist-card-chevron" />
                    </button>
                    <div className="_codelist-card-meta">
                      {statusLabel(t, source.status)}
                      <span>{t('code.detail.branch', { branch: source.branch })}</span>
                      {source.commit_hash && (
                        <span className="_codedetail-mono">@ {source.commit_hash}</span>
                      )}
                      {source.stats && (
                        <span>
                          {t('code.stats', {
                            nodes: source.stats.nodes.toLocaleString(),
                            files: source.stats.files.toLocaleString(),
                          })}
                        </span>
                      )}
                      <span>{formatShortTime(source.last_sync_at)}</span>
                    </div>
                    <div className="_codelist-card-owner">
                      <UsergroupIcon size={12} />
                      {scopeTab === 'fixed' ? (
                        t('code.fixedAsset', { agent: agentFilter || t('code.noAgent') })
                      ) : source.owner_user_id ? (
                        <CodeOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                      ) : (
                        t('code.scope.team')
                      )}
                    </div>
                    <div className="_codelist-card-id">
                      {t('code.card.id', { id: source.code_graph_id })}
                    </div>
                    <div
                      className="_codelist-card-actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {scopeTab === 'fixed' ? (
                        <Button type="weak" onClick={() => handleUnbindCode(source.code_graph_id)}>
                          <span className="_codelist-inline-icon">
                            <UsergroupIcon size={14} />
                            {t('code.action.unbind')}
                          </span>
                        </Button>
                      ) : (
                        <Button
                          type="weak"
                          onClick={() =>
                            setAllocateTarget({
                              cgId: source.code_graph_id,
                              repo: repoLabel,
                              branch: source.branch,
                            })
                          }
                        >
                          {t('code.action.allocate')}
                        </Button>
                      )}
                      <Button
                        type="icon"
                        tooltip={t('code.action.sync')}
                        onClick={() => handleSync(source.code_graph_id)}
                      >
                        <RefreshIcon size={14} />
                      </Button>
                      <Button
                        type="icon"
                        tooltip={t('code.action.delete')}
                        onClick={() => handleDelete(source.code_graph_id)}
                      >
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
                  header: t('code.table.repo'),
                  width: 250,
                  render: (source) => (
                    <button
                      type="button"
                      className="_codelist-row-name"
                      onClick={() => openDetail(source.code_graph_id)}
                      title={t('code.detail.viewDetail', {
                        name: formatRepoName(source.repo_name, source.repo_url),
                      })}
                    >
                      <CodeIcon size={14} />
                      <span>{formatRepoName(source.repo_name, source.repo_url)}</span>
                      <ChevronRightIcon size={12} />
                    </button>
                  ),
                },
                {
                  key: 'status',
                  header: t('code.table.status'),
                  width: 120,
                  render: (source) => statusLabel(t, source.status),
                },
                {
                  key: 'branch',
                  header: t('code.table.branch'),
                  width: 190,
                  render: (source) => (
                    <span className="_codelist-branch">
                      <span>{source.branch}</span>
                      {source.commit_hash && (
                        <span className="_codedetail-mono">@ {source.commit_hash}</span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'stats',
                  header: t('code.table.stats'),
                  width: 150,
                  render: (source) =>
                    source.stats
                      ? t('code.stats', {
                          nodes: source.stats.nodes.toLocaleString(),
                          files: source.stats.files.toLocaleString(),
                        })
                      : '—',
                },
                {
                  key: 'owner',
                  header: t('code.table.owner'),
                  width: 180,
                  render: (source) =>
                    scopeTab === 'fixed' ? (
                      <span className="_codelist-inline-icon">
                        <UsergroupIcon size={12} />
                        {agentFilter || t('code.noAgent')}
                      </span>
                    ) : source.owner_user_id ? (
                      <CodeOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                    ) : (
                      <Text theme="label">{t('code.teamPool')}</Text>
                    ),
                },
                {
                  key: 'last_sync_at',
                  header: t('code.table.lastSync'),
                  width: 140,
                  render: (source) => (
                    <Text theme="label">{formatShortTime(source.last_sync_at)}</Text>
                  ),
                },
                {
                  key: 'code_graph_id',
                  header: 'Code Graph ID',
                  width: 200,
                  render: (source) => <span className="_codelist-id">{source.code_graph_id}</span>,
                },
                {
                  key: 'actions',
                  header: t('code.table.actions'),
                  width: 280,
                  fixed: 'right',
                  render: (source) => {
                    const repoLabel = formatRepoName(source.repo_name, source.repo_url);
                    return (
                      <div className="_codelist-table-actions">
                        {scopeTab === 'fixed' ? (
                          <Button
                            type="link"
                            onClick={() => handleUnbindCode(source.code_graph_id)}
                          >
                            {t('code.action.unbind')}
                          </Button>
                        ) : (
                          <Button
                            type="link"
                            onClick={() =>
                              setAllocateTarget({
                                cgId: source.code_graph_id,
                                repo: repoLabel,
                                branch: source.branch,
                              })
                            }
                          >
                            {t('code.action.allocate')}
                          </Button>
                        )}
                        <Button type="link" onClick={() => handleSync(source.code_graph_id)}>
                          {t('code.action.sync')}
                        </Button>
                        <Button
                          type="link"
                          onClick={() => handleDelete(source.code_graph_id)}
                          className="_codelist-delete-action"
                        >
                          {t('code.action.delete')}
                        </Button>
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
      {showRegister &&
        (() => {
          const trimmedRepo = formRepo.trim();
          const isSsh = trimmedRepo.startsWith('git@');
          const validUrl = isValidGitHttpUrl(trimmedRepo);
          // 已输入内容、非 SSH、但又不是合法 http(s) 地址 → 提示格式错误。
          const showUrlError = !!trimmedRepo && !isSsh && !validUrl;
          // SSH 提交条件：git@ URL + 认证方式 ssh + 已粘贴私钥；token 提交条件：已填 token
          const authedSsh = isSsh && formAuthMethod === 'ssh' && !!formSshKey.trim();
          const canSubmit =
            !!formBranch.trim() &&
            (validUrl || authedSsh) &&
            (formAuthMethod !== 'token' || !!formToken.trim());
          return (
            <Modal
              visible
              caption={t('code.register.caption')}
              size="m"
              onClose={() => setShowRegister(false)}
              disableEscape={submitting}
            >
              <Modal.Body>
                <Form>
                  <Form.Item label="Git URL" required extra={t('code.register.gitUrlExtra')}>
                    <Input
                      size="full"
                      value={formRepo}
                      onChange={setFormRepo}
                      placeholder="https://gitlab.example.com/namespace/repo.git"
                    />
                  </Form.Item>
                  <Form.Item label={t('code.register.authMethod')}>
                    <Segment
                      value={formAuthMethod}
                      onChange={(v) => setFormAuthMethod(v as 'none' | 'token' | 'ssh')}
                      options={[
                        { value: 'none', text: t('code.register.authNone') },
                        { value: 'token', text: t('code.register.authToken') },
                        { value: 'ssh', text: t('code.register.authSsh') },
                      ]}
                    />
                  </Form.Item>
                  {formAuthMethod === 'token' && (
                    <>
                      <Form.Item label={t('code.register.accessToken')} required extra={t('code.register.accessTokenExtra')}>
                        <Input
                          size="full"
                          type="password"
                          value={formToken}
                          onChange={setFormToken}
                          placeholder={t('code.register.accessTokenPlaceholder')}
                        />
                      </Form.Item>
                      <Form.Item label={t('code.register.tokenUsername')}>
                        <Input
                          size="full"
                          value={formTokenUsername}
                          onChange={setFormTokenUsername}
                          placeholder={t('code.register.tokenUsernamePlaceholder')}
                        />
                      </Form.Item>
                    </>
                  )}
                  {formAuthMethod === 'ssh' && (
                    <Form.Item label={t('code.register.sshKey')} required extra={t('code.register.sshKeyExtra')}>
                      <Input
                        multiline
                        size="full"
                        value={formSshKey}
                        onChange={setFormSshKey}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                      />
                    </Form.Item>
                  )}
                  {isSsh && formAuthMethod !== 'ssh' && (
                    <Form.Item>
                      <Alert type="warning">{t('code.register.sshWarning')}</Alert>
                    </Form.Item>
                  )}
                  {showUrlError && (
                    <Form.Item>
                      <Alert type="error">{t('code.register.invalidUrl')}</Alert>
                    </Form.Item>
                  )}
                  <Form.Item label={t('code.register.branch')} required>
                    <Input
                      size="full"
                      value={formBranch}
                      onChange={setFormBranch}
                      placeholder="main"
                    />
                  </Form.Item>
                </Form>
              </Modal.Body>
              <Modal.Footer>
                <Button
                  type="primary"
                  onClick={handleRegister}
                  disabled={submitting || !canSubmit}
                  loading={submitting}
                >
                  {submitting ? t('code.register.submitting') : t('code.register.submit')}
                </Button>
                <Button onClick={() => setShowRegister(false)} disabled={submitting}>
                  {t('common.cancel')}
                </Button>
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
            if (!activeTeamId) throw new Error(t('code.notify.selectTeam'));
            await knowledgeApi.code.allocate(activeTeamId, allocateTarget.cgId, agentId);
            tea.notify.success(t('code.notify.allocated'));
            await fetchSources();
            if (scopeTab === 'fixed') await fetchFixedBindings();
          }}
        />
      )}
    </div>
  );
}
