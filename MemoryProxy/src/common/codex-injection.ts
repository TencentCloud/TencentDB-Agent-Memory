/**
 * Codex 资产注入 —— `<tdai_injections>` wrapper 生成器。
 *
 * 在 codex body.input[0]（developer message）的 content[] 末尾追加一段
 * `{type:"input_text", text:"<tdai_injections>...\n</tdai_injections>"}` 文本块。
 *
 * 两种模式：
 *   - **raw**（当前 codex handler 走的路径）：pipeline 已经产出的**完整成品文本**
 *     （含 `<available_skills>` / `<user_memory>` / `<tdai_profile_memory>` /
 *     `<memory-tools-guide>` 等多组内部 XML tag）原样嵌进 wrapper 内层，不再做
 *     escape 或额外 tag 包裹，与 CC / CB 客户端在 system message 里看到的内容
 *     **字节一致**——模型学到的语义完全一样，不需要"codex 专属提示词"。
 *
 *   - **structured**（`{skills, memory, ...}` 5 段拆分）：预留给未来 codex 专属
 *     渲染器（要真按段拆开时启用，比如 UI 层想按段分渲染）。**当前 pipeline
 *     产出是单一 text 串，无法拆回 5 段，所以此模式不能给主链路用**——错用了
 *     会把 pipeline 完整输出塞进 `<available_skills>` 一个 tag、且内部所有
 *     `<...>` 被 XML escape 成 `&lt;...&gt;`，模型看不懂。历史踩坑记在 P0 fix
 *     commit body 里。
 *
 * 为什么用 wrapper 而不是把 pipeline 输出直接 append 一个 raw text：
 *   - 出问题 `grep '<tdai_injections>'` 一步能定位到本 handler 注入的段
 *   - 客户端下一轮 replay 时压缩上下文更方便
 *   - 后续 P2/P3 若想在 wrapper 内加 metadata 有落脚点
 *
 * 详见 docs/2026-08-07-codex-integration-plan.md §4。
 */

// ── XML escape ───────────────────────────────────────────────────────────────

/**
 * XML entity encode：转义 < > & " ' 五个 XML 特殊字符。
 * 仅 structured 模式使用；raw 模式（当前主链路）不 escape，因为传入的已经是
 * 合法 XML 结构，escape 会把 tag 全变成实体字符导致模型读不到 tag 语义。
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
const SEGMENTS: Array<{ tag: string; field: keyof CodexInjectionInputStructured }> = [
  { tag: "available_skills", field: "skills" },
  { tag: "user_memory", field: "memory" },
  { tag: "agents", field: "agents" },
  { tag: "tasks", field: "tasks" },
  { tag: "knowledge", field: "knowledge" },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Raw 模式输入：pipeline 已经产出的完整 XML 文本串（不做二次 escape / 包裹）。
 * 当前 codex handler 走这条路径，跟 CC / CB 的 system message 内容字节一致。
 */
export interface CodexInjectionInputRaw {
  raw: string;
}

/**
 * Structured 模式输入：5 段拆分（预留给未来 codex 专属渲染器）。
 * ⚠️ 不要给当前 pipeline 主链路使用——参见 module doc 里的说明。
 */
export interface CodexInjectionInputStructured {
  skills?: string;
  memory?: string;
  agents?: string;
  tasks?: string;
  knowledge?: string;
}

/**
 * `buildCodexInjectionBlock` 入参：raw / structured 二选一。
 * 传 `{raw}` → raw 模式，原样嵌入；否则视为 structured，按 5 段拆分渲染。
 */
export type CodexInjectionInput = CodexInjectionInputRaw | CodexInjectionInputStructured;

/**
 * 构建 `<tdai_injections>` wrapper，返回可直接 push 到 codex
 * `body.input[0].content` 数组的 input_text 对象。
 *
 * - raw 模式：`{raw: "..."}` → 原样嵌入 wrapper 内层，不 escape 不加子 tag
 * - structured 模式：`{skills, memory, ...}` → 每段用对应 tag 包裹 + XML escape，
 *   空段（空字符串 / undefined）省略
 * - 无内容时仍返回空 wrapper `<tdai_injections>\n</tdai_injections>`
 */
export function buildCodexInjectionBlock(
  input: CodexInjectionInput,
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

function isRawInput(input: CodexInjectionInput): input is CodexInjectionInputRaw {
  return typeof (input as CodexInjectionInputRaw).raw === "string";
}
