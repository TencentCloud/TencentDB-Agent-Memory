/**
 * OpenAI Responses wire 的会话 ID 提取（codex / workbuddy 等客户端共用）。
 *
 * 优先 `session-id` header（header 已统一小写），其次
 * `body.client_metadata.session_id`。返回 null 表示客户端没有显式会话 ID，
 * 由上层（sessionStage）决定自动生成或使用兜底键。
 */
export function extractResponsesSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  const fromHeader = headers["session-id"] ?? headers["Session-Id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;

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
