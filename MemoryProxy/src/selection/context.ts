/**
 * 与资产、策略都无关的判断依据构造工具：
 *   - `extractRawDialogue`：从原始协议消息抽取 user / assistant 文本
 *   - `stripInjectedRegions`：剔除 proxy 自己注入的块
 *   - `buildSelectionContext`：按预算裁剪成发给策略模型的 state
 */

/**
 * proxy 自己注入的块标记 —— 判断依据里必须剔除，否则上一轮注入/加载的资产正文会成为
 * 本轮判断依据，形成自我强化（模型越读到某项就越倾向继续选它）。
 */
const INJECTED_MARKERS = [
  "session_context",
  "available_skills",
  "skill_tools",
  "loaded_skill",
  "tdai_memory_tools",
  "knowledge_tools",
  "memory-tools-guide",
];

/** 移除所有 `<marker>…</marker>`（允许带属性）成对注入区段；保留区段之外的正文。 */
export function stripInjectedRegions(text: string): string {
  let out = text;
  for (const tag of INJECTED_MARKERS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?</${escaped}>`, "g"), "");
  }
  return out;
}

/**
 * 从原始协议消息（Anthropic / OpenAI Chat / Responses 形状）抽取判断用对话：只取 user / assistant
 * 的文本，剔除注入区段；tool_result / tool_use / thinking 不参与。
 */
export function extractRawDialogue(messages: unknown[]): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown; type?: unknown } | null;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    // Responses input[]：只取 message 项（function_call / reasoning 等无 role 或另有 type）。
    if (m.type !== undefined && m.type !== "message") continue;
    const parts: string[] = [];
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content as Array<Record<string, unknown>>) {
        const isText = b && (b.type === "text" || b.type === "input_text" || b.type === "output_text");
        if (isText && typeof b.text === "string") parts.push(b.text);
      }
    }
    const text = parts.map((t) => stripInjectedRegions(t).trim()).filter(Boolean).join("\n");
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

/**
 * 构造发给策略模型的判断依据（state）。
 *
 * 取材顺序（倒序遍历，优先保住最新的用户需求）：
 *   1. 最新消息（必须保留；单条超预算时截断保留尾部）
 *   2. 往前的近期对话，直到预算用完
 *   3. agent / task 目标（作为角色与任务背景，放在最前）
 *
 * 明确不取：system prompt（含其他 injector 产出的资产正文）。
 */
export function buildSelectionContext(args: {
  /** 已按时间正序的对话消息（role + 纯文本 content）。 */
  messages: Array<{ role: string; text: string }>;
  agentName?: string;
  agentDescription?: string;
  taskName?: string;
  taskDescription?: string;
  charBudget: number;
}): string {
  const { messages, agentName, agentDescription, taskName, taskDescription, charBudget } = args;

  const header: string[] = [];
  if (agentName || agentDescription) {
    header.push(`Agent role: ${[agentName, agentDescription].filter(Boolean).join(" — ")}`);
  }
  if (taskName || taskDescription) {
    header.push(`Current task: ${[taskName, taskDescription].filter(Boolean).join(" — ")}`);
  }
  const headerText = header.length > 0 ? header.join("\n") + "\n\n" : "";

  const remaining = Math.max(0, charBudget - headerText.length);
  const picked: string[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const text = m.text.trim();
    if (!text) continue;
    const line = `${m.role}: ${text}`;

    if (used + line.length > remaining) {
      // 最新一条（也就是第一次进入循环）必须保留：截断保留尾部，
      // 用户的真实诉求通常在末尾。
      if (picked.length === 0 && remaining > 0) {
        picked.push(line.slice(-remaining));
      }
      break;
    }
    picked.push(line);
    used += line.length;
  }

  picked.reverse();
  return headerText + picked.join("\n");
}
