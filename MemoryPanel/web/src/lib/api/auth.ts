/**
 * api/auth.ts — 登录验活 + 环境绑定。
 *
 * 登录流程：
 *   ① GET /meta/instances 选实例
 *   ② 用户输入自持的 user_key（sk-mem-…）
 *   ③ POST /meta/auth/verify（Header 仅 X-Tdai-Service-Id，body 带 user_key）
 *   ④ data.valid === true → 登录成功，前端把 { instance_id, user_key, user } 写入 session
 * 无 OAuth、无 Cookie；见 lib/panelSession.ts。
 */
import { request, metaCall } from './base';
import type { PublicUser } from './types';

export const authVerifyApi = {
  /** 登录验活：Header 仅带实例 ID，user_key 只放 body（meta-api.openapi.yaml §auth/verify） */
  verify: (instanceId: string, userKey: string) =>
    metaCall<{ valid: boolean; user?: PublicUser }>(
      'auth/verify',
      { user_key: userKey },
      { 'X-Tdai-Service-Id': instanceId }
    ),
};

// ========================= Environment Bindings =========================
//
// ⚠️ 当前部署未注册 /api/v1/users/* 路由，以下接口可能 404。
// 保留代码用于兼容仍启用该路由的环境；若某个页面依赖这组接口，请先确认路由已注册。

/**
 * 环境绑定（environment_bindings）：把用户在外部环境（IDE / 编程助手等）的
 * 外部 user_id 与本平台 user 关联，供 proxy 通过 (environment, environment_user_id)
 * 反查到团队 / agent / task。
 *
 * 唯一约束：(environment, environment_user_id) 全局唯一；被他人占用 → 409。
 */
export interface EnvironmentBinding {
  id: string;
  user_id: string;
  environment: string;
  environment_user_id: string;
  created_at: string;
  updated_at: string;
}

export const environmentBindingsApi = {
  /** 列出当前登录用户的全部绑定 */
  list: () => request<EnvironmentBinding[]>('GET', '/api/v1/users/me/environment-bindings'),

  /** 新增一条绑定（幂等：同 user 重复 POST 同样的 (env, env_user_id) 不报错） */
  create: (data: { environment: string; environment_user_id: string }) =>
    request<EnvironmentBinding>('POST', '/api/v1/users/me/environment-bindings', data),

  /** 删除一条绑定（只能删自己的；删别人 → 403） */
  remove: (id: string) => request<{ ok: boolean }>('DELETE', `/api/v1/users/me/environment-bindings/${id}`),
};
