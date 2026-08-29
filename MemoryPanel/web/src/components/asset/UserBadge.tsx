/**
 * UserBadge —— 通用「用户徽章」组件。
 *
 * 此前 Skills（SkillOwnerTag）与 Memory（UploaderBadge）各自实现了相同的
 * 「AssetBadge + UserIcon + displayName 展示 + 当前用户追加“你”标记」结构。
 * 这里统一收口；displayName 通过 useUserDisplayName 全局缓存获取，title /
 * youText / getTitle 由调用方注入以兼容各页 i18n。
 */
import { UserIcon } from 'tea-icons-react';
import { useUserDisplayName } from '@/services/user-profile-store';
import { AssetBadge, AssetBadgeYou } from './AssetListPanel';

export function UserBadge({
  userId,
  isCurrentUser,
  title,
  youText,
  getTitle,
}: {
  userId: string;
  /** 是否为当前用户（决定是否追加“你”标记） */
  isCurrentUser: boolean;
  /** hover 提示文本；默认 userId。若需基于 displayName 拼装（如 skills），用 getTitle */
  title?: string;
  /** “你”标记文案 */
  youText: string;
  /** 基于 displayName 生成 hover 提示的回调（优先于 title） */
  getTitle?: (displayName: string) => string;
}) {
  const displayName = useUserDisplayName(userId);
  const resolvedTitle = getTitle
    ? getTitle(displayName || userId)
    : (title ?? userId);
  return (
    <AssetBadge icon={<UserIcon size={10} />} title={resolvedTitle}>
      {displayName || userId}
      {isCurrentUser && <AssetBadgeYou>{youText}</AssetBadgeYou>}
    </AssetBadge>
  );
}
