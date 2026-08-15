/**
 * api/assets.ts — 资产管理（meta/asset/*）。
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Asset, AssetType, AssetStatus } from './types';

function newExternalAssetId(assetType: AssetType): string {
  const prefix = { skill: 'skl', llm_wiki: 'wiki', code_graph: 'cg', chat_memory: 'mem' }[assetType];
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${suffix}`;
}

export const assetsApi = {
  /** 列出 team 资产（支持按 type/status/owner 筛选） */
  list: (
    teamId: string,
    params?: { asset_type?: AssetType; status?: AssetStatus; owner_user_id?: string }
  ) =>
    metaListAll<Asset>('asset/list', {
      team_id: teamId,
      asset_type: params?.asset_type,
      status: params?.status,
      owner_user_id: params?.owner_user_id,
    }),

  /** 资产详情 */
  get: (assetId: string) => metaPost<Asset>('asset/get', { asset_id: assetId }),

  /** 创建/登记资产（两段式：主表 + 详情表） */
  create: async (
    teamId: string,
    data: {
      asset_type: AssetType;
      name: string;
      description?: string;
      source_type?: string;
      content_ref?: string;
      visibility?: string;
      metadata_json?: string;
      detail?: Record<string, unknown>;
    }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Asset>('asset/create', {
      asset_id: newExternalAssetId(data.asset_type),
      team_id: teamId,
      asset_type: data.asset_type,
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
      source_type: data.source_type ?? 'uploaded',
      content_ref: data.content_ref,
      visibility: data.visibility ?? 'team',
      metadata_json: data.metadata_json,
      detail: data.detail,
    });
  },

  /** 更新资产 */
  update: (
    assetId: string,
    data: Partial<{ name: string; description: string; status: AssetStatus; visibility: string }>
  ) => metaPost<Asset>('asset/update', { asset_id: assetId, ...data }),

  /** 删除资产（meta asset/delete → 物理删除行） */
  delete: async (assetId: string) => {
    await metaPost<{ deleted_ids: string[] }>('asset/delete', { asset_ids: [assetId] });
  },

  /**
   * 列出当前用户在指定 team 内**可访问**的资产（走后端 permission-checker，
   * 严格执行 visibility × ACL 过滤）。
   *
   * 与 asset/list 的区别：
   *   - asset/list：SQL 直查 meta_assets，不做 visibility/ACL 过滤，adminOps 视角。
   *   - asset/list-accessible：先按 visibility × role × ACL 计算可见集合，
   *     私密 skill 别人自动看不到；owner 优先放行。
   *
   * 可选 `visibility` 参数：在服务端做二次白名单过滤（例 `['team']` 只返回
   * 团队共享的），避免"响应体带全量、前端 JS 过滤"的信息泄露风险。
   *
   * 用于"团队资产"tab —— 团队成员应该只看到"团队公开 + 自己私密 + 显式授权"三部分。
   */
  listAccessible: async (
    teamId: string,
    params?: {
      asset_type?: AssetType;
      action?: 'read' | 'write' | 'use';
      visibility?: Asset['visibility'] | Asset['visibility'][];
    }
  ): Promise<Asset[]> => {
    const me = await getCurrentUser();
    return metaListAll<Asset>('asset/list-accessible', {
      user_id: me.user_id,
      team_id: teamId,
      asset_type: params?.asset_type,
      action: params?.action ?? 'read',
      visibility: params?.visibility,
    });
  },
};
