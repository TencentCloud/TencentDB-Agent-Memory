/**
 * WikiDetailView —— Wiki 详情视图（概览 / 图谱 / 页面 / 搜索 四个 Tab + 添加文档 Modal）。
 * 全部数据与回调来自 useWikiSources 的返回对象，组件只做渲染。
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Input, MetricsBoard, Modal, Progress, SearchBox, StatusTip, TabPanel, Tabs, Tag, Text } from 'tea-component';
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
  StarIcon,
} from 'tea-icons-react';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { WIKI_ALLOWED_FILE_RE, TYPE_COLORS, TYPE_COLOR_FALLBACK, type DetailTab } from '../constants/wiki-constants';
import { WikiStatusBadge } from './wiki-ui';
import { GraphTabContent, PagesTabContent } from './wiki-detail-components';
import type { WikiSourcesStore } from '../hooks/useWikiSources';

export function WikiDetailView({ store }: { store: WikiSourcesStore }) {
  const { t } = useTranslation();
  const {
    sources,
    selectedWikiId,
    setSubView,
    fetchSources,
    setShowAddDoc,
    setAddDocTab,
    handleIngest,
    ingestBusy,
    displayIngestState,
    setIngestState,
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
  } = store;

  const source = sources.find((s) => s.wiki_id === selectedWikiId);
  const wikiName = source?.name ?? '';

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
              {source && <WikiStatusBadge status={source.status} />}
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
                    <StarIcon size={14} /> {t('wiki.action.ingest')}
                  </>
                )}
              </Button>
            </div>
          </div>
          <div className="_detail-meta-row">
            <span>{t('wiki.detail.pages', { count: pages.length })}</span>
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
      {store.showAddDoc && (
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
              tabs={[
                { id: 'file', label: t('wiki.detail.addDoc.file') },
                { id: 'markdown', label: t('wiki.detail.addDoc.markdown') },
              ]}
              activeId={store.addDocTab}
              onActive={(tab) => store.setAddDocTab(tab.id as 'file' | 'markdown')}
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
