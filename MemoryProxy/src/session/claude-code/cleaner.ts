/**
 * Claude Code Session Init — LastUser text extractor.
 *
 * 曾经这个文件里有 `stripInitArtifacts` 用来在 session_init 完成后剥离
 * 假表单对话（避免 LLM 看到 form 交互）。**该功能已重新实现**，但语义更窄：
 * 只剥离 Proxy 自己生成的 session_init 假表单（tool_use + 对应 tool_result），
 * 用户的所有真实对话一律原样保留。
 *
 * 为什么必须剥离：实测上游模型（GLM 等）看到历史里的 AskUserQuestion
 * tool_use 会模仿着再生成一次 AskUserQuestion，但拿不到 Claude Code 的
 * input schema（options 传成字符串等），客户端校验失败后 UI 显示
 * "Invalid tool parameters"。表单交互是 Proxy 内部管线，模型不需要看到它；
 * 关联结果已由 `<session_context>`（systemAppend）注入，模型照常工作。
 *
 * 目前只剩一个 export: `getLastUserMessageText`，用于在 session_init
 * state machine 里读最后一条 user / tool 消息的文本以解析用户选择。
 */

import { containsFormTitle, isSessionInitToolCallId } from "./form.js";

interface RawMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
}

/** Normalize message content to an array of Anthropic blocks. */
function toBlocks(content: unknown): AnthropicBlock[] {
  if (Array.isArray(content)) return content as AnthropicBlock[];
  if (typeof content === "string" && content.length > 0) {
    return [{ type: "text", text: content }];
  }
  return [];
}

/**
 * Strip Proxy-generated session-init form artifacts from a conversation that
 * is about to be forwarded upstream:
 *   - assistant messages / blocks carrying a form `tool_use` (id starts with
 *     `toolu_cc_session_init_`), and
 *   - user messages / blocks carrying the matching `tool_result`.
 *
 * Keeps every real user/assistant message. After removal, adjacent same-role
 * messages are merged so the Anthropic role-alternation invariant holds.
 * Returns a new array; the input is never mutated.
 */
export function stripSessionInitFormArtifacts(messages: RawMessage[]): RawMessage[] {
  // 1. Collect form tool_use ids.
  const formIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of toBlocks(m.content)) {
      if (b.type === "tool_use" && typeof b.id === "string" && isSessionInitToolCallId(b.id)) {
        formIds.add(b.id);
      }
    }
  }
  if (formIds.size === 0) return messages;

  // 2. Drop form blocks; drop whole messages that become empty.
  const kept: RawMessage[] = [];
  for (const m of messages) {
    const blocks = toBlocks(m.content);
    if (m.role === "assistant") {
      const filtered = blocks.filter(
        (b) => !(b.type === "tool_use" && typeof b.id === "string" && formIds.has(b.id)),
      );
      if (filtered.length === blocks.length) { kept.push(m); continue; }
      if (filtered.length === 0) continue;
      kept.push({ ...m, content: filtered });
      continue;
    }
    if (m.role === "user") {
      const filtered = blocks.filter(
        (b) => !(b.type === "tool_result" && typeof b.tool_use_id === "string" && formIds.has(b.tool_use_id)),
      );
      if (filtered.length === blocks.length) { kept.push(m); continue; }
      if (filtered.length === 0) continue;
      kept.push({ ...m, content: filtered });
      continue;
    }
    kept.push(m);
  }

  // 3. Merge adjacent same-role messages (Anthropic requires alternation).
  const merged: RawMessage[] = [];
  for (const m of kept) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      merged[merged.length - 1] = { ...prev, content: mergeContent(prev.content, m.content) };
    } else {
      merged.push(m);
    }
  }
  return merged;
}

/** Concatenate two message contents (strings and/or block arrays). */
function mergeContent(a: unknown, b: unknown): unknown {
  const aBlocks = toBlocks(a);
  const bBlocks = toBlocks(b);
  if (aBlocks.length === 0 && typeof a === "string" && a.length === 0) return b;
  if (bBlocks.length === 0 && typeof b === "string" && b.length === 0) return a;
  const merged = [...aBlocks, ...bBlocks];
  if (typeof a === "string" && !Array.isArray(a)) {
    return typeof b === "string" && !Array.isArray(b) ? `${a}\n\n${b}` : merged;
  }
  return merged;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get text from last tool message containing Claude Code form answer data.
 *
 * 优先扫最近一条 role=tool 且含 form answer 关键词 (AskUserQuestion /
 * multi_question_result / 表单标题) 的消息 —— 这是 Claude Code 上报用户
 * 选择结果时的 tool_result 载体; fallback 到最近一条 user 消息。
 */
export function getLastUserMessageText(messages: RawMessage[]): string {
  // Priority: tool messages with real answer data (JSON)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      const text = getMessageText(messages[i]);
      if (text && (text.includes("AskUserQuestion") || text.includes("multi_question_result") || containsFormTitle(text))) {
        return text;
      }
    }
  }

  // Fallback: last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return getMessageText(messages[i]);
    }
  }
  return "";
}

function getMessageText(msg: RawMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as AnthropicBlock[]) {
      const type = raw.type;
      if (type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
        continue;
      }
      if (type === "tool_result") {
        const inner = raw.content;
        if (typeof inner === "string") {
          parts.push(inner);
        } else if (Array.isArray(inner)) {
          for (const c of inner as AnthropicBlock[]) {
            if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
          }
        }
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}
