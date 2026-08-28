import type { TdaiIdentity } from "./types.js";

interface SessionInfoLike {
  session_id?: unknown;
  team_id?: unknown;
  user_id?: unknown;
  agent_id?: unknown;
  task_id?: unknown;
}

export interface TdaiIdentitySource {
  sessionInfo?: Record<string, unknown> | null;
  /** User ID from auth/verify — replaces legacy codeBuddyUserId. */
  userId?: string | null;
  sessionKey?: string | null;
  /** 请求发起者 user_key（来自 Authorization: Bearer；ACL 校验用）。 */
  userKey?: string | null;
  /** thread 维度（评审意见 1）：task 之下的主题分组。 */
  threadId?: string | null;
}

/**
 * Derive a fully-qualified TDAI identity from session state. Every required
 * field (team_id / user_id / agent_id / session_id) must come from the
 * session or auth layer — there is no fallback "team_default" / "u_default".
 * Missing any → return null and let the caller bypass memory injection.
 */
export function deriveTdaiIdentity(source: TdaiIdentitySource): TdaiIdentity | null {
  const session = source.sessionInfo as SessionInfoLike | undefined;
  const teamId = pickString(session?.team_id);
  const userId = pickString(session?.user_id) ?? pickString(source.userId);
  const agentId = pickString(session?.agent_id);
  const sessionId = pickString(session?.session_id) ?? pickString(source.sessionKey);
  const taskId = pickString(session?.task_id);
  const userKey = pickString(source.userKey);
  const threadId = pickString(source.threadId);
  if (!teamId || !userId || !agentId || !sessionId) return null;
  return { teamId, userId, agentId, sessionId, taskId, userKey, threadId };
}

export function getTdaiIdentity(custom: Record<string, unknown> | undefined): TdaiIdentity | null {
  const userKey = pickString(custom?.userKey);
  return deriveTdaiIdentity({
    sessionInfo: custom?.session as Record<string, unknown> | null | undefined,
    userKey,
    threadId: custom?.threadId as string | null | undefined,
  });
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
