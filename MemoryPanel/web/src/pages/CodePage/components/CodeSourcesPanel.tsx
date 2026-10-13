/**
 * CodeSourcesPanel —— Code 资产页主面板（列表视图 + 注册/分配组装）。
 * 列表视图渲染与组件组装；状态/数据逻辑在 useCodeSources，详情在 CodeDetailView，
 * Markdown 渲染统一走共享 AssetMarkdown。
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Copy, Form, Input, Justify, MetricsBoard, Modal, SearchBox, Segment, Select, StatusTip, Table, Text } from 'tea-component';
import { ChevronRightIcon, CodeIcon, DeleteIcon, RefreshIcon, UsergroupIcon, ViewListIcon, ViewModuleIcon } from 'tea-icons-react';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import AllocateAssetDialog from '@/components/asset/AllocateAssetDialog';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { formatRepoName, formatShortTime, isSshGitUrl, isValidGitUrl, SSH_SOURCE_ID, type ScopeTab, type StatusFilter, type ViewMode } from '../constants/code-constants';
import { CodeOwnerLabel, statusLabel } from './code-ui';
import { useCodeSources } from '../hooks/useCodeSources';
import { CodeDetailView } from './code-detail-view';
import '@/components/asset/asset-card.css';
import '../styles/code-sources-panel.css';

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
    // 外部来源
    formSourceType,
    setFormSourceType,
    sourceProviders,
    formCredential,
    setCredentialField,
    setFormCredential,
    openRegister,
    // SSH 两段式
    sshPublicKey,
    setSshPublicKey,
    showSshKey,
    setShowSshKey,
    submitCreate,
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
              <Button type="primary" onClick={openRegister} data-guide="create-code">
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
          // SSH 与 HTTPS 都算合法地址（SSH 走「取公钥 → 配置 → 建图」两段式）。
          const isSsh = isSshGitUrl(trimmedRepo);
          const validUrl = isValidGitUrl(trimmedRepo);
          // 已输入内容但又不是合法地址 → 提示格式错误。
          const showUrlError = !!trimmedRepo && !validUrl;
          // SSH 地址下来源固定为 SSH，不渲染令牌输入框（ssh provider 的 form_fields 为空）。
          const effectiveSourceType = isSsh ? SSH_SOURCE_ID : formSourceType;
          return (
            <Modal
              visible
              caption={showSshKey ? t('code.sshKey.caption') : t('code.register.caption')}
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
                      onChange={(v) => {
                        setFormRepo(v);
                        // 地址一改，上一次拿到的公钥态就失效了，收起公钥区。
                        setShowSshKey(false);
                        setSshPublicKey('');
                      }}
                      // 示例地址跟随来源：仅 SSH 来源展示 git@ / ssh:// 写法，
                      // 其余（公开、工蜂等平台来源）保持 https:// 示例不变。
                      placeholder={
                        effectiveSourceType === SSH_SOURCE_ID
                          ? t('code.register.gitUrlPlaceholderSsh')
                          : t('code.register.gitUrlPlaceholder')
                      }
                    />
                  </Form.Item>
                  {isSsh && !showSshKey && (
                    <Form.Item>
                      <Alert type="info">{t('code.register.sshHint')}</Alert>
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

                  {/* 外部来源：选了才需要令牌；来源清单来自 KS，为空则不显示该行 */}
                  {sourceProviders.length > 0 && (
                    <Form.Item
                      label={t('code.register.source')}
                      extra={isSsh ? t('code.register.sourceSshExtra') : t('code.register.sourceExtra')}
                    >
                      <Select
                        appearance="button"
                        size="full"
                        value={effectiveSourceType}
                        disabled={isSsh}
                        onChange={(value) => {
                          setFormSourceType(value);
                          setFormCredential({}); // 切换来源立即丢弃已填凭据
                        }}
                        options={[
                          { value: '', text: t('code.register.sourcePublic') },
                          // SSH 恒在下拉里（协议级来源，服务端不下发时也补一个，
                          // 否则 SSH 地址下下拉显示为空，用户会以为没选来源）。
                          ...(sourceProviders.some((p) => p.id === SSH_SOURCE_ID)
                            ? []
                            : [{ value: SSH_SOURCE_ID, text: t('code.source.ssh') }]),
                          ...sourceProviders.map((p) => {
                            // 展示名取 i18n（code.source.<id>）；未收录的来源回退 id。
                            const i18nKey = `code.source.${p.id}`;
                            const localized = t(i18nKey);
                            return {
                              value: p.id,
                              text: localized === i18nKey ? p.id : localized,
                            };
                          }),
                        ]}
                      />
                    </Form.Item>
                  )}

                  {/* ── SSH 两段式第 1 段产物：公钥 + 配置指引（放表单最下方，填写信息后才出现，视线自然落在底部按钮附近） ── */}
                  {showSshKey && (
                    <>
                      <Form.Item label={t('code.sshKey.publicKey')}>
                        <div className="_codelist-sshkey-box">
                          <code className="_codelist-sshkey-value">{sshPublicKey}</code>
                          <Copy text={sshPublicKey}>
                            <Button type="link">{t('code.sshKey.copy')}</Button>
                          </Copy>
                        </div>
                      </Form.Item>
                      <Form.Item>
                        <Alert type="info">
                          <div className="_codelist-sshkey-guide">
                            <Text>{t('code.sshKey.guideTitle')}</Text>
                            <ol>
                              <li>{t('code.sshKey.guideStep1')}</li>
                              <li>{t('code.sshKey.guideStep2')}</li>
                              <li>{t('code.sshKey.guideStep3')}</li>
                            </ol>
                            <Text theme="label">{t('code.sshKey.guideNote')}</Text>
                          </div>
                        </Alert>
                      </Form.Item>
                    </>
                  )}

                  {(() => {
                    // 按当前 provider 的 form_fields 动态渲染凭据表单。
                    // SSH 来源 form_fields 为空 → 这里自然什么都不渲染。
                    const provider = sourceProviders.find((p) => p.id === effectiveSourceType);
                    if (!provider) return null;
                    return provider.form_fields.map((field, idx) => {
                      const isLast = idx === provider.form_fields.length - 1;
                      // i18n key 规约：code.credField.<name>.{label,placeholder}
                      // 未收录 name 时 fallback 到 code.register.token* 老 key（bearer 场景保持兼容）
                      const labelKey = `code.credField.${field.name}.label`;
                      const label = t(labelKey);
                      const placeholderKey = `code.credField.${field.name}.placeholder`;
                      const placeholder = t(placeholderKey);
                      return (
                        <Form.Item
                          key={field.name}
                          label={label === labelKey ? t('code.register.token') : label}
                          required={field.required}
                          extra={
                            isLast && provider.token_doc_url ? (
                              <a
                                href={provider.token_doc_url}
                                target="_blank"
                                rel="noreferrer"
                                className="_codelist-token-doc"
                              >
                                {t('code.register.tokenDoc')}
                              </a>
                            ) : undefined
                          }
                        >
                          <Input
                            size="full"
                            type={field.secret ? 'password' : 'text'}
                            value={formCredential[field.name] ?? ''}
                            onChange={(v) => setCredentialField(field.name, v)}
                            placeholder={
                              placeholder === placeholderKey
                                ? t('code.register.tokenPlaceholder')
                                : placeholder
                            }
                          />
                        </Form.Item>
                      );
                    });
                  })()}
                </Form>
              </Modal.Body>
              <Modal.Footer>
                {/* 第 1 段已拿到公钥 → 主按钮变成「已配置，继续注册」，点它才真正建图 */}
                {showSshKey ? (
                  <Button
                    type="primary"
                    onClick={submitCreate}
                    disabled={submitting || !formBranch.trim() || !validUrl}
                    loading={submitting}
                  >
                    {submitting ? t('code.register.submitting') : t('code.sshKey.continue')}
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    onClick={handleRegister}
                    disabled={submitting || !formBranch.trim() || !validUrl}
                    loading={submitting}
                  >
                    {submitting ? t('code.register.submitting') : t('code.register.submit')}
                  </Button>
                )}
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
