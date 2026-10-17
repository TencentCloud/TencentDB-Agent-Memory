/**
 * Client Capabilities Detection — 客户端能力探测.
 *
 * 目的：不同客户端对"proxy 侧发起 fake ask tool_call"的支持情况不同。
 *   - workbuddy 老版本：body.tools 里含 `AskUserQuestion` → 支持卡片表单（tool_calls SSE）
 *   - workbuddy 新版本：body.tools 里**不含** `AskUserQuestion` → 不支持卡片，需降级为纯文字回复
 *   - 其他客户端：本模块不做判定（保持原路径）
 *
 * 判定信号：agentSource + body.tools[]。**每次请求实时算**，不缓存，
 * 所以同一 sessionKey 下次带上 ask 工具会自动切回卡片模式。
 *
 * Scope（当前迭代）：只判定 workbuddy 有没有 `AskUserQuestion` 工具。
 * 其他客户端一律 `askUserQuestion: true`（走原逻辑），避免误伤 dsh / codebuddy /
 * claude-code / codex / opencode / hermes / openclaw 的既有分支。
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** WorkBuddy 侧用来弹卡片表单的工具名。跟 workbuddy/form.ts 里的 TOOL_NAME 保持一致。 */
export const WB_ASK_TOOL_NAME = "AskUserQuestion";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  /**
   * 客户端是否支持 proxy 发起"询问用户"的卡片工具调用。
   *
   * - `true`  → 走原有卡片模式（tool_calls SSE + form 渲染）
   * - `false` → 走文字模式（content chunk + markdown 渲染 + 纯文字解析）
   *
   * 目前仅 workbuddy 会返 false（body.tools 不含 AskUserQuestion 时）；
   * 其他客户端一律 true（保持既有行为）。
   */
  askUserQuestion: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * 从 body.tools[] 里检查是否包含指定名称的工具。
 *
 * 兼容两种 shape:
 *   - OpenAI:    `{ type: "function", function: { name: "..." } }`
 *   - flat:      `{ name: "..." }`
 *
 * tools 为空数组 / 非数组 / undefined 时返 false。
 */
function toolsContain(tools: unknown, name: string): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((t) => {
    if (!t || typeof t !== "object") return false;
    const fn = (t as { function?: { name?: string } }).function;
    const flatName = (t as { name?: string }).name;
    const n = fn?.name ?? flatName;
    return n === name;
  });
}

// ── Detection ──────────────────────────────────────────────────────────────────

/**
 * 探测当前请求的客户端能力。
 *
 * @param agentSource - 客户端类型，如 "workbuddy" / "codebuddy" / "dsh" / ...
 * @param body        - 原始请求 body（含 tools[]）
 * @returns 能力标记
 */
export function detectClientCapabilities(
  agentSource: string,
  body: unknown,
): ClientCapabilities {
  // 仅对 workbuddy 做能力判定；其他客户端一律走原路径。
  if (agentSource !== "workbuddy") {
    return { askUserQuestion: true };
  }

  // workbuddy：检查 body.tools[] 是否含 AskUserQuestion。
  // - tools 非数组 / 空数组 / 缺失 → 视为**无能力**（新版 WB 就是这个形态）
  //   这样处理更保守：宁可走文字模式（体验较差但能走通），
  //   也不要走卡片模式（客户端不识别 tool → 卡死）。
  const tools = (body as { tools?: unknown } | null | undefined)?.tools;
  const hasAskTool = toolsContain(tools, WB_ASK_TOOL_NAME);
  return { askUserQuestion: hasAskTool };
}
