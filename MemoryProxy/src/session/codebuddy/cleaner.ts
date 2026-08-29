/**
 * CodeBuddy Session Init — LastUser text extractor.
 *
 * 曾经这个文件里有 `stripInitArtifacts` 用来在 session_init 完成后剥离
 * 假表单对话（避免 LLM 看到 form 交互）。**该功能已删除**——现在永远保留
 * 用户的所有真实对话（含 session_init form 交互），不做任何删除。
 *
 * 目前只剩一个 export: `getLastUserMessageText`，用于在 session_init
 * state machine 里读最后一条 user / tool 消息的文本以解析用户选择。
 *
 * ── CodeBuddy ask_followup_question 回写格式 ──
 *
 * 用户点击表单后，CodeBuddy 下一条请求中问答所在的消息结构：
 *
 *   [N-2] role=assistant  tool_calls=[{id:"call_session_init_...", function:{name:"ask_followup_question"}}]
 *   [N-1] role=tool       tool_call_id=call_session_init_...  content=<multi_question_result JSON>
 *   [N]   role=user       content=<additional_data> 或其他普通 user 消息
 *
 * multi_question_result JSON（实际抓包格式）：
 *   空壳中间态（表单刚展示，用户还没点）：
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","options":[...],"multiSelect":false}],
 *      "answers":{},
 *      "message":"Questions displayed. User response will be in <que"}}
 *
 *   真实答案（用户点击后）：
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","answer":"Team名 (id尾8位)",...}],
 *      "answers":{"team":"Team名 (id尾8位)"}}}
 *
 * getLastUserMessageText 当前只扫描 user 消息，不处理 tool 消息。
 * team 提取依赖 extractor 的 substring 兜底匹配在无关 user 文本中碰巧蹭到 team 名，
 * 不是精确解析。如需可靠提取，需增加 tool 消息解析路径。
 */

import { containsFormTitle } from "./form.js";

interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get text from last user or tool message containing form answer data.
 *
 * CodeBuddy writes form responses as `role: "tool"` messages with
 * `tool_call_id` matching the session init `ask_followup_question`.
 * We look at BOTH user messages (for old XML `<question_answer>` format)
 * AND tool messages (for the actual `multi_question_result` / plain-text
 * answer format) — picking the LAST relevant one, whichever role it has.
 */
export function getLastUserMessageText(messages: RawMessage[]): string {
  // Sweep from end: the last message (user or tool) that relates to
  // session init is what we want. Tool messages are preferred because
  // CB writes "是，关联团队资产" etc. into tool_result content.
  let best = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role !== "user" && role !== "tool") continue;

    const text = getMessageText(messages[i]);
    if (!text) continue;

    // Tool messages linked to a session-init tool_call are always relevant.
    // 兼容四种前缀：CB 的 `call_session_init_`、WB 的 `call_wb_session_init_`
    // （workbuddy/form.ts 里 TOOLCALL_PREFIX = "call_wb_session_init_"）、
    // dsh 的 `call_dsh_session_init_`（dsh/form.ts TOOLCALL_PREFIX）、
    // opencode 的 `call_oc_session_init_`（opencode/form.ts TOOLCALL_PREFIX）。
    const tcid = (messages[i] as any).tool_call_id as string | undefined;
    if (role === "tool" && tcid && /call_(wb_|dsh_|oc_)?session_init_/.test(tcid)) {
      return text;
    }

    // User messages with form markers have highest priority for old format
    if (role === "user" && (text.includes("<question_answer") || containsFormTitle(text))) {
      return text;
    }

    // Remember the last user/tool text as fallback
    if (!best && role === "user") {
      best = text;
    }
  }
  return best;
}

function getMessageText(msg: RawMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as AnthropicBlock[]) {
      if (raw.type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}
