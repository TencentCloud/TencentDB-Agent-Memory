/**
 * code-ui —— Code 资产页的小型展示组件。
 * 从 CodeSourcesPanel.tsx 拆出：Owner 标签 / 状态标签。
 */
import { useTranslation } from 'react-i18next';
import { Tag } from 'tea-component';
import { useUserDisplayName } from '@/services/user-profile-store';

/**
 * Owner 展示 —— 走 user-profile-store 全局缓存，同一 owner 多行共享。
 * 抽子组件是 Rules of Hooks 要求（不能在 .map 里循环调 hook）。
 */
export function CodeOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
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
export function statusLabel(t: (key: string, options?: Record<string, unknown>) => string, s: string) {
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
    <span className="_codedetail-status">
      <Tag theme={theme} variant="soft" size="sm">
        {label}
      </Tag>
      {hint && <span className="_codedetail-status-hint">{hint}</span>}
    </span>
  );
}
