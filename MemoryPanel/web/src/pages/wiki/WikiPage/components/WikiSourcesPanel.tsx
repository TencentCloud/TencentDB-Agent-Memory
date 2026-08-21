/**
 * WikiSourcesPanel —— Wiki 资产页主面板（列表视图 + 详情/创建/分配组装）。
 * 列表视图渲染与组件组装；状态/数据逻辑在 useWikiSources，详情在 WikiDetailView，
 * 展示小组件 / 常量工具 / 共享 Markdown 分别独立收口。
 */
import { useTranslation } from 'react-i18next';
import { Button, Card, Form, Input, Justify, MetricsBoard, Modal, SearchBox, Segment, Select, StatusTip, Table, Text } from 'tea-component';
import { BooksIcon, ChevronRightIcon, UsergroupIcon, ViewListIcon, ViewModuleIcon } from 'tea-icons-react';
import { knowledgeApi } from '@/lib/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import AllocateAssetDialog from '@/pages/ResourcePage/components/AllocateAssetDialog';
import { AssetPageHeader } from '@/pages/ResourcePage/components/AssetPageHeader';
import { formatShortTime, SCOPE_LABEL_KEYS, type StatusFilter, type ViewMode, type WikiScopeTab } from './wiki-constants';
import { WikiOwnerLabel, WikiStatusBadge } from './wiki-ui';
import { WikiActions } from './wiki-detail-components';
import { useWikiSources } from './useWikiSources';
import { WikiDetailView } from './wiki-detail-view';
import './wiki-sources-panel.css';

const { scrollable } = Table.addons;

export default function WikiSourcesPanel() {
  const { t } = useTranslation();
  const wiki = useWikiSources();

  const {
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
    // create
    showCreate,
    setShowCreate,
    newName,
    setNewName,
    submitting,
    // allocate
    allocateTarget,
    setAllocateTarget,
    agentFilter,
    setAgentFilter,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    handleIngest,
    handleDelete,
    openDetail,
    handleUnbindWiki,
    handleCreate,
    // computed
    stats,
    filteredSources,
    runningWikiIds,
    ingestBusy,
  } = wiki;

  if (subView === 'detail') {
    return <WikiDetailView store={wiki} />;
  }

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
        actions={
          // 创建（新增团队池资产）与 memory/skill 对齐，放右上角 header；
          // 仅「团队资产」tab 开放，固定资产 tab 只做绑定/查看。
          scopeTab !== 'fixed' ? (
            <Button type="primary" onClick={() => setShowCreate(true)} data-guide="create-wiki">
              {t('wiki.create')}
            </Button>
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
            <div className="_asset-wiki-skeleton-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="_asset-wiki-skeleton-card">
                  <div className="_asset-wiki-skeleton-line _asset-wiki-skeleton-line--title" />
                  <div className="_asset-wiki-skeleton-line _asset-wiki-skeleton-line--desc" />
                  <div className="_asset-wiki-skeleton-line _asset-wiki-skeleton-line--meta" />
                </div>
              ))}
            </div>
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
            <div className="_asset-wiki-grid _view-swap">
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
            <div className="_view-swap">
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
                  header: t('wiki.table.wikiId'),
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
            </div>
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
