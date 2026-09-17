/**
 * useUserNames — user_id → 用户名 的批量解析。
 *
 * 为什么不直接用 `useDisplayNameResolver`：它在渲染期对每个未命中的 id 单独发
 * 一次 `user/get`（本页 distinct_users 实测 29，且 trace / usage / raw 三张表都带
 * user_id），会打出数十个并发请求。这里改为一次 `user/list({ user_ids })` 批量拉取。
 *
 * 契约约束（已核对内核 `v3-meta-schemas.ts:userListSchema`）：
 *   - `user_ids` 上限 **100**，超过直接 400 → 故按 100 分批
 *   - 省略 `team_id` 时要求调用方是 system_admin（见 metadata-service
 *     `listUsersForCaller`：非 system_admin 抛 missing_team_id）。可观测页面本身
 *     admin-only，条件满足
 *   - Panel 代理层对 `user/list` 会执行 hideKnowledgeServiceUser 过滤，内部计费
 *     账号查不到 → 回退显示原始 id（预期行为，不视为错误）
 *
 * 解析结果会回灌 `seedDisplayNameCache`，供其他页面共享同一份缓存。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usersApi } from '@/lib/api/users';
import { seedDisplayNameCache } from '@/services/user-profile-store';

/** 内核 userListSchema 的 user_ids 上限。 */
const USER_IDS_BATCH_MAX = 100;

export function useUserNames(userIds: Array<string | null | undefined>): (id: string) => string {
  const [names, setNames] = useState<Record<string, string>>({});
  // 已发起过请求的 id（含解析失败的），避免对查不到的 id 反复重试
  const attemptedRef = useRef(new Set<string>());

  // 以内容而非数组引用作为依赖，否则每次渲染都会重新触发拉取
  const pendingKey = useMemo(() => {
    const unique = new Set<string>();
    for (const id of userIds) {
      if (id && !names[id] && !attemptedRef.current.has(id)) unique.add(id);
    }
    return [...unique].sort().join(',');
  }, [userIds, names]);

  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(',').filter(Boolean);
    ids.forEach((id) => attemptedRef.current.add(id));

    let cancelled = false;
    void (async () => {
      try {
        for (let i = 0; i < ids.length; i += USER_IDS_BATCH_MAX) {
          const batch = ids.slice(i, i + USER_IDS_BATCH_MAX);
          const users = await usersApi.list({ user_ids: batch });
          if (cancelled) return;

          const resolved: Record<string, string> = {};
          for (const u of users) {
            const name = u.display_name || u.username;
            if (name) resolved[u.user_id] = name;
          }
          if (Object.keys(resolved).length > 0) {
            setNames((prev) => ({ ...prev, ...resolved }));
            seedDisplayNameCache(
              Object.entries(resolved).map(([user_id, username]) => ({ user_id, username })),
            );
          }
        }
      } catch {
        // 静默失败：解析不到的 id 回退显示原始值，不阻塞看板
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pendingKey]);

  return useCallback((id: string) => (id ? (names[id] ?? id) : ''), [names]);
}
