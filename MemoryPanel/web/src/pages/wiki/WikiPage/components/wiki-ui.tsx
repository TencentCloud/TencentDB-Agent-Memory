/**
 * wiki-ui —— Wiki 资产页的小型展示组件。
 * 从 WikiSourcesPanel.tsx 拆出：状态徽章 / Owner 标签 / 懒加载知识图谱容器。
 */
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusTip, Tag } from 'tea-component';
import type { GraphData, GraphNode, WikiDetail, WikiPage } from '@/lib/knowledge-api';
import { useUserDisplayName } from '@/services/user-profile-store';
import { WIKI_STATUS_KEY, WIKI_STATUS_THEME } from './wiki-constants';

export function WikiStatusBadge({ status }: { status: WikiDetail['status'] }) {
  const { t } = useTranslation();
  const theme = WIKI_STATUS_THEME[status] ?? ('default' as const);
  const label = WIKI_STATUS_KEY[status] ? t(WIKI_STATUS_KEY[status]) : status;
  return (
    <Tag theme={theme} variant="soft" size="sm">
      {label}
    </Tag>
  );
}

/**
 * Owner 展示 —— 显示用户名而非 user_id。
 * useUserDisplayName 内部有全局缓存 + 只在首次 miss 时发 usersApi.get，
 * 同一 user_id 多行共享同一份缓存，扩展性 O(distinct user 数)，不是 O(行数)。
 * 抽子组件是因为 Rules of Hooks —— 不能在 .map 里循环调 hook。
 */
export function WikiOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span title={t('wiki.detail.owner', { userId })}>
      @{name || userId}
      {userId === currentUserId && <span className="ml-1 text-xs text-primary">{t('wiki.detail.you')}</span>}
    </span>
  );
}

// ═══════════════════════════════════════════
// Knowledge Graph Embed (lazy loaded sigma)
// ═══════════════════════════════════════════
const KnowledgeGraphLazy = lazy(() => import('./KnowledgeGraph'));

export function KnowledgeGraphEmbed({
  data,
  loading,
  onNodeClick,
  highlightNode,
}: {
  data: GraphData | null;
  loading: boolean;
  onNodeClick: (node: GraphNode) => void;
  highlightNode: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<StatusTip status="loading" loadingText={t('wiki.detail.graph.loading')} />}>
      <KnowledgeGraphLazy
        data={data}
        loading={loading}
        onNodeClick={onNodeClick}
        highlightNode={highlightNode}
        className="_wiki-detail-graph-embed"
      />
    </Suspense>
  );
}

// 导出类型供外层复用，避免 import 类型路径散落
export type { WikiPage };
