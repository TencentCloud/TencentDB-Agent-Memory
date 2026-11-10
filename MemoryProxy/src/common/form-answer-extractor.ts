/**
 * Ask-user form answers —— 从 tool 结果里还原「用户在待选表单里到底答了什么」。
 *
 * 背景：`ask_user_question`（DSH / CC / CodeBuddy 的待选表单）的答案**不落在
 * `role: "user"` 上**，而是作为 tool 结果回流：
 *   - OpenAI Chat（dsh v0.1.x / codebuddy / workbuddy）：
 *     `{ role: "tool", tool_call_id, content: '{"answers":[...]}' }`
 *   - Anthropic（dsh v0.2+ / claude-code）：
 *     `role: "user"` 消息里的 `{ type: "tool_result", tool_use_id, content }` block
 *
 * `tdai/recorder.ts::extractLatestUserMessage` 只扫 `role === "user"`，于是
 * 表单回答结构性地进不了 L0：库里最后留下的永远是**表单之前**那句提问，
 * 而「用户到底选了哪一项 / 手填了什么」整段丢失。
 *
 * 本模块把这些 tool 结果还原成可读文本（选项文本 / 自定义输入），交给
 * recorder 当作本轮的 user 消息写入。session-init（proxy 自己伪造的选
 * Team/Agent/Task 表单）必须排除 —— 那是接入流程的产物，不是用户提问。
 */

/** dsh 原生 tool 名 + CC/CodeBuddy 的等价工具名。 */
const FORM_TOOL_NAMES = new Set(["ask_user_question", "AskUserQuestion", "ask_followup_question"]);

/**
 * session-init 伪造表单的 tool_call id 前缀（proxy 自己发的）。
 * 与 `session/codebuddy/cleaner.ts` 保持同一份清单：
 * CB `call_session_init_` / WB `call_wb_session_init_` / dsh `call_dsh_session_init_`
 * / opencode `call_oc_session_init_` / CC `toolu_cc_session_init_`。
 */
const SESSION_INIT_TOOLCALL_RE = /call_(?:wb_|dsh_|oc_)?session_init_|toolu_cc_session_init_/;

export interface FormAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

/** 表单工具（`ask_user_question` 家族）判定。 */
export function isFormToolName(name: unknown): boolean {
  return typeof name === "string" && FORM_TOOL_NAMES.has(name);
}

/** proxy 自己伪造的 session-init 表单，不参与 L0 抽取。 */
export function isSessionInitToolCallId(id: unknown): boolean {
  return typeof id === "string" && SESSION_INIT_TOOLCALL_RE.test(id);
}

/** content 可能是字符串，也可能是 `[{type:"text", text}]` 数组。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const p = part as Record<string, unknown>;
      if (p.type !== "text" && p.type !== "input_text") return "";
      return typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 解析 `{"answers":[{"id","selected":[],"custom"?}]}`。
 *
 * 形状不对（不是 JSON / 没有 answers / 结构不完整）一律返回 null —— 宁可
 * 少记一条，也不要把别的 tool 输出当用户说的话写进 L0。
 */
