/**
 * CodeSourcesPanel —— Code 资产页主面板（列表视图 + 注册/分配组装）。
 * 列表视图渲染与组件组装；状态/数据逻辑在 useCodeSources，详情在 CodeDetailView，
 * Markdown 渲染统一走共享 AssetMarkdown。
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Form, Input, Justify, MetricsBoard, Modal, SearchBox, Segment, Select, StatusTip, Table, Text } from 'tea-component';
import { ChevronRightIcon, CodeIcon, DeleteIcon, RefreshIcon, UsergroupIcon, ViewListIcon, ViewModuleIcon } from 'tea-icons-react';
import { knowledgeApi } from '@/lib/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import AllocateAssetDialog from '@/pages/ResourcePage/components/AllocateAssetDialog';
import { AssetPageHeader } from '@/pages/ResourcePage/components/AssetPageHeader';
import { formatRepoName, formatShortTime, isValidGitHttpUrl, type ScopeTab, type StatusFilter, type ViewMode } from './code-constants';
import { CodeOwnerLabel, statusLabel } from './code-ui';
import { useCodeSources } from './useCodeSources';
import { CodeDetailView } from './code-detail-view';
import './code-sources-panel.css';

const { scrollable } = Table.addons;

export default function CodeSourcesPanel() {
  const { t } = useTranslation();
  const code = useCodeSources();

  const {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    displaySources,
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
    // register
    showRegister,
    setShowRegister,
    formRepo,
    setFormRepo,
    formBranch,
    setFormBranch,
    submitting,
    // allocate
    allocateTarget,
    setAllocateTarget,
    selectedCodeAsset,
    agentFilter,
    setAgentFilter,
    // handlers
    fetchSources,
    fetchFixedBindings,
    handleUnbindCode,
    handleRegister,
    handleSync,
    handleDelete,
    openDetail,
    // computed
    stats,
    filteredSources,
  } = code;

  if (subView === 'detail') {
    return <CodeDetailView store={code} />;
  }

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
            <>
              <Button
                onClick={() => setAllocateTarget(selectedCodeAsset)}
                disabled={!selectedCodeAsset}
                tooltip={!selectedCodeAsset ? t('code.allocate.disabled') : undefined}
              >
                {t('code.allocateToAgent')}
              </Button>
              {/* 注册（新增团队池资产）与 memory/skill 对齐，放右上角 header */}
              <Button type="primary" onClick={() => setShowRegister(true)} data-guide="create-code">
                + {t('code.register')}
              </Button>
            </>
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
            <div className="_codelist-skeleton-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="_codelist-skeleton-card">
                  <div className="_codelist-skeleton-line _codelist-skeleton-line--title" />
                  <div className="_codelist-skeleton-line _codelist-skeleton-line--desc" />
                  <div className="_codelist-skeleton-line _codelist-skeleton-line--meta" />
                </div>
              ))}
            </div>
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
            <div className="_codelist-grid _view-swap">
              {filteredSources.map((source) => {
                const isSelected = selectedCodeAsset?.cgId === source.code_graph_id;
                const repoLabel = formatRepoName(source.repo_name, source.repo_url);
                return (
                  <div
                    key={source.code_graph_id}
                    className={`_codelist-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() =>
                      code.setSelectedCodeAsset({
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
                            code.setAllocateTarget({
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
            <div className="_view-swap">
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
                  header: t('code.table.codeGraphId'),
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
                              code.setAllocateTarget({
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
            </div>
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
                  <Form.Item label={t('code.register.gitUrl')} required extra={t('code.register.gitUrlExtra')}>
                    <Input
                      size="full"
                      value={formRepo}
                      onChange={setFormRepo}
                      placeholder="https://gitlab.example.com/namespace/repo.git"
                    />
                  </Form.Item>
                  {isSsh && (
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
                  disabled={submitting || !formBranch.trim() || !validUrl}
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
