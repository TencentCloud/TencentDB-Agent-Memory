/**
 * OpenAI Responses wire 的会话 ID 提取（codex / workbuddy 等客户端共用）。
 *
 * 显式会话 header 与 `resolveConversationId`（chat / anthropic 路径）取同一集合、
 * 同一优先级：`session-id` > `x-conversation-id` > `x-session-id` > `x-chat-id` >
 * `x-thread-id`；全部缺失时退回 `body.client_metadata.session_id`。返回 null 表示
 * 客户端没有显式会话 ID，由上层（sessionStage）决定自动生成或使用兜底键。
 */
const EXPLICIT_SESSION_HEADERS = [
  "session-id",
  "x-conversation-id",
  "x-session-id",
  "x-chat-id",
  "x-thread-id",
] as const;

export function extractResponsesSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  // stages/session.ts 传入的 header 已统一小写；此处再兜一层大小写容错，
  // 便于直接以原始 header 调用（单测、后续新增调用点）。
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  for (const name of EXPLICIT_SESSION_HEADERS) {
    const value = lower[name];
    if (typeof value === "string" && value.length > 0) return value;
  }

  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const sid = meta.session_id;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return null;
}

/** 兼容别名：codex 的显式会话 ID 提取。 */
export const extractCodexSessionId = extractResponsesSessionId;
/** 兼容别名：workbuddy 的显式会话 ID 提取。 */
export const extractWorkbuddySessionId = extractResponsesSessionId;
