import type { TdaiIdentity } from "./types.js";

interface SessionInfoLike {
  session_id?: unknown;
  team_id?: unknown;
  user_id?: unknown;
  agent_id?: unknown;
  task_id?: unknown;
}

/** 匿名默认身份兜底配置（来自 config.tdai.anonymous）。 */
export interface TdaiAnonymousConfig {
  enabled?: boolean;
  teamId?: string;
  agentId?: string;
  userId?: string;
}

export interface TdaiIdentitySource {
  sessionInfo?: Record<string, unknown> | null;
  /** User ID from auth/verify — replaces legacy codeBuddyUserId. */
  userId?: string | null;
  sessionKey?: string | null;
  /** 请求发起者 user_key（来自 Authorization: Bearer；ACL 校验用）。 */
  userKey?: string | null;
  /** 请求来源（如 codebuddy / claude-code），匿名兜底时作为 agentId。 */
  agentSource?: string | null;
  /** 匿名默认身份兜底配置（config.tdai.anonymous）。 */
  anonymous?: TdaiAnonymousConfig | null;
}

/**
 * Derive a fully-qualified TDAI identity from session state. Every required
 * field (team_id / user_id / agent_id / session_id) must come from the
 * session or auth layer — there is no fallback "team_default" / "u_default".
 * Missing any → return null and let the caller bypass memory injection.
 *
 * 例外：当 config.tdai.anonymous.enabled 为真（无 session / 无 auth 的匿名
 * 客户端，如 CodeBuddy），允许用默认 team/agent/user 兜底，使记忆仍可落盘。
 */
export function deriveTdaiIdentity(source: TdaiIdentitySource): TdaiIdentity | null {
  const session = source.sessionInfo as SessionInfoLike | undefined;
  let teamId = pickString(session?.team_id);
  let userId = pickString(session?.user_id) ?? pickString(source.userId);
  let agentId = pickString(session?.agent_id);
  const sessionId = pickString(session?.session_id) ?? pickString(source.sessionKey);
  const taskId = pickString(session?.task_id);
  const userKey = pickString(source.userKey);

  // 匿名兜底：仅在确实缺失身份字段且显式开启时生效。
  const anon = source.anonymous;
  if (anon?.enabled && (!teamId || !userId || !agentId)) {
    teamId = teamId || anon.teamId || "default";
    userId = userId || anon.userId || source.sessionKey || "anonymous";
    agentId = agentId || anon.agentId || source.agentSource || "codebuddy";
  }

  if (!teamId || !userId || !agentId || !sessionId) return null;
  return { teamId, userId, agentId, sessionId, taskId, userKey };
}

export function getTdaiIdentity(custom: Record<string, unknown> | undefined): TdaiIdentity | null {
  const userKey = pickString(custom?.userKey);
  return deriveTdaiIdentity({
    sessionInfo: custom?.session as Record<string, unknown> | null | undefined,
    userKey,
  });
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}