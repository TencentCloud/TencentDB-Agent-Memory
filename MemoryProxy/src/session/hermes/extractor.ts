/**
 * Hermes Session Init — Extractor（clarify 结果解包）。
 *
 * hermes 的 `clarify` 工具执行后，把用户回答以 JSON 字符串作为 role=tool 消息
 * 回填（tools/clarify_tool.py clarify_tool 的返回值）：
 *
 *   单题：{"question":"...","choices_offered":["A","B"],"user_response":"A"}
 *   批量：{"responses":[{"question":"...","user_response":"A"},...]}
 *         （timed_out=true 表示用户中途走人，剩余问题被 hermes 主动放弃）
 *   multi_select：user_response 是 string[]
 *   headless：{"error":"Clarify tool is not available in this execution context."}
 *             （callback=None，oneshot/api-server 场景）
 *   超时：user_response = TIMEOUT_RESPONSE
 *
 * # 为什么必须解包（不能把原始 JSON 直接喂 CB extractor）
 *
 * clarify 结果 JSON 会**原样回显 question 与 choices_offered**：
 *   - question 里含 SKIP_HINT（"跳过"字样）→ SKIP_RE 误判 bypass；
 *   - choices_offered 里含所有选项标签 → 误判。
 * 解包后的文本喂给 CB extractor 的 substring 匹配。
 */

import { ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

const TIMEOUT_PREFIX = "The user did not provide a response within the time limit";
const ONESHOT_MARKER = "[oneshot mode:";

/**
 * bypass 信号载体文本。
 * 含 ASSET_CONFIRM_NO（"否，本次不关联"）→ extractAssetConfirm 返回 false → bypass；
 * 含 "不关联" → SKIP_RE 命中 → BYPASS_MARKER。
 */
export const HERMES_BYPASS_TEXT = `${ASSET_CONFIRM_NO}（用户未响应会话初始化表单，自动跳过）`;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * 从 hermes clarify 的 role=tool 结果文本里解包出纯答案文本。
 *
 * 返回：
 *   - null            ：不是 hermes 结果包裹层 → 调用方继续走原始 content 老路径。
 *   - HERMES_BYPASS_TEXT：headless error / 超时 / oneshot / 批量中途弃答 → bypass。
 *   - ""              ：是包裹层但没有可用的 user_response → 当"未识别"处理。
 *   - 非空字符串       ：解包后的答案，直接喂 CB extractor。
 */
export function extractHermesAnswers(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // headless（callback=None）error 信封 → bypass。
  if (typeof obj.error === "string" && obj.error.length > 0) {
    return HERMES_BYPASS_TEXT;
  }

  // 批量形态：{responses: [...], timed_out?: true}
  if (Array.isArray(obj.responses)) {
    const answers: string[] = [];
    for (const r of obj.responses) {
      if (r && typeof r === "object") {
        const ur = (r as Record<string, unknown>).user_response;
        if (typeof ur === "string" && ur.trim().length > 0) answers.push(ur.trim());
      }
    }
    if (obj.timed_out === true) return HERMES_BYPASS_TEXT;
    return answers.join(" | ");
  }

  // 单题形态：{question, choices_offered, user_response}
  if ("user_response" in obj || "question" in obj) {
    const raw = obj.user_response;
    let text: string;
    if (Array.isArray(raw)) {
      text = raw.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).join(" | ");
    } else if (typeof raw === "string") {
      text = raw.trim();
    } else {
      text = "";
    }
    if (!text) return "";
    if (text.includes(TIMEOUT_PREFIX) || text.startsWith(ONESHOT_MARKER)) {
      return HERMES_BYPASS_TEXT;
    }
    return text;
  }

  return null;
}
