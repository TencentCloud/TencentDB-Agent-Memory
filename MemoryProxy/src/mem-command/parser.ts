/**
 * mem: command parser
 *
 * 从 request body.messages 中检测最后一条 user message 是否为 mem: 命令。
 *
 * 判定规则：
 * 1. 取 messages 数组最后一条 role="user" 的消息
 * 2. 通过 agentAdapter.extractUserText 按客户端规则提取用户真实输入：
 *    - claude-code: 取最后一个 text block（跳过 <system-reminder> 前缀元数据）
 *    - codebuddy / unknown: 走保守的"拼接所有 text"（待抓包适配）
 * 3. trim 后以 "mem:" 开头（大小写不敏感）
 * 4. 整条消息就是命令（不是嵌在其他文字中间）
 */

import { resolveAgentAdapter } from "../agent-adapters/index.js";

/**
 * content 里是否含工具回执块：Anthropic 的 `tool_result`（`role:"user"` + content 数组）
 * 与 Responses 的 `function_call_output`。这类消息没有用户键入的文本，
 * 与 pre-intercept.ts::hasToolResult 同一口径。
 */
function hasToolResultBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as Record<string, unknown> | null | undefined;
    return (
      !!b &&
      typeof b === "object" &&
      (b.type === "tool_result" || b.type === "function_call_output")
    );
  });
}

export interface ParsedMemCommand {
  /** 命令名（小写），如 "sync"、"create-skill"、"help" */
  command: string;
  /** 命令后的参数文本（如 create-skill 的提示词） */
  args: string;
  /** 原始 user 消息（审计 / L0 写入用） */
  rawMessage: string;
}

/**
 * 已知 mem 命令的 args 约束表。
 * - `false`：命令**严格匹配** —— 命令后不能跟任何非空白内容（如 `mem:help 你好` 视为
 *   普通对话，透传上游 LLM 而非拦截）。
 * - `true` ：命令**接受可选 args** —— `mem:create-skill 数据库迁移总结` 命中且携带
 *   args；`mem:create-skill`（无 args）也命中。
 *
 * 未列表的命令（用户 typo 如 `mem:helpp` / `mem:foo`）不受此校验影响 —— parser
 * 仍返回 ParsedMemCommand，交给 `executeMemCommand` 走"未知命令"分支反馈
 * `❌ 未知命令 mem:xxx，输入 mem:help 查看`，给用户 typo 兜底。
 */
const MEM_COMMANDS_ARGS: Record<string, boolean> = {
  help: false,
  sync: false,
  "create-skill": true,
  // task 命令族：args 语义与 create-skill 对齐 —— 作为 LLM 生成 title/description
  // 的额外提示（reason）；空 args 表示纯从近 30 条上下文自动生成。
  "create-task": true,
  "update-task": true,
  "session-reset": false,
};

/**
 * 从 request body 中检测是否为 mem: 命令。
 * 返回 null 表示非 mem: 命令，继续走正常链路。
 *
 * ⚠️ 只支持 body.messages[] 形态 (CC/CB)。Codex 走 body.input[]，
 * 调用方（codexHandler）应先用 `codexAdapter.extractUserText(input)` 拿
 * 到 text，再直接调 `parseCommandFromText(text)`（跳过 body 解析这一步）。
 *
 * @param body - 请求 body（含 messages 数组）
 * @param agentSource - 客户端类型（URL 前缀），用于选择 agentAdapter
 * @param options.checkFirst - 为 true 时检查第一条 user message 而非最后一条。
 *   用于 session init 刚完成的场景：最后一条是 init 交互回答，首条才是用户原始命令。
 */
