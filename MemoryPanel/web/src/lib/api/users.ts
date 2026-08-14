/**
 * api/users.ts — User + UserKey + UserConfig（meta/user/* + meta/user-key/* + meta/config/user/*）。
 */
import { metaPost, metaListAll, getCurrentUser, dedupeInFlight } from './base';
import type { PublicUser } from './types';

/** 内核 user/create 响应（CreateUserResult） — 不含 username，含一次性密钥 */
export interface CreateUserResult {
  user_id: string;
  user_type: 'normal' | 'system_admin';
  created_at: string;
  /** 默认 API 密钥明文，仅此次响应返回 */
  default_user_key: string;
}

export const usersApi = {
  /** 分页列出用户；可传入 { username } 精确匹配或 { user_ids } 过滤 */
  list: (params?: { username?: string; user_ids?: string[] }) => metaListAll<PublicUser>('user/list', { ...params }),

  /** 用户详情 */
  get: (userId: string) => metaPost<PublicUser>('user/get', { user_id: userId }),

  /**
   * 新建用户（透明代理至后端 user/create）。
   *
   * 响应为 CreateUserResult：含 user_id / user_type / created_at / default_user_key。
   * default_user_key 为一次性明文密钥，仅此次响应返回。
   *
   * ⚠️ 权限：须当前用户持有 system_admin 权限；普通用户 → 403。
   */
  create: (data: { username: string; auth_provider: string; external_id: string; display_name?: string; email?: string }) =>
    metaPost<CreateUserResult>('user/create', data),

  /**
   * 新建用户并显式指定 user_key（透明代理至后端 user/create-with-key）。
   *
   * user/create 的姊妹接口：所有行为对齐 create，唯一区别是 default_user_key 直接采用调用方给的 user_key，
   * 而非由内核自动生成。适用于「面板 admin 建号时需要预先分配已知 key 给外部下发」的场景。
   * user_key 冲突会由内核返回 409 `duplicate_user_key`，Panel 后端原样透传。
   *
   * ⚠️ 权限同 create：须当前用户持有 system_admin 权限；普通用户 → 403。
   */
  createWithKey: (data: { username: string; user_key: string }) =>
    metaPost<CreateUserResult>('user/create-with-key', data),

  /**
   * 删除用户（透明代理至后端 user/delete）。
   *
   * ⚠️ 权限同上，须 system_admin 才能调用。
   */
  delete: (userId: string) => metaPost<{ ok: boolean }>('user/delete', { user_id: userId }),
};

// ========================= User API Keys（meta/user-key/*）=========================
//
// 走标准 meta action（与 team/agent 同模型，双 Header 鉴权）。

export interface UserKey {
  key_id: string;
  user_id?: string;
  name?: string;
  /** key 的可展示前缀（如 `sk-mem-ab12****`），内核 list/get 返回，用于免密识别具体是哪把 key */
  key_prefix?: string;
  /** 明文 key —— 仅创建响应里出现这一次，之后（list/get）内核不会再回传，安全设计如此 */
  key_value?: string;
  created_at?: string;
  expires_at?: string;
  revoked_at?: string;
  last_used_at?: string;
}

export const userKeysApi = {
  /** 列出当前登录用户的全部 API Key（按内核分页拉全量） */
  list: () => dedupeInFlight('user-key/list', () => metaListAll<UserKey>('user-key/list', {})),

  /** 创建一把新 Key；返回值里的 key_value 明文只展示这一次，调用方需立即展示给用户 */
  create: (data: { name?: string; expires_at?: string; user_id?: string }) => metaPost<UserKey>('user-key/create', data),

  /** 吊销一把 Key */
  revoke: (keyId: string) => metaPost<{ ok: boolean }>('user-key/revoke', { key_id: keyId }),
};

// ========================= User Config（meta/config/user/*）=========================

export type AssetCapabilityKey = 'skill.enabled' | 'llm_wiki.enabled' | 'code_graph.enabled' | 'chat_memory.enabled';

export interface UserConfigItem {
  module: string;
  param_name: AssetCapabilityKey | string;
  param_key: string;
  description: string;
  effective_value: string;
}

export interface UserConfigView {
  user_id: string;
  module: string;
  module_description: string;
  items: UserConfigItem[];
}

export type AssetCapabilityConfig = Record<AssetCapabilityKey, boolean>;

const ASSET_CAPABILITY_KEYS: AssetCapabilityKey[] = [
  'skill.enabled',
  'llm_wiki.enabled',
  'code_graph.enabled',
  'chat_memory.enabled',
];

function boolFromConfigValue(value: string | undefined): boolean {
  return value === undefined ? true : value === '1' || value.toLowerCase() === 'true';
}

export const userConfigApi = {
  get: (userId: string, module: string, paramName?: string) =>
    metaPost<UserConfigView>('config/user/get', { user_id: userId, module, param_name: paramName }),

  set: (userId: string, module: string, params: Record<string, string>) =>
    metaPost<{ ok: boolean }>('config/user/set', { user_id: userId, module, params }),

  getAssetCapabilities: async (): Promise<AssetCapabilityConfig> => {
    const me = await getCurrentUser();
    const view = await userConfigApi.get(me.user_id, 'asset_type');
    const byName = new Map(view.items.map((it) => [it.param_name, it.effective_value]));
    return Object.fromEntries(
      ASSET_CAPABILITY_KEYS.map((key) => [key, boolFromConfigValue(byName.get(key))]),
    ) as AssetCapabilityConfig;
  },

  setAssetCapability: async (key: AssetCapabilityKey, enabled: boolean) => {
    const me = await getCurrentUser();
    return userConfigApi.set(me.user_id, 'asset_type', { [key]: enabled ? '1' : '0' });
  },
};
