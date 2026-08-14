/**
 * CodeDetailView —— Code 资产详情视图（仓库信息 / 代码搜索 / 代码探索）。
 * 数据与回调来自 useCodeSources 返回对象；Markdown 用共享 AssetMarkdown（compact 密度）。
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, MetricsBoard, SearchBox, StatusTip, Text } from 'tea-component';
import { ArrowLeftIcon, CodeIcon, RefreshIcon } from 'tea-icons-react';
import { AssetMarkdown } from '@/pages/ResourcePage/components/AssetMarkdown';
import { formatRepoName } from './code-constants';
import { statusLabel } from './code-ui';
import type { CodeSourcesStore } from './useCodeSources';

export function CodeDetailView({ store }: { store: CodeSourcesStore }) {
  const { t } = useTranslation();
  const {
    setSubView,
    selected,
    handleSync,
    searchQuery,
    setSearchQuery,
    searching,
    searchResult,
    handleSearch,
    exploreQuery,
    setExploreQuery,
    exploring,
    exploreResult,
    handleExplore,
  } = store;

  if (!selected) return null;

  const selRepo = selected ? formatRepoName(selected.repo_name, selected.repo_url) : '';
  const selBranch = selected?.branch ?? '';

  return (
    <div className="_codedetail-root">
      {/* 返回面包屑 */}
      <div className="_codedetail-breadcrumb">
        <Button type="link" onClick={() => setSubView('list')}>
          <span className="_codedetail-inline-icon">
            <ArrowLeftIcon size={12} /> {t('code.detail.breadcrumb')}
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
              <CodeIcon size={20} />
              <span className="_codedetail-title" title={selRepo}>
                {selRepo}
              </span>
              {selected && statusLabel(t, selected.status)}
            </div>
            <div className="_codedetail-header-actions">
              <Button type="primary" onClick={() => handleSync(selected.code_graph_id)}>
                <span className="_codedetail-inline-icon">
                  <RefreshIcon size={14} />
                  {t('code.action.sync')}
                </span>
              </Button>
            </div>
          </div>
          <div className="_detail-meta-row">
            <span>{t('code.detail.branch', { branch: selBranch })}</span>
            {selected?.commit_hash && (
              <>
                <span className="_detail-meta-sep">·</span>
                <span className="_codedetail-mono">@ {selected.commit_hash}</span>
              </>
            )}
            {selected?.last_sync_at && (
              <>
                <span className="_detail-meta-sep">·</span>
                <span>{new Date(selected.last_sync_at).toLocaleString()}</span>
              </>
            )}
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
              <Text theme="label">{t('code.register.gitUrl')}</Text>
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
              <AssetMarkdown content={searchResult} compact />
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
              <AssetMarkdown content={exploreResult} compact />
            </div>
          )}
        </Card.Body>
      </Card>
    </div>
  );
}