export function parseMemCommand(
  body: Record<string, unknown>,
  agentSource: string,
  options?: { checkFirst?: boolean },
): ParsedMemCommand | null {
  const messages = (body as any)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // 取目标消息：默认最后一条，checkFirst 时取第一条 user message
  let targetMsg: any;
  if (options?.checkFirst) {
    targetMsg = messages.find((m: any) => m && m.role === "user");
  } else {
    // 真机上 CC 会在用户输入后面再挂一条 `role:"system"` 的提示（形如
    // `<total_tokens>… tokens left</total_tokens>`），取"最后一条"就会漏掉命令。
    // 这里从尾部往回找最近一条**带文本的 user 消息**（最多回看 6 条，
    // 避免把历史里很久以前的命令当成当前输入重放）。
    const adapterForPick = resolveAgentAdapter(agentSource);
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - 6; i--) {
      const m = messages[i];
      if (!m) continue;
      // OpenAI Chat 形态的工具回执（`role:"tool"` / 历史 `role:"function"`）表示本 turn 是
      // 工具或 Session Init 表单的续接，不是新的用户输入。继续回看会把历史里那条命令重放
      // 一次 —— 真机 Hermes：答复资产确认后 mem:session-reset 被连着重放，同一张表单连问三次。
      if (m.role === "tool" || m.role === "function") return null;
      if (m.role !== "user") continue;
      const probe = adapterForPick.extractUserText(m.content);
      if (typeof probe === "string" && probe.trim().length > 0) { targetMsg = m; break; }
      // Anthropic 形态的工具回执（`role:"user"` + content[{type:"tool_result"}]）同样表示
      // 本 turn 是工具 / Session Init 表单的续接：它没有 text block，extractUserText 返回
      // null，若继续回看就会命中历史里那条已经执行过的 `mem:` 命令并重放。
      // 真机：Claude Code 提交表单后 mem:session-reset 被重放，同一张表单反复弹出。
      if (hasToolResultBlock(m.content)) return null;
    }
    if (!targetMsg) targetMsg = messages[messages.length - 1];
  }
  if (!targetMsg || targetMsg.role !== "user") return null;
  const lastMsg = targetMsg;

  // 通过 adapter 按客户端规则提取纯文本
  const adapter = resolveAgentAdapter(agentSource);
  const text = adapter.extractUserText(lastMsg.content);
  if (text === null) return null;

  const direct = parseCommandFromText(text);
  if (direct) return direct;

  // 兜底：客户端会把用户输入与自己的元数据拆成多个 text 块，而 adapter 只取**最后一块**
  // （Claude Code 2.x 常把 `<system-reminder>` 追加在用户输入之后，于是最后一块反而是 reminder）。
  // 这种情况下逐块再试一次——只要某一块是合法 mem 命令就认，避免命令被静默当成普通提问。
  if (Array.isArray((lastMsg as { content?: unknown }).content)) {
    for (const block of (lastMsg as { content: unknown[] }).content) {
      const b = block as Record<string, unknown> | null | undefined;
      if (!b || typeof b !== "object") continue;
      if ((b.type !== "text" && b.type !== "input_text") || typeof b.text !== "string") continue;
      const parsed = parseCommandFromText(b.text);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * 从已提取的用户文本判定是否为 mem: 命令。
 *
 * 抽出这一层是为了让 codex handler 能复用同一套 mem 命令语义：
 * codex body 用 `input[]` 而非 `messages[]`，parseMemCommand 从 body
 * 起步的路径认不出 codex，早期直接返 null，导致所有 mem:xxx 静默透传给
 * LLM，模型编造"Memory synced"之类假回复（P0-1 QA 报告）。codex handler
 * 现在拿 `codexAdapter.extractUserText(input)` 得到 text 后直接调本函数。
 *
 * CC/CB 的 `parseMemCommand(body, agentSource)` 内部也走这条路径，行为
 * 完全不变。
 */
export function parseCommandFromText(text: string): ParsedMemCommand | null {
  // trim 后判断
  const trimmed = text.trim();

  // 客户端会把用户输入和自己的内容拼在一条消息里（Claude Code 2.x 追加
  // `<system-reminder>…`：可能是同一 content 数组的第二个 text 块，也可能在同一块里换行追加）。
  // 这种拼接会让下面"按整段文本取命令名"得到 `session-reset\n<system-reminder>…`，
  // 与 `session-reset` 不等，命令于是永远认不出来——真机表现是用户发了 mem:session-reset，
  // 会话仍停在 bypassed/pending，模型把它当普通提问回答。
  // 因此先按**首行**再判一次：命令写在第一行就认（同一行后面还有别的内容仍按原规则当普通对话，
  // 例如 `mem:help 你好` 不受影响）。
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  if (firstLine !== trimmed) {
    const byFirstLine = parseCommandFromText(firstLine);
    if (byFirstLine) return byFirstLine;
  }

  // 必须以 mem: 开头（大小写不敏感）
  if (!trimmed.toLowerCase().startsWith("mem:")) return null;

  // 提取命令部分（mem: 之后的内容）
  const afterPrefix = trimmed.slice(4); // 去掉 "mem:"

  // 兼容冒号后的可选空格
  const stripped = afterPrefix.trimStart();

  // 拆分命令名和参数（第一个空格分割）
  const spaceIdx = stripped.indexOf(" ");
  let command: string;
  let args: string;

  if (spaceIdx === -1) {
    command = stripped;
    args = "";
  } else {
    command = stripped.slice(0, spaceIdx);
    args = stripped.slice(spaceIdx + 1).trim();
  }

  command = command.toLowerCase();

  // 命令名不能为空
  if (!command) return null;

  // 已知命令的 args 严格校验：命令不接受 args 时，args 非空即视为普通对话。
  // 例：`mem:help 你好` → 用户"输入了 mem:help 并同时问了个问题"，应该走上游
  // LLM 正常回答，而非返回 help 帮助文本。未知命令不受此约束（见 MEM_COMMANDS_ARGS 说明）。
  if (MEM_COMMANDS_ARGS[command] === false && args.length > 0) {
    return null;
  }

  return { command, args, rawMessage: trimmed };
}
