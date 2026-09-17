/**
 * user-profile-store.ts — 用户显示名缓存。
 *
 * 从后端 usersApi.get() 拉取 display_name，内存缓存避免重复请求。
 */

import { useState, useEffect, useCallback } from 'react';

// 内存缓存：user_id → display_name
const _displayNameCache = new Map<string, string>();
const _fetching = new Set<string>();
const _subscribers = new Set<() => void>();

function notify() { _subscribers.forEach((fn) => fn()); }

/** 批量写入展示名缓存（如 team-member/list 已带 username 时）。 */
export function seedDisplayNameCache(entries: Array<{ user_id: string; username?: string }>): void {
  let changed = false;
  for (const { user_id, username } of entries) {
    if (!user_id || !username?.trim()) continue;
    const name = username.trim();
    if (_displayNameCache.get(user_id) === name) continue;
    _displayNameCache.set(user_id, name);
    changed = true;
  }
  if (changed) notify();
}

/**
 * 订阅指定 user 的显示名。优先用内存缓存；未缓存时异步从后端拉取。
 */
export function useUserDisplayName(user_id: string | null | undefined): string {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    _subscribers.add(sub);
    return () => { _subscribers.delete(sub); };
  }, []);

  if (!user_id) return '';
  const cached = _displayNameCache.get(user_id);
  if (cached) return cached;

  // 未缓存 → 异步拉取
  if (!_fetching.has(user_id)) {
    _fetching.add(user_id);
    import('@/lib/teamApi').then(({ usersApi }) => {
      usersApi.get(user_id)
        .then((u) => {
          const name = u.display_name || u.username || user_id;
          _displayNameCache.set(user_id, name);
          notify();
        })
        .catch(() => { /* 静默失败 */ })
        .finally(() => { _fetching.delete(user_id); });
    });
  }

  return user_id; // 拉取完成前显示 user_id
}

/**
 * 批量场景（如列表 tooltip 需要 join 多个用户名）的解析器。
 * 返回稳定函数引用；渲染期触发未缓存 id 的拉取，缓存就绪后经订阅触发重渲染。
 * 与 useUserDisplayName 同套缓存/订阅，二者解析结果一致。
 */
export function useDisplayNameResolver(): (userId: string) => string {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    _subscribers.add(sub);
    return () => { _subscribers.delete(sub); };
  }, []);

  return useCallback((userId: string) => {
    if (!userId) return '';
    const cached = _displayNameCache.get(userId);
    if (cached) return cached;
    if (!_fetching.has(userId)) {
      _fetching.add(userId);
      import('@/lib/teamApi').then(({ usersApi }) => {
        usersApi.get(userId)
          .then((u) => {
            const name = u.display_name || u.username || userId;
            _displayNameCache.set(userId, name);
            notify();
          })
          .catch(() => { /* 静默失败 */ })
          .finally(() => { _fetching.delete(userId); });
      });
    }
    return userId;
  }, []);
}
