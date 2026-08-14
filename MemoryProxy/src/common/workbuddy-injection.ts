/**
 * WorkBuddy 资产注入 —— `<tdai_injections>` wrapper 生成器。
 *
 * 与 codex-injection.ts **同构但独立**：WorkBuddy 也用 OpenAI Responses API
 * (@openai/agents SDK)，body 结构与Codex 一致（`input[]` 数组、developer/user
 * message 混合、content 数组含 input_text）。逻辑本可以复用，但按项目
 * "clients 相互解耦"的方针，故意copy 一份独立文件；改动 WorkBuddy 不牵连
 * Codex，反之亦然。
 *
 * 两种模式（与 codex-injection 保持相同的双模式设计）：
 *   - **raw**（当前 handler 走的路径）：pipeline 已经产出的**完整成品文本**
 *     （含 `<available_skills>` / `<user_memory>` / `<tdai_profile_memory>` /
 *     `<memory-tools-guide>` 等多组内部 XML tag）原样嵌进 wrapper 内层，不再
 *     escape 或加子 tag —— 与 CC / CB / Codex 客户端在 system message 里看到
 *     的内容**字节一致**。
 *
 *   - **structured**（`{skills, memory, ...}` 5 段拆分）：预留给未来 WorkBuddy
 *     专属渲染器（如需要按段拆开时启用）。当前 pipeline 主链路**不能用**这种
 *     模式（pipeline 输出是单一 text，无法拆回 5 段；错用会把整段塞进
 *     `<available_skills>` 单个 tag 并被 XML escape，模型读不懂）。
 *
 * 详见docs/workbuddy-recon/ 与本目录 codex-injection.ts 的模块doc。
 */

// ── XML escape ───────────────────────────────────────────────────────────────

/**
 * XML entity encode：转义 < > & " ' 五个 XML特殊字符。
 * 仅 structured 模式使用；raw 模式（当前主链路）不 escape。
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Segments ─────────────────────────────────────────────────────────────────

/** structured 模式子段定义：tag 名 + 对应输入字段名。顺序即渲染顺序。 */
const SEGMENTS: Array<{ tag: string; field: keyof WorkbuddyInjectionInputStructured }> = [
  { tag: "available_skills", field: "skills" },
  { tag: "user_memory", field: "memory" },
  { tag: "agents", field: "agents" },
  { tag: "tasks", field: "tasks" },
  { tag: "knowledge", field: "knowledge" },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Raw 模式输入：pipeline 已经产出的完整 XML 文本串（不做二次 escape / 包裹）。
 * 当前 WorkBuddy handler 走这条路径。
 */
export interface WorkbuddyInjectionInputRaw {
  raw: string;
}

/**
 * Structured 模式输入：5 段拆分（预留给未来 WorkBuddy 专属渲染器）。
 * ⚠️ 不要给当前 pipeline 主链路使用。
 */
export interface WorkbuddyInjectionInputStructured {
  skills?: string;
  memory?: string;
  agents?: string;
  tasks?: string;
  knowledge?: string;
}

/**
 * `buildWorkbuddyInjectionBlock` 入参：raw / structured 二选一。
 * 传 `{raw}` → raw 模式，原样嵌入；否则视为structured，按 5 段拆分渲染。
 */
export type WorkbuddyInjectionInput =
  | WorkbuddyInjectionInputRaw
  | WorkbuddyInjectionInputStructured;

/**
 * 构建 `<tdai_injections>` wrapper，返回可直接 push 到 WorkBuddy
 * `body.input[0].content` 数组的 input_text 对象。
 *
 * - raw 模式：`{raw: "..."}` → 原样嵌入 wrapper 内层，不 escape 不加子 tag
 * - structured 模式：`{skills, memory, ...}` → 每段用对应 tag 包裹 + XML escape，
 *   空段（空字符串 / undefined）省略
 * - 无内容时仍返回空 wrapper `<tdai_injections>\n</tdai_injections>`
 */
export function buildWorkbuddyInjectionBlock(
  input: WorkbuddyInjectionInput,
): { type: "input_text"; text: string } {
  // Raw 模式：直接嵌入，不做任何处理
  if (isRawInput(input)) {
    const raw = input.raw ?? "";
    const inner = raw.length > 0 ? "\n" + raw + "\n" : "\n";
    return { type: "input_text", text: `<tdai_injections>${inner}</tdai_injections>` };
  }

  // Structured 模式：5 段拆分 + XML escape 内容
  const parts: string[] = [];
  for (const seg of SEGMENTS) {
    const raw = input[seg.field];
    if (!raw) continue;
    parts.push(`<${seg.tag}>\n${xmlEscape(raw)}\n</${seg.tag}>`);
  }
  const inner = parts.length > 0 ? "\n" + parts.join("\n\n") + "\n" : "\n";
  return { type: "input_text", text: `<tdai_injections>${inner}</tdai_injections>` };
}

function isRawInput(input: WorkbuddyInjectionInput): input is WorkbuddyInjectionInputRaw {
  return typeof (input as WorkbuddyInjectionInputRaw).raw === "string";
}
