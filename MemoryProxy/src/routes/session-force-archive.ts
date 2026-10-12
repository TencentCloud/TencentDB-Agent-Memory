/**
 * POST /v3/session/force-archive-skill
 *
 * 手动强制归档当前 session 的 skill buffer（第三个触发条件）。
 *
 * 两种使用方式：
 *   1. 函数调用（mem:create-skill 内部用）— import forceArchiveSkill()
 *   2. HTTP 接口（面板前端用）— createSessionForceArchiveHandler() 注册路由
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { getSessionStore } from "../session/store.js";
import { getCoreSkillClient } from "../skill/core-client.js";
import type { SessionInitState } from "../session/types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ForceArchiveInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  reason?: string;
}

export interface ForceArchiveResult {
  success: boolean;
  status?: "archived" | "empty";
  taskId?: string;
  archiveKey?: string;
  archivedAtMs?: number;
  error?: string;
}

/** Core 接口返回类型 */
interface CoreForceArchiveResponse {
  status: "archived" | "empty";
  task_id?: string;
  archived_at_ms?: number;
  archive_key?: string;
  message?: string;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

/**
 * 手动强制归档当前 session 的 skill buffer。
 *
 * 从 SessionStore 取 sessionInfo → 调 CoreSkillClient.forceArchive() → 返回结果
 */
export async function forceArchiveSkill(input: ForceArchiveInput): Promise<ForceArchiveResult> {
  const { sessionKey, agentSource, config, spaceId, reason } = input;

  // 参数校验
  if (!sessionKey) {
    return { success: false, error: "session_key is required" };
  }

  // 从 SessionStore 取 session 状态
  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state: SessionInitState | undefined = store.get(compositeKey);

  if (!state || !state.sessionInfo) {
    return { success: false, error: `Session not found: ${sessionKey}` };
  }

  const sessionInfo = state.sessionInfo;

  // 调用 Core 接口
  try {
    const client = getCoreSkillClient(config.coreSkill);
    const coreResult = await client.forceArchive(
      {
        space_id: sessionInfo.space_id || spaceId,
        user_id: sessionInfo.user_id,
        team_id: sessionInfo.team_id,
        agent_id: sessionInfo.agent_id,
        session_id: sessionInfo.session_id,
        reason,
        task_id: sessionInfo.task_id,
      },
      { serviceId: sessionInfo.space_id || spaceId },
    );

    const result = coreResult as CoreForceArchiveResponse;

    if (result.status === "empty") {
      return { success: true, status: "empty" };
    }

    return {
      success: true,
      status: "archived",
      taskId: result.task_id,
      archiveKey: result.archive_key,
      archivedAtMs: result.archived_at_ms,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── HTTP Handler ───────────────────────────────────────────────────────────

/**
 * 创建 HTTP handler，注册到 server.ts。
 */
export function createSessionForceArchiveHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `force-archive-${Date.now()}` }, 400);
    }

    const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
    const agentSource = typeof body.agent_source === "string" ? body.agent_source : "claude-code";
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const spaceId = typeof body.space_id === "string" ? body.space_id : "";

    const result = await forceArchiveSkill({
      sessionKey,
      agentSource,
      config,
      spaceId,
      reason,
    });

    const requestId = `force-archive-${Date.now()}`;

    if (!result.success) {
      const status = result.error?.includes("not found") ? 404 : 500;
      return c.json({ code: status === 404 ? 40401 : 50001, message: result.error, request_id: requestId }, status);
    }

    return c.json({
      code: 0,
      message: "ok",
      request_id: requestId,
      data: {
        status: result.status,
        task_id: result.taskId,
        archive_key: result.archiveKey,
        archived_at_ms: result.archivedAtMs,
      },
    });
  };
}
