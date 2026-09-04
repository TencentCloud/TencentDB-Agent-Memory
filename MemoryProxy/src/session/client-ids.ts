/**
 * 客户端会话 ID 提取（codex / workbuddy 共用）。
 *
 * 两边都走 OpenAI Responses wire：优先 `session-id` header，其次
 * `body.client_metadata.session_id`。返回 null 表示客户端没有显式会话 ID，
 * 由上层（sessionStage）决定自动生成或使用兜底键。
 */

/** Extract session_id from a codex request. */
export function extractCodexSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  if (headers["session-id"]) return headers["session-id"];
  const meta = body.client_metadata as { session_id?: string } | undefined;
  if (typeof meta?.session_id === "string") return meta.session_id;
  return null;
}

/** Extract session_id from a workbuddy request. */
export function extractWorkbuddySessionId(
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
