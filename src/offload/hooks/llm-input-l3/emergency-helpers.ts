/**
 * emergency-helpers.ts — Small content-manipulation helpers used by
 * emergency-truncate.ts.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import type { PluginLogger } from "../../types.js";

/**
 * Truncate an assistant message with tool_use blocks while preserving
 * tool_use structure (type, id, name) to maintain tool pairing.
 * Replaces text blocks with a stub and tool_use input with a compact marker.
 */
export function _truncateAssistantToolUseContent(msg: any, originalTokens: number, logger: PluginLogger): void {
  const content = msg.content ?? msg.message?.content;
  if (!Array.isArray(content)) {
    _setMessageContent(msg, `[Assistant tool_use message truncated for context management. Original ~${originalTokens} tokens. Tool call arguments removed.]`);
    return;
  }
  content.unshift({
    type: "text",
    text: `[Assistant message truncated for context management. Original ~${originalTokens} tokens. Tool call arguments below replaced with stubs.]`,
  });
  for (let i = 1; i < content.length; i++) {
    const block = content[i] as any;
    if (block.type === "tool_use" || block.type === "toolCall") {
      if (block.input !== undefined) {
        block.input = { _truncated: true, _original_tokens: originalTokens };
      }
      if (block.arguments !== undefined) {
        block.arguments = { _truncated: true, _original_tokens: originalTokens };
      }
    } else if (block.type === "text") {
      block.text = typeof block.text === "string"
        ? block.text.slice(0, 200) + (block.text.length > 200 ? "…[truncated]" : "")
        : "[truncated]";
    }
  }
}

/** Set message content (handles both direct and transcript wrapper format) */
export function _setMessageContent(msg: any, text: string): void {
  if (msg.type === "message" && msg.message) {
    if (Array.isArray(msg.message.content)) {
      msg.message.content = [{ type: "text", text }];
    } else {
      msg.message.content = text;
    }
  } else {
    if (Array.isArray(msg.content)) {
      msg.content = [{ type: "text", text }];
    } else {
      msg.content = text;
    }
  }
}

/**
 * Strip large non-essential fields from a message after content truncation.
 * OpenClaw tool result messages may store the raw output in fields like
 * `output`, `result`, `data`, `rawContent`, `response`, etc. that are
 * outside of `content` but still get serialized and counted as tokens.
 */
export function _stripLargeFields(msg: any): void {
  const PRESERVE_KEYS = new Set([
    "role", "type", "name", "id", "toolCallId", "tool_call_id",
    "content", "message", "status",
    "_offloaded", "_mmdContextMessage", "_mmdInjection", "_contextOffloadProcessed",
    "_cachedTokens", "_tokenCount",
  ]);
  const LARGE_THRESHOLD = 500;

  const stripObj = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      if (PRESERVE_KEYS.has(key)) continue;
      const val = obj[key];
      if (val === null || val === undefined) continue;
      const serialized = typeof val === "string" ? val : JSON.stringify(val);
      if (serialized && serialized.length > LARGE_THRESHOLD) {
        delete obj[key];
      }
    }
  };

  stripObj(msg);
  if (msg.type === "message" && msg.message && typeof msg.message === "object") {
    stripObj(msg.message);
  }
}
