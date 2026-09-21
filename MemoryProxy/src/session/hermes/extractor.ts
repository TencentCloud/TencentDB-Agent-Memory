/**
 * Hermes Session Init — clarify 结果解包。
 *
 * # 结果形状（本机 hermes-agent 0.19.0 tools/clarify_tool.py 实证）
 *
 *   正常回答：
 *     {"question":"...","choices_offered":["A","B"],"user_response":"A"}
 *   无 UI（callback=None，例如 api-server / `-z` one-shot）：
 *     {"error":"Clarify tool is not available in this execution context."}
 *   超时：user_response = TIMEOUT_RESPONSE（"The user did not provide a response
 *     within the time limit"）
 *   one-shot 无人在场：user_response = "[oneshot mode: no user available. ...]"
 *
 * # 为什么必须解包
 *
 * clarify 的结果 JSON 会把 question 与 choices_offered **原样回显**，其中包含
 * "跳过"提示语和全部候选标签。若把原始 JSON 直接交给 CB extractor 的子串匹配：
 *   - question 里的"跳过"字样 → 误判成用户选择跳过（bypass）；
 *   - choices_offered 里的选项标签 → 误判成用户选择了第一项。
 * 因此这里只提取 user_response 本身，再交给下游状态机。
 *
 * 解包只发生在**读答复**的地方（codebuddy/cleaner.ts::getLastUserMessageText），
 * 不改动请求 body，转发给上游模型的消息保持原样。
 */

import { ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

const TIMEOUT_PREFIX = "The user did not provide a response within the time limit";
const ONESHOT_MARKER = "[oneshot mode:";

/**
 * bypass 信号载体文本。
 * 含 ASSET_CONFIRM_NO（"否，本次不关联"）→ extractAssetConfirm 返回 false → bypass；
 * 含"不关联" → SKIP_RE 命中 → BYPASS_MARKER。
 */
export const HERMES_BYPASS_TEXT = `${ASSET_CONFIRM_NO}（hermes 当前形态无法交互，自动跳过会话初始化）`;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * 尝试把 hermes clarify 的 tool 结果解包成纯答案文本。
 *
 * 返回：
 *   - null             ：不是 clarify 结果信封 → 调用方继续用原始 content 老路径；
 *   - HERMES_BYPASS_TEXT：error / 超时 / one-shot → 走 bypass；
 *   - ""               ：是信封但没有可用答复 → 交给状态机按"未识别"处理（可重试）；
 *   - 非空字符串        ：解包后的用户答复，直接喂 CB extractor。
 */
export function unwrapClarifyAnswer(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  // 无 UI 形态（callback 缺失）或工具自身报错 → bypass。
  if (typeof obj.error === "string" && obj.error.trim().length > 0) {
    return HERMES_BYPASS_TEXT;
  }

  // 必须带 user_response 或 question 才认为是我们关心的 clarify 信封，
  // 避免把其它 JSON 形态（例如 skill/memory 的工具结果）误判成表单答复。
  if (!("user_response" in obj) && !("question" in obj)) return null;

  const raw = obj.user_response;
  const text = Array.isArray(raw)
    ? raw
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter(Boolean)
        .join(" | ")
    : typeof raw === "string"
      ? raw.trim()
      : "";

  if (!text) return "";
  if (text.includes(TIMEOUT_PREFIX) || text.startsWith(ONESHOT_MARKER)) {
    return HERMES_BYPASS_TEXT;
  }
  return text;
}

/** 便捷判断：这段文本是不是 hermes clarify 的结果信封。 */
export function isClarifyAnswerEnvelope(content: string): boolean {
  return unwrapClarifyAnswer(content) !== null;
}
