/**
 * useSkillDetailCache — 按需加载 skill 数据面详情缓存。
 *
 * 背景：asset/list-accessible 接口返回的资产列表只含 asset 层字段
 *（version 恒为 1，无 owner_agent_id），skill 数据面的真实 version 和
 * owner_agent_id 需要调 getSkill() 获取。旧实现在列表加载后对每条 skill
 * 并发 N 次 getSkill()（N+1），用户还没点开任何一条就把全部详情拉回来。
 *
 * 本 hook 改为按需：列表先用 asset 层默认值渲染，当用户选中某条 skill
 * 后才补拉那一条的数据面详情并写入缓存，后续同一 skill 再次命中直接读缓存。
 *
 * 使用方式（父组件）：
 *   const { getFromCache, preload, applyCachedDetail } = useSkillDetailCache(activeTeamId);
 *   useEffect(() => { if (selectedId) void preload(selectedId); }, [selectedId]);
 *   列表渲染：const s = applyCachedDetail(skill);
 */

import { useRef, useState, useCallback } from 'react';
import { getSkill } from '@/lib/api/skill-api';

export interface CachedSkillDetail {
  version: number;
  owner_agent_id: string;
}

export function useSkillDetailCache(teamId: string | null | undefined) {
  /** skill_id → 已拉取的数据面详情（version + owner_agent_id）。 */
  const cacheRef = useRef(new Map<string, CachedSkillDetail>());

  /** 正在请求中的 skill_id 集合，防止同一 skill 并发重复请求。 */
  const inFlightRef = useRef(new Set<string>());

  /** 每次缓存写入后 +1，父组件依赖此值在 useMemo 中重算列表项。 */
  const [cacheVersion, setCacheVersion] = useState(0);

  /** 同步读取缓存（不会触发请求）。 */
  const getFromCache = useCallback((skillId: string): CachedSkillDetail | undefined => {
    return cacheRef.current.get(skillId);
  }, []);

  /** 预加载一条 skill 的数据面详情（幂等，已缓存或正在请求的直接跳过）。 */
  const preload = useCallback(async (skillId: string) => {
    if (!teamId || !skillId) return;
    if (cacheRef.current.has(skillId) || inFlightRef.current.has(skillId)) return;
    inFlightRef.current.add(skillId);
    try {
      const full = await getSkill({
        skill_id: skillId,
        team_id: teamId,
        include_content: false,
        include_manifest: false,
      });
      cacheRef.current.set(skillId, {
        version: full.version,
        owner_agent_id: full.owner_agent_id,
      });
      setCacheVersion((n) => n + 1);
    } catch {
      // 静默失败：列表仍用 asset 默认值（v1 / 空 owner_agent_id）
    } finally {
      inFlightRef.current.delete(skillId);
    }
  }, [teamId]);

  /**
   * 用缓存里的最新值覆盖 skill 对象的 version / owner_agent_id 字段。
   * 缓存 miss 则原样返回，不影响渲染。
   */
  const applyCachedDetail = useCallback(<T extends { skill_id: string; version: number; owner_agent_id: string }>(
    skill: T,
  ): T => {
    const cached = cacheRef.current.get(skill.skill_id);
    if (!cached) return skill;
    return { ...skill, version: cached.version, owner_agent_id: cached.owner_agent_id };
  }, []);

  return { getFromCache, preload, applyCachedDetail, cacheRef, cacheVersion };
}
