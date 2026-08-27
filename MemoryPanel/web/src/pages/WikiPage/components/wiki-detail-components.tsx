/**
 * wiki-detail-components —— Wiki 详情页的展示子组件。
 * 从 WikiSourcesPanel.tsx 尾部拆出（WikiActions / ResizeHandle /
 * GraphTabContent / PagesTabContent / RawFilesSection）。
 * 均为纯展示组件，数据与回调由外层注入，不含业务状态。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, StatusTip, Tag, Text } from 'tea-component';
import {
  BooksIcon,
  ChevronRightIcon,
  CloseIcon,
  DeleteIcon,
  FileIcon,
  FolderIcon,
  LayersIcon as ArchitectureIcon,
  StarIcon,
} from 'tea-icons-react';
import { knowledgeApi, type GraphData, type GraphNode, type WikiDetail, type WikiPage } from '@/lib/api/knowledge-api';
import { useResizable } from '@/lib/useResizable';
import { tea } from '@/lib/tea-bridge';
import { AssetMarkdown } from '@/components/asset/AssetMarkdown';
import { TYPE_COLORS, TYPE_COLOR_FALLBACK, type WikiScopeTab } from '../constants/wiki-constants';
import { KnowledgeGraphEmbed } from './wiki-ui';

export function WikiActions({
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
export function GraphTabContent({
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
                <AssetMarkdown content={displayContent} />
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
export function PagesTabContent({
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
          {pages.map((page) => {
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
          })}
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
                  <AssetMarkdown content={displayContent} />
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
export function RawFilesSection({
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
