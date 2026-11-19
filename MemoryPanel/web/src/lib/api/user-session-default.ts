/**
 * api/user-session-default.ts — v3.3 用户级 Session 默认 (team, agent, task) 三元组。
 *
 * 对应设计文档: MemoryProxy/docs/design/2026-10-10-user-session-default-design.md
 * 后端契约:     MemoryProxy/docs/design/2026-10-10-user-session-default-api.md
 *
 * 路径都走 Panel BFF 通用透传 `/api/v1/meta/user-session-default/{get,set,delete}`,
 * BFF 侧仅在 meta-actions.ts 白名单里加了 3 条, 不新建路由文件。
 *
 * 契约要点:
 *   - caller 必须 == user_id (本人改本人), 否则 Core 返 403 permission_denied
 *   - task_id 必填非空字符串; "不绑定任何 Task" 场景传字面量 "default"
 *     (与 Proxy sessionInit.defaultTaskId 契约一致, 见设计文档 §3.1.1)
 *   - Get 未配置时 Core 返回 `{code:0, data:null}` (不是 404); 经 Panel BFF 的
 *     通用 transport 兜底会变成 `{}`。本层按内容判空返回 null, 便于页面
 *     "未设置"态渲染。详见 isEmptyDefault 注释。
 */
import { metaPost, getCurrentUser } from './base';

/** 用户选"不绑定任何 Task"时传的字面量值 (与 Core/Proxy 侧 DEFAULT_TASK_SENTINEL 对齐)。 */
export const DEFAULT_TASK_SENTINEL = 'default';

/** 对应 Core `UserSessionDefaultEntity`。 */
export interface UserSessionDefaultEntity {
  user_id: string;
  team_id: string;
  agent_id: string;
  /** 真实 task_id 或字面量 "default"。 */
  task_id: string;
  created_at: string;
  updated_at: string;
}

export interface SetUserSessionDefaultInput {
  team_id: string;
  agent_id: string;
  /** 必填; "不绑定任何 Task" 显式传 DEFAULT_TASK_SENTINEL ("default")。 */
  task_id: string;
}

/**
 * 判定 get 返回值是否为"未配置"。
 *
 * ⚠️ 不能用错误码 / try-catch 判"未配置" —— Core 的设计是**未配置时正常返回
 * `{code:0, data:null}`**（不是 404）。而 Panel BFF 的通用 transport
 * (`kernel/transport-fetch.ts` 的 `data: (env.data ?? {})`) 会把 `data:null`
 * 兜底成 `{}`，因此前端实际收到的是 `{code:0, data:{}}`：
 *   - `unwrapEnvelope` 的 `code!==0` 分支不触发（code=0）
 *   - `unwrapEnvelope` 的 `data==null` 分支也不触发（{} 非 null）
 *   → 直接 return `{}`，不抛错。
 *
 * 所以必须**按内容判空**：既认 null/undefined，也认"没有 team_id 的空对象"。
 * 用 `team_id` 作为真值判据（单条约束下 team_id 恒非空，比裸判 `{}` 更稳，
 * 未来加字段也不会误判）。
 */
function isEmptyDefault(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (typeof data !== 'object') return true;
  return !(data as UserSessionDefaultEntity).team_id;
}

export const userSessionDefaultApi = {
  /**
   * 读当前用户的默认配置。
   *
   * 未配置时返回 null（Core 返 `data:null`，经 BFF 变 `{}`，见 isEmptyDefault 注释），
   * 页面照正常"未设置"态渲染。其他错误原样抛出，由 UI 层 toast 展示。
   */
  get: async (): Promise<UserSessionDefaultEntity | null> => {
    const me = await getCurrentUser();
    const data = await metaPost<UserSessionDefaultEntity>('user-session-default/get', {
      user_id: me.user_id,
    });
    if (isEmptyDefault(data)) return null;
    return data;
  },

  /**
   * 覆盖写入当前用户的默认配置 (Upsert)。
   *
   * caller 强制等于当前登录 user_id, 禁止代设他人。
   * task_id 必填; "不绑定任何 Task" 显式传 DEFAULT_TASK_SENTINEL。
   */
  set: async (input: SetUserSessionDefaultInput): Promise<UserSessionDefaultEntity> => {
    const me = await getCurrentUser();
    return metaPost<UserSessionDefaultEntity>('user-session-default/set', {
      user_id: me.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
    });
  },

  /**
   * 清除当前用户的默认配置。幂等: 不存在也不报错。
   *
   * 清除后下次新 Session 自动回退到: ① header preset → ② 交互表单
   * (设计文档 §2.2 优先级链)。
   */
  delete: async (): Promise<void> => {
    const me = await getCurrentUser();
    await metaPost<{ ok: boolean }>('user-session-default/delete', {
      user_id: me.user_id,
    });
  },
};
