/**
 * WikiDetailView —— Wiki 详情视图（概览 / 图谱 / 页面 / 搜索 四个 Tab + 添加文档 Modal）。
 * 全部数据与回调来自 useWikiSources 的返回对象，组件只做渲染。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Input, MetricsBoard, Modal, Progress, SearchBox, Select, StatusTip, TabPanel, Tabs, Tag, Text } from 'tea-component';
import {
  ArrowLeftIcon,
  AttachIcon,
  BooksIcon,
  ChartBarIcon,
  CheckCircleIcon,
  CheckIcon,
  CloseCircleIcon,
  CloseIcon,
  FileIcon,
  LayersIcon as ArchitectureIcon,
  LoadingIcon,
  SearchIcon,
} from 'tea-icons-react';
import { knowledgeApi, type SourceProviderMeta, type SourceProviderFormField } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { WIKI_ALLOWED_FILE_RE, TYPE_COLORS, TYPE_COLOR_FALLBACK, type DetailTab } from '../constants/wiki-constants';
import { WikiStatusBadge } from './wiki-ui';
import { GraphTabContent, PagesTabContent } from './wiki-detail-components';
import { WikiSourcePageTree } from './wiki-source-page-tree';
import { ImportAndIngestModal } from './import-and-ingest-modal';
import type { WikiSourcesStore } from '../hooks/useWikiSources';

export function WikiDetailView({ store }: { store: WikiSourcesStore }) {
  const { t } = useTranslation();
  // 设计 2026-09-21：合并后的单一导入入口（原「添加」+「Ingest」）
  const [showImportModal, setShowImportModal] = useState(false);
  const {
    sources,
    selectedWikiId,
    setSubView,
    fetchSources,
    displayIngestState,
    ingestCardCleared,
    setIngestCardCleared,
    activeTab,
    setActiveTab,
    pages,
    types,
    typeCounts,
    edgeCount,
    handleReadPage,
    filteredPages,
    pageTypeFilter,
    setPageTypeFilter,
    selectedPage,
    readLoading,
    displayContent,
    metadata,
    rawRefreshKey,
    handleDeletePage,
    handleDeleteRaw,
    setSelectedPage,
    setReadContent,
    setReadLoading,
    searchQuery,
    setSearchQuery,
    handleSearch,
    searching,
    searchResults,
    pendingFiles,
    setPendingFiles,
    uploadProgress,
    submitting,
    mdDocs,
    setMdDocs,
    handleUploadMdBatch,
    handleBatchUpload,
    fileInputRef,
    openAddDocExternal,
    // 外部来源（iWiki 等）导入
    sourceProviders,
    formSourceType,
    setFormSourceType,
    formCredential,
    setCredentialField,
    formSourceUrl,
    setFormSourceUrl,
    treeResult,
    selectedPageIds,
    setSelectedPageIds,
    fetchingTree,
    importing,
    credConfigured,
    savingCred,
    crawlMode,
    setCrawlMode,
    fetchWikiTree,
    importWikiPages,
    loadWikiProviders,
    ensureCredential,
  } = store;

  const source = sources.find((s) => s.wiki_id === selectedWikiId);
  const wikiName = source?.name ?? '';
  // 进度卡片只在「加工中」显示；完成后（ready）自动收起，与合并改动前的行为一致
  // （终态由标题栏的状态徽章 + 页数体现，不需要再挂一个进度卡片）。
  // failed 例外：出错原因必须显式告知用户，因此保留卡片直到用户点「清除」。
  const showIngestCard =
    !ingestCardCleared &&
    displayIngestState.wiki === wikiName &&
    (displayIngestState.active || displayIngestState.status === 'failed');
  const isIngestingNow = displayIngestState.active;

  // 选中 Wiki 已不存在（被删除或刷新失败）时给出可返回的空态，避免死胡同
  if (!source) {
    return (
      <Card>
        <Card.Body>
          <Button type="text" onClick={() => { fetchSources(); setSubView('list'); }}>
            <ArrowLeftIcon size={12} /> {t('wiki.breadcrumb')}
          </Button>
          <StatusTip status="empty" emptyText={t('wiki.detail.notFound')} />
        </Card.Body>
      </Card>
    );
  }

  return (
    <div className="_wiki-detail-root">
      <Card>
        <Card.Body className="_wiki-detail-header-body">
          <div className="_wiki-detail-breadcrumb">
            <Button type="link" onClick={() => { fetchSources(); setSubView('list'); }}>
              <ArrowLeftIcon size={12} /> {t('wiki.breadcrumb')}
            </Button>
            <span className="_wiki-detail-breadcrumb-sep">/</span>
            <span className="_wiki-detail-breadcrumb-current">{wikiName}</span>
          </div>
          <div className="_wiki-detail-header-row">
            <div className="_wiki-detail-header-info">
              <BooksIcon size={20} />
              <span className="_wiki-detail-title">{wikiName}</span>
              {/* 状态徽章与进度卡片同源：都用 displayIngestState（已屏蔽"上一个
                  任务留下的终态"），保证徽章与卡片永远一致，不会一个显示就绪、
                  另一个显示加工中。 */}
              {displayIngestState.status && (
                <WikiStatusBadge status={displayIngestState.status} />
              )}
            </div>
            <div className="_wiki-detail-header-actions">
              {/* 设计 2026-09-21：「添加」+「Ingest」合并为单一入口。 */}
              <Button
                type="primary"
                onClick={() => {
                  // 打开即初始化 external 流程：回填来源地址、查凭据、已配置则直接拉树
                  if (source?.source_type && !showImportModal) {
                    void openAddDocExternal(source);
                  }
                  setShowImportModal(true);
                }}
                // 设计 2026-09-21 §3.3：合并入口允许"抽取中再次导入"——由 KS 的
                // onBusy:'replace' 原子完成"取消旧任务 + 排队新任务"，UI 不禁用按钮。
                // 之前基于 isCurrentWikiIngesting 的 disabled 与 replace 语义矛盾，
                // 会阻断用户「换个文件再来一次」的合法流程。
              >
                <AttachIcon size={14} /> {t('wiki.detail.import')}
              </Button>
            </div>
          </div>
          <div className="_detail-meta-row">
            {/* 抽取进行中时不显示页数：replace 语义下旧页数尚未被新任务重建，
                展示"0 页"或旧计数都会误导用户；等 ready 后由 fetchDetail 刷新。 */}
            {!isIngestingNow && (
              <span>{t('wiki.detail.pages', { count: pages.length })}</span>
            )}
          </div>
        </Card.Body>
      </Card>

      {showIngestCard && (
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
                      onClick={() => setIngestCardCleared(true)}
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
                    {displayIngestState.active && (
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
            <div className="_wiki-detail-overview-stats">
              <MetricsBoard title={t('wiki.detail.overview.totalPages')} value={pages.length} />
              <MetricsBoard title={t('wiki.detail.overview.pageTypes')} value={types.length} />
              <MetricsBoard title={t('wiki.detail.overview.edges')} value={edgeCount} />
            </div>
            <Card bordered>
              <Card.Body title={t('wiki.detail.overview.typeDist')}>
                {types.length === 0 ? (
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
                {pages.length === 0 ? (
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
            graphData={store.graphData}
            graphLoading={store.graphLoading}
            selectedPage={selectedPage}
            readLoading={readLoading}
            displayContent={displayContent}
            metadata={metadata}
            onNodeClick={(node) => {
              const page =
                pages.find((item) => ((item as any).id || item.path) === node.id) ||
                ({ path: node.id, title: node.label, type: node.type } as any);
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
            onReadPage={handleReadPage}
            onDeletePage={handleDeletePage}
            onDeleteRaw={handleDeleteRaw}
            onReadRaw={(filename) => {
              const rawPage = {
                path: `raw/${filename}`,
                title: filename,
                type: 'raw',
              } as any;
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
                          } as any);
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
          </div>
        </TabPanel>
      </Tabs>

      {/* Add Doc Modal */}
      {store.showAddDoc && (() => {
        // iWiki 等外部来源的 wiki：只显示"从外部拉取"，不显示"上传文件 / Markdown"两 tab。
        // 否则（手工上传的 wiki）维持原两 tab；来源来自 wiki_detail.source_type（null=手工）。
        const isExternal = !!source?.source_type;
        // 打开时若为外部来源，强制切到 external tab，并预拉来源列表。
        const modalTabId: 'file' | 'markdown' | 'external' = isExternal
          ? 'external'
          : (store.addDocTab === 'external' ? 'file' : store.addDocTab);
        return (
        <Modal
          visible
          caption={t('wiki.detail.addDoc.caption', { name: wikiName })}
          size="m"
          onClose={() => store.setShowAddDoc(false)}
          disableEscape={submitting}
        >
          <Modal.Body>
            <Alert type="info">{t('wiki.detail.addDoc.hint')}</Alert>
            <Tabs
              tabs={isExternal
                ? [{ id: 'external', label: t('wiki.detail.addDoc.external') }]
                : [
                    { id: 'file', label: t('wiki.detail.addDoc.file') },
                    { id: 'markdown', label: t('wiki.detail.addDoc.markdown') },
                  ]}
              activeId={modalTabId}
              onActive={(tab) => {
                const id = tab.id as 'file' | 'markdown' | 'external';
                store.setAddDocTab(id);
                // 首次切到「外部来源」时预拉来源列表
                if (id === 'external' && sourceProviders.length === 0) void loadWikiProviders();
              }}
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
              <TabPanel id="external">
                <div className="_wiki-detail-external-panel" style={{ paddingTop: 8 }}>
                  {/* 来源选择 */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 4 }}>{t('wiki.register.source')}</div>
                    <Select
                      size="full"
                      value={formSourceType}
                      onChange={(v) => {
                        setFormSourceType(v);
                        // 切换来源清空已填凭据与已拉取的树
                        setSelectedPageIds([]);
                      }}
                      options={[
                        { value: '', text: '—' },
                        ...sourceProviders.map((p: SourceProviderMeta) => {
                          const key = `wiki.source.${p.id}`;
                          const localized = t(key);
                          return { value: p.id, text: localized === key ? p.id : localized };
                        }),
                      ]}
                    />
                  </div>

                  {/* 凭据字段（按 form_fields 动态渲染）—— 已存凭据时不再要求重填 */}
                  {formSourceType && !credConfigured && (
                    <>
                      <Alert type="info">{t('wiki.register.credHint')}</Alert>
                      {(sourceProviders.find((p) => p.id === formSourceType)?.form_fields ?? []).map(
                        (field: SourceProviderFormField, idx: number, arr: readonly SourceProviderFormField[]) => {
                          const provider = sourceProviders.find((p) => p.id === formSourceType)!;
                          const isLast = idx === arr.length - 1;
                          const labelKey = `code.credField.${field.name}.label`;
                          const label = t(labelKey);
                          const phKey = `code.credField.${field.name}.placeholder`;
                          const ph = t(phKey);
                          return (
                            <div key={field.name} style={{ marginBottom: 12 }}>
                              <div style={{ marginBottom: 4 }}>
                                {label === labelKey ? field.name : label}
                                {field.required && <span style={{ color: '#d0021b' }}> *</span>}
                              </div>
                              <Input
                                size="full"
                                type={field.secret ? 'password' : 'text'}
                                value={formCredential[field.name] ?? ''}
                                onChange={(v) => setCredentialField(field.name, v)}
                                placeholder={ph === phKey ? '' : ph}
                              />
                              {isLast && provider.token_doc_url && (
                                <a
                                  href={provider.token_doc_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="_wikilist-token-doc"
                                >
                                  {t('code.register.tokenDoc')}
                                </a>
                              )}
                            </div>
                          );
                        },
                      )}
                    </>
                  )}

                  {/* 来源地址 */}
                  {formSourceType && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ marginBottom: 4 }}>{t('wiki.register.sourceUrl')}</div>
                      <Input
                        size="full"
                        value={formSourceUrl}
                        onChange={setFormSourceUrl}
                        placeholder={t('wiki.register.sourceUrlPlaceholder')}
                      />
                      <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                        {t('wiki.register.sourceUrlExtra')}
                      </div>
                    </div>
                  )}

                  {/* 遍历策略：决定从来源地址出发如何发现文档 */}
                  {formSourceType && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ marginBottom: 4 }}>{t('wiki.register.crawlMode')}</div>
                      <Select
                        size="full"
                        value={crawlMode ?? 'tree'}
                        options={[
                          { value: 'tree', text: t('wiki.register.crawlMode.tree') },
                          { value: 'links', text: t('wiki.register.crawlMode.links') },
                        ]}
                        onChange={(v) => setCrawlMode((v || 'tree') as typeof crawlMode)}
                      />
                      <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
                        {crawlMode === 'links'
                          ? t('wiki.register.crawlHint.links')
                          : t('wiki.register.crawlHint.tree')}
                      </div>
                    </div>
                  )}

                  {/* 拉取按钮：未存凭据 → 先存再拉（存凭据是拉树的前提） */}
                  {formSourceType && (
                    <Button
                      type="primary"
                      onClick={() => {
                        const wikiId = selectedWikiId ?? undefined;
                        if (credConfigured) void fetchWikiTree(wikiId);
                        else void ensureCredential(wikiId ?? '');
                      }}
                      disabled={
                        fetchingTree || savingCred || !formSourceUrl.trim() || !selectedWikiId
                      }
                      loading={fetchingTree || savingCred}
                      style={{ marginBottom: 12 }}
                    >
                      {fetchingTree || savingCred
                        ? t('wiki.register.fetching')
                        : credConfigured
                          ? t('wiki.register.fetch')
                          : t('wiki.register.saveAndFetch')}
                    </Button>
                  )}

                  {/* 文档树勾选（按 parentId 还原层级，目录可折叠/快捷全选） */}
                  {treeResult && (
                    <div>
                      <WikiSourcePageTree
                        pages={treeResult.pages}
                        selectedPageIds={selectedPageIds}
                        onToggleLeaf={(id, checked) =>
                          setSelectedPageIds((prev) =>
                            checked ? [...prev, id] : prev.filter((x) => x !== id),
                          )
                        }
                        onToggleDir={(ids, checked) =>
                          setSelectedPageIds((prev) =>
                            checked
                              ? [...new Set([...prev, ...ids])]
                              : prev.filter((x) => !ids.includes(x)),
                          )
                        }
                      />
                      <Button
                        type="primary"
                        style={{ marginTop: 12 }}
                        onClick={() => void importWikiPages(selectedWikiId ?? undefined)}
                        disabled={importing || selectedPageIds.length === 0}
                        loading={importing}
                      >
                        {importing ? t('wiki.register.importing') : t('wiki.register.import')}
                      </Button>
                    </div>
                  )}
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
        );
      })()}

      {/* 设计 2026-09-21：合并后的单一导入入口（替代原「添加」+「Ingest」两按钮） */}
      <ImportAndIngestModal
        visible={showImportModal}
        sourceType={source?.source_type}
        // Modal 的 submitting 仅用于展示按钮 loading 与阻止重复点击；由于我们
        // 在 onSubmit 里 fire-and-forget 立即关闭 Modal（进度接管在页面顶部），
        // Modal 存在期间没有"提交尚未返回"的窗口，恒为 false 即可。
        submitting={false}
        external={{
          sourceProviders,
          formSourceType,
          setFormSourceType: (v) => {
            setFormSourceType(v);
            setSelectedPageIds([]);
          },
          formCredential,
          setCredentialField,
          credConfigured,
          savingCred,
          fetchingTree,
          formSourceUrl,
          setFormSourceUrl,
          crawlMode: crawlMode ?? 'tree',
          setCrawlMode,
          treeResult,
          selectedPageIds,
          setSelectedPageIds,
          onFetchTree: () => {
            const wikiId = selectedWikiId ?? undefined;
            if (credConfigured) void fetchWikiTree(wikiId);
            else void ensureCredential(wikiId ?? '');
          },
        }}
        onClose={() => setShowImportModal(false)}
        onSubmit={(payload) => {
          // 设计 2026-09-21 §2.2：提交后立即关闭 Modal，进度由页面顶部进度条接管。
          // submitAddAndIngest 内部已完成错误 toast / 进度回调 / 刷新，无需在此 await
          // 整个抽取流程（否则 Modal 会一直转到 ingest 结束）。
          void store.submitAddAndIngest({ wikiId: selectedWikiId, ...payload });
          setShowImportModal(false);
        }}
      />
    </div>
  );
}
