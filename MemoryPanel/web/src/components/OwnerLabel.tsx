/**
 * OwnerLabel —— 通用「资产 Owner 展示」组件。
 *
 * 此前 Wiki（WikiOwnerLabel）与 Code（CodeOwnerLabel）各自实现了一模一样的
 * 「@displayName + 当前用户追加“你”标记」逻辑（都依赖 useUserDisplayName 全局
 * 缓存 + Rules of Hooks 约束下不能在 .map 里循环调 hook 的子组件结构）。
 * 这里统一收口；title / youText / youClassName 由调用方注入以兼容各页 i18n 与样式。
 */
import { useUserDisplayName } from '@/services/user-profile-store';

export function OwnerLabel({
  userId,
  currentUserId,
  title,
  youText,
  youClassName,
}: {
  userId: string;
  currentUserId: string;
  /** hover 提示文本（调用方负责 i18n，通常含 userId 插值） */
  title: string;
  /** “你”标记文案（当前用户时展示） */
  youText: string;
  /** “你”标记的 class（各页面可注入自己的样式类） */
  youClassName?: string;
}) {
  const name = useUserDisplayName(userId);
  return (
    <span title={title}>
      @{name || userId}
      {userId === currentUserId && (
        <span className={youClassName ?? '_owner-label-you'}>{youText}</span>
      )}
    </span>
  );
}
