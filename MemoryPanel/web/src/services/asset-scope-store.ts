/**
 * asset-scope-store.ts — 资产「可配置范围」统一覆盖层（本地 localStorage）。
 *
 * 从原 demoStore.ts 中抽出（独立职责：与 team/agent/task 本体的持久化方式
 * 无关，是叠加在 5 类资产之上的一层通用产品语义）。
 *
 * 需求：每个 owner 可以管理「自己的资产」，选择该资产是
 *   - team    团队内可配置：team 成员都能配置 / 编辑这条资产
 *   - private 仅自己私有：只有 owner（+ team admin / 全局 admin）能配置 / 编辑
 *
 * 这一层覆盖全部 5 类资产（agent / skill / code / wiki / memory）。不同资产的
 * 底层数据来源不同（backendStore / mock / 后端 knowledgeApi），但「可配置范围」
 * 这件事是统一的产品语义，所以单独抽一个轻量覆盖层：按 `${kind}:${asset_id}`
 * 存一条记录，与资产本体解耦。后端上线后换成一张 asset_acl 表即可，UI 不用改。
 */

import type { Team } from './backendStore';
import { isTeamAdmin, isTeamMember } from './backendStore';
import { emitChange, safeParse, useChangeNotifier } from './storage-utils';

const ASSET_SCOPES_KEY = 'tdai-memory.assetScopes.v1';

export type AssetKind = 'agent' | 'skill' | 'code' | 'wiki' | 'memory';
export type AssetConfigScope = 'team' | 'private';

export interface AssetScopeRecord {
  scope: AssetConfigScope;
  /** 该资产的 owner —— 谁有权改它的可配置范围。无归属资产首次设置者成为 owner。 */
  owner_user_id: string;
  updated_at_ms: number;
}

type AssetScopeMap = Record<string, AssetScopeRecord>;

function scopeKey(kind: AssetKind, asset_id: string): string {
  return `${kind}:${asset_id}`;
}

function readAssetScopeMap(): AssetScopeMap {
  if (typeof window === 'undefined') return {};
  return safeParse<AssetScopeMap>(localStorage.getItem(ASSET_SCOPES_KEY), {});
}

function writeAssetScopeMap(map: AssetScopeMap): void {
  try {
    localStorage.setItem(ASSET_SCOPES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  emitChange();
}

/**
 * 读取某条资产的可配置范围。
 * 未显式设置过的资产，默认 `team`（团队内可配置）—— 与现状（团队池共享）一致，
 * owner 回退到资产本体自带的 owner（fallbackOwner）。
 */
export function getAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  fallbackOwner = ''
): { scope: AssetConfigScope; owner_user_id: string } {
  const rec = readAssetScopeMap()[scopeKey(kind, asset_id)];
  if (rec) return { scope: rec.scope, owner_user_id: rec.owner_user_id || fallbackOwner };
  return { scope: 'team', owner_user_id: fallbackOwner };
}

/**
 * 设置某条资产的可配置范围。
 * owner 一旦确定就固定（取已有记录 → 资产自带 owner → 当前操作者）。
 * 调用方应先用 canManageAssetScope 做 UI 拦截；这里不重复鉴权（演示阶段）。
 */
export function setAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  scope: AssetConfigScope,
  actor: string,
  fallbackOwner = ''
): void {
  const map = readAssetScopeMap();
  const key = scopeKey(kind, asset_id);
  const owner = map[key]?.owner_user_id || fallbackOwner || actor;
  map[key] = { scope, owner_user_id: owner, updated_at_ms: Date.now() };
  writeAssetScopeMap(map);
}

/**
 * 谁能改一条资产的可配置范围：
 *   - 全局 admin / team admin → 可改（治理需要）
 *   - owner 本人 → 可改（"管理自己的资产"）
 *   - 无归属资产（ownerUserId 为空，如后端 Code/Wiki 没有 owner 概念）
 *     → 任意 team 成员可设置，首次设置者成为 owner
 */
export function canManageAssetScope(
  ownerUserId: string,
  team: Team | null | undefined,
  user_id: string,
  isAdmin?: boolean
): boolean {
  if (!user_id) return false;
  // 全局 admin 不再自动获得资产管理特权，与普通 member 一致：
  // 只有 owner 本人或 team admin 能改资产的可配置范围。
  // 保留 isAdmin 参数仅为兼容已有调用方签名（未来清理时可去掉）。
  void isAdmin;
  if (team && isTeamAdmin(team, user_id)) return true;
  if (!ownerUserId) return isTeamMember(team, user_id);
  return ownerUserId === user_id;
}

/**
 * 订阅资产可配置范围覆盖层的变化。
 * 组件用它在 setAssetConfigScope 后自动重渲染（返回值是递增 tick，仅用于触发刷新）。
 */
export function useAssetConfigScopes(): number {
  return useChangeNotifier();
}