export function parseFormAnswers(content: unknown): FormAnswer[] | null {
  const raw = textOfContent(content).trim();
  if (!raw || !raw.includes('"answers"')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const answers = (parsed as { answers?: unknown }).answers;
  if (!Array.isArray(answers) || answers.length === 0) return null;

  const out: FormAnswer[] = [];
  for (const item of answers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string") return null;
    if (a.selected !== undefined && !Array.isArray(a.selected)) return null;
    if (a.custom !== undefined && typeof a.custom !== "string") return null;

    const selected = Array.isArray(a.selected)
      ? a.selected
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
    const custom = typeof a.custom === "string" && a.custom.trim() ? a.custom.trim() : undefined;

    if (!selected.length && !custom) continue;
    out.push({ id: a.id, selected, ...(custom ? { custom } : {}) });
  }

  return out.length ? out : null;
}

/**
 * 把答案渲染成可读文本。题目文本来自 assistant 的 tool_call 参数（`questions[]`），
 * 拿不到就只留答案本身 —— 只有答案也比丢掉整轮上下文强。
 *
 * 形态（多题用空行分隔）：
 *
 *   问：这条原则怎么存？
 *   答：不用做任何操作，因为你是接入了 TDAI 的……
 */
export function formatFormAnswers(answers: FormAnswer[], questionsById?: Map<string, string>): string {
  const blocks: string[] = [];
  for (const a of answers) {
    const parts = [...a.selected];
    if (a.custom) parts.push(a.custom);
    const answer = parts.join("；").trim();
    if (!answer) continue;
    const question = questionsById?.get(a.id)?.trim();
    blocks.push(question ? `问：${question}\n答：${answer}` : `答：${answer}`);
  }
  return blocks.join("\n\n");
}

/** 一个 tool_call 的元信息：工具名 + 题目 id → 题干。 */
export interface ToolCallMeta {
  name: string;
  questions: Map<string, string>;
}

function readQuestionsFromArgs(args: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof args !== "string" || !args.includes("questions")) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return out;
  }
  const questions = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(questions)) return out;
  for (const q of questions) {
    if (!q || typeof q !== "object" || Array.isArray(q)) continue;
    const item = q as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.question !== "string") continue;
    out.set(item.id, item.question);
  }
  return out;
}

/**
 * 扫一遍历史，收集所有 tool_call（两种协议）：
 * OpenAI 的 `assistant.tool_calls[]` 与 Anthropic 的 `tool_use` block。
 */
export function collectToolCalls(messages: readonly unknown[]): Map<string, ToolCallMeta> {
  const out = new Map<string, ToolCallMeta>();

  const add = (id: unknown, name: unknown, args: unknown) => {
    if (typeof id !== "string" || typeof name !== "string") return;
    out.set(id, { name, questions: readQuestionsFromArgs(args) });
  };

  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const msg = raw as Record<string, unknown>;

    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (!call || typeof call !== "object" || Array.isArray(call)) continue;
        const c = call as Record<string, unknown>;
        const fn = c.function && typeof c.function === "object" ? (c.function as Record<string, unknown>) : null;
        add(c.id, fn?.name, fn?.arguments);
      }
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_use") continue;
        add(b.id, b.name, b.input === undefined ? undefined : JSON.stringify(b.input));
      }
    }
  }

  return out;
}

/**
 * OpenAI Chat：`role: "tool"` 消息 → 表单答案文本。
 *
 * 工具名优先取历史里的 tool_call（OpenAI 的 tool 消息通常不带 name），
 * 历史被压缩掉时退回 `msg.name` / 纯形状判定。
 */
export function formAnswerFromToolMessage(
  msg: Record<string, unknown>,
  toolCalls: Map<string, ToolCallMeta>,
): string | null {
  const callId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
  if (isSessionInitToolCallId(callId)) return null;

  const meta = callId ? toolCalls.get(callId) : undefined;
  const ownName = typeof msg.name === "string" ? msg.name : "";
  if (meta && !isFormToolName(meta.name)) return null;
  if (!meta && ownName && !isFormToolName(ownName)) return null;

  const answers = parseFormAnswers(msg.content);
  if (!answers) return null;
  return formatFormAnswers(answers, meta?.questions) || null;
}

/** Anthropic：`role: "user"` 里的 `tool_result` block → 表单答案文本。 */
export function formAnswerFromToolResultBlocks(
  content: unknown,
  toolCalls: Map<string, ToolCallMeta>,
): string | null {
  if (!Array.isArray(content)) return null;

  let found: string | null = null;
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;

    const callId = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
    if (isSessionInitToolCallId(callId)) continue;
    const meta = callId ? toolCalls.get(callId) : undefined;
    if (meta && !isFormToolName(meta.name)) continue;

    const answers = parseFormAnswers(b.content);
    if (!answers) continue;
    const text = formatFormAnswers(answers, meta?.questions);
    if (text) found = found ? `${found}\n\n${text}` : text;
  }

  return found;
}
