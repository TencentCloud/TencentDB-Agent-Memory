/**
 * mem-command 内部工具函数。
 *
 * 目前只有 extractSimpleMessages —— 把 handler 层的 body.messages（协议原生形态）
 * 归一到 task-draft-generator 消费的 { role, content } 极简格式。
 *
 * 已支持三种协议形态（对同一个函数入参兼容）：
 *   - OpenAI (CC/CB):        body.messages = [{ role, content: string }]
 *   - Anthropic (CC 原生):    body.messages = [{ role, content: string | Array<{type:"text",text}|...> }]
 *   - Responses (Codex/WB):  body.input    = [{ type:"message", role,
 *                              content: [{type:"input_text"|"output_text", text}] }, ...]
 *
 * Responses API 与前两者主要差别：
 *   1. content block 用 `type:"input_text"` / `type:"output_text"` 而非 `type:"text"`
 *   2. 每条 message 外层多一个 `type:"message"` 包裹
 *   3. input[] 里还夹杂 function_call / function_call_output 等非 message 项 —— 只取 message
 *
 * 该函数对三种形态都自动识别，调用侧不用区分。
 */

import type { MemCommandMessage } from "./types.js";

/**
 * 从 content 数组抽取纯文本。
 * 支持三种 block 类型：
 *   - {type:"text", text}         (Anthropic)
 *   - {type:"input_text", text}   (Responses API 用户/系统消息)
 *   - {type:"output_text", text}  (Responses API 助手消息)
 * 未知类型的 block 忽略（e.g. tool_use / function_call / image ...）。
 */
function joinContentBlocks(content: unknown[]): string {
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;
    if ((t === "text" || t === "input_text" || t === "output_text") && typeof b.text === "string") {
      texts.push(b.text);
    }
  }
  return texts.join("\n");
}

/**
 * 从任意 messages 数组抽取 { role, content } 极简形态。
 *
 * 容错策略：
 * - 非数组 / 空 → 返 []
 * - role 不在 ["user","assistant","system"] → 忽略该条
 * - Responses API 项若含 type 字段且非 "message"（如 "function_call" / "function_call_output"）→ 忽略
 * - content 是数组 → 合并所有 text/input_text/output_text 段（其余类型忽略）
 * - content 是空字符串 → 忽略该条
 */
/**
 * 把 mem 命令的 args 压成一行简短日志片段，便于 [mem-command] 打点排查。
 *
 * - 换行/连续空白 → 单空格
 * - 超过 max（默认 40）→ 尾部截断加 "..."
 * - 空/纯空白 → 返回空串（调用侧再决定是否拼进日志）
 *
 * 注意：这个只给日志用，绝对不能反向解析回原文；args 里可能带敏感/多行内容，
 * 展示前必须过它。
 */
export function truncateArgs(args: string | undefined | null, max = 40): string {
  if (!args) return "";
  const oneLine = String(args).replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "";
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "...";
}

export function extractSimpleMessages(input: unknown): MemCommandMessage[] {
  if (!Array.isArray(input)) return [];

  const out: MemCommandMessage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;

    // Responses API: 只保留 type=message，跳过 function_call / function_call_output 等
    // （OpenAI / Anthropic messages 里没有 type 字段，此判定不生效，兼容）
    if (typeof m.type === "string" && m.type !== "message") continue;

    const role = typeof m.role === "string" ? m.role : "";
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    let content = "";
    const c = m.content;
    if (typeof c === "string") {
      content = c;
    } else if (Array.isArray(c)) {
      content = joinContentBlocks(c);
    }

    content = content.trim();
    if (content.length === 0) continue;

    out.push({ role, content });
  }
  return out;
}
