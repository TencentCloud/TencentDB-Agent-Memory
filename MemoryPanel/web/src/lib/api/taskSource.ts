/**
 * api/taskSource.ts — Task 外部来源（导入 Task）。
 *
 * 对应后端 /api/v1/task/source/*。
 *
 * 安全边界：**前端永不接触令牌**。
 *   - 令牌由 Panel 服务端从会话注入 Core，请求体里没有凭据字段；
 *   - 这里只拿到「是否已连接」的布尔与账号标识，拿不到 token 本身。
 */

import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

/** 外部工作项类型（TAPD: story / task / bug）。 */
export interface TaskSourceItemType {
  id: string;
  label: string;
}

/**
 * 认证方式：全部为用户手工填入的令牌（无 OAuth）。
 *
 * `token_doc_url`：该类令牌的申请/查看页地址，由部署配置下发。
 * 两种令牌常由不同系统颁发（太湖 / TAPD），故地址挂在**每个方式**上而非 provider 级。
 * 为 null 表示未配置 —— 前端据此不展示指引链接（不瞎跳、不硬编码备用地址）。
 */
export type AuthScheme =
  | { kind: 'bearer'; label: string; token_doc_url?: string | null }
  | { kind: 'basic'; label: string; token_doc_url?: string | null }
  | { kind: 'custom'; headerName: string; label: string; token_doc_url?: string | null };

/** 用户提交的令牌。随请求体发送，服务端不留存。 */
export interface Credential {
  kind: 'bearer' | 'basic' | 'custom';
  secret: string;
  username?: string;
  extra?: Record<string, unknown>;
}

export interface TaskSourceProvider {
  id: string;
  item_types: TaskSourceItemType[];
  max_batch_size: number;
  needs_workspace: boolean;
  auth_schemes: AuthScheme[];
  /** 来源支持的能力；未声明的能力前端隐藏对应入口（不假设所有来源都支持）。 */
  capabilities?: { todo?: boolean };
}

export interface TaskWorkspace {
  id: string;
  name: string;
}

export interface CandidateItem {
  external_id: string;
  item_type: string;
  scope?: string;
  title: string;
  url?: string;
  status?: string;
  updated_at?: string;
}

export interface CandidatePage {
  items: CandidateItem[];
  total: number;
  has_more: boolean;
}

/** 无 skipped：同一条目允许重复导入，不存在「已存在→跳过」的结果。 */
export interface ImportResult {
  created: Array<{ external_id: string; task_id: string }>;
  failed: Array<{ external_id: string; error: string }>;
}

function sessionHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  return {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

async function post<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>(
    'POST',
    `/api/v1/task/source/${action}`,
    body,
    sessionHeaders(),
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const taskSourceApi = {
  /** 已启用的来源列表。空数组 → 前端隐藏「导入 Task」入口。 */
  providers: (teamId: string) => post<{ providers: TaskSourceProvider[] }>('providers', { team_id: teamId }),

  /** 工作空间（TAPD 项目）列表。 */
  workspaces: (teamId: string, providerId: string, credential: Credential) =>
    post<{ workspaces: TaskWorkspace[] }>('workspaces', {
      team_id: teamId,
      provider_id: providerId,
      credential,
    }),

  /** 候选工作项（分页，story + task + bug 合并）。 */
  candidates: (
    teamId: string,
    providerId: string,
    credential: Credential,
    params: {
      workspace_id?: string;
      item_types?: string[];
      keyword?: string;
      owner?: string;
      status?: string;
      page?: number;
      limit?: number;
      /** 只看我的待办（走 TAPD 待办接口，不支持标题/处理人筛选）。 */
      only_todo?: boolean;
    },
  ) => post<CandidatePage>('candidates', { team_id: teamId, provider_id: providerId, credential, ...params }),

  /** 批量导入。单条失败不阻断其余，结果按 created / failed 分流。 */
  import: (
    teamId: string,
    providerId: string,
    credential: Credential,
    items: Array<{ external_id: string; item_type: string; scope?: string }>,
  ) => post<ImportResult>('import', { team_id: teamId, provider_id: providerId, credential, items }),
};
