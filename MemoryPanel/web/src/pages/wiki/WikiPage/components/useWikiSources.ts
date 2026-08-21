/**
 * useWikiSources —— Wiki 资产页的全部状态与数据逻辑。
 * 组件层只保留 JSX 渲染，状态 / 数据逻辑集中在此。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knowledgeApi, wikiProgressPercent, wikiStageLabel, type GraphData, type WikiDetail, type WikiPage } from '@/lib/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea } from '@/lib/tea-bridge';
import { findExistingRawFilenames, formatOverwriteFilenames } from './wiki-upload-utils';
import { type DetailTab, type SearchResult, type StatusFilter, type SubView, type ViewMode, type WikiScopeTab } from './wiki-constants';

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
    ingestState,
    setIngestState,
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
    handleIngest,
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
    hasManualIngestState,
    displayIngestState,
    ingestBusy,
    displayContent,
    metadata,
  };
}

export type WikiSourcesStore = ReturnType<typeof useWikiSources>;
