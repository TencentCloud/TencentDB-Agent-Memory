/**
 * Panel Session — 新面板前端会话缓存（localStorage）。
 *
 * 对接 docs/architecture/09-new-panel-control-backend-design.md §3.3.2：
 * 新面板 Control 是无状态代理，不建 Cookie/Session；登录凭证
 * （instance_id + user_key）由前端自行持有，缓存在 localStorage
 * （跨 tab 共享，关 tab 不失效），每次 meta 请求从这里读出注入 Header：
 *   - X-Tdai-Service-Id（= 注册表 id = 内核 x-tdai-service-id；早期版本文档曾用
 *     `X-Metadata-Instance-Id` 这个名字，meta-api.openapi.yaml v1.1.0 起已改名，
 *     务必以最新契约为准，否则 Control 会报 400 MISSING_INSTANCE_ID）
 *   - X-Tdai-User-Key（auth/verify 除外）
 *
 * 之前用 sessionStorage（tab 级），导致新开 tab 需要重新登录。
 * 改为 localStorage 后多 tab 共享登录态，登出时通过 storage 事件同步。
 */
import type { PublicUser } from './teamApi';

export interface PanelSession {
  /** 认证来源；缺省值代表旧 user_key 会话。 */
  authMethod?: 'user_key' | 'idp';
  /** = 注册表 id = 内核 x-tdai-service-id；登录页选择实例时确定 */
  instanceId: string;
  /** 仅展示用（实例列表里的 name），非必需 */
  instanceName?: string;
  /** 旧 user_key 会话的 API 密钥；IdP Session 使用空字符串占位，不会下发真实 user_key。 */
  userKey: string;
  /** auth/verify 响应 data.user（可选，用于展示 + 作为 owner_user_id/creator_user_id 来源） */
  user?: PublicUser;
}

const STORAGE_KEY = 'tdai-panel.session';

/** 读取当前会话；无会话或解析失败均返回 null（不抛错，调用方按未登录处理） */
export function getPanelSession(): PanelSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PanelSession;
  } catch {
    return null;
  }
}

/** 登录成功（auth/verify 返回 valid===true）后写入会话 */
export function setPanelSession(session: PanelSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* 隐私模式 / 存储配额异常：静默失败，不阻断登录后的本次会话内存态 */
  }
}

/** 登出 / 401 兜底时清空会话 */
export function clearPanelSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
