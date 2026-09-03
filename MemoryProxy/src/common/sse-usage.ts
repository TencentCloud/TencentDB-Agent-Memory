/**
 * 从 SSE 文本中提取 usage（已知边界修复）：
 * 部分上游无视 `stream=false` 仍按 SSE 返回，非流式 handler 拿到整段 SSE 文本
 * 无法解析 usage。这里扫描所有 `data: {...}` 帧，合并 usage 字段
 * （Anthropic `message_delta.usage` / Responses `response.completed.usage`）。
 */

export function extractUsageFromSseText(text: string): Record<string, unknown> | null {
  if (!text || !text.includes("data:")) return null;
  const merged: Record<string, unknown> = {};
  let found = false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload) as Record<string, unknown>;
      const usage =
        (evt.usage as Record<string, unknown> | undefined) ??
        (evt.response as { usage?: Record<string, unknown> } | undefined)?.usage;
      if (usage && typeof usage === "object") {
        Object.assign(merged, usage);
        found = true;
      }
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }
  return found ? merged : null;
}
