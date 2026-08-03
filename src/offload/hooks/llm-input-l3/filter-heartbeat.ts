/**
 * filter-heartbeat.ts — Heartbeat tool_use block detection and message filtering.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import type { PluginLogger } from "../../types.js";

function isHeartbeatToolUseBlock(block: any): boolean {
  if (block.type !== "tool_use" && block.type !== "toolCall") return false;
  try {
    const input = block.input ?? block.arguments;
    if (!input) return false;
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    return raw.includes("HEARTBEAT.md");
  } catch {
    return false;
  }
}

function getMessageContentLocal(msg: any): any {
  if (msg.type === "message") return msg.message?.content;
  return msg.content;
}

function getMessageRoleLocal(msg: any): string | undefined {
  if (msg.type === "message") return msg.message?.role;
  return msg.role;
}

function collectHeartbeatToolUseIds(msg: any): string[] {
  const role = getMessageRoleLocal(msg);
  if (role !== "assistant") return [];
  const content = getMessageContentLocal(msg);
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (isHeartbeatToolUseBlock(block) && block.id) ids.push(block.id);
  }
  return ids;
}

export function filterHeartbeatMessages(messages: any[], logger: PluginLogger | undefined): number {
  const heartbeatIds = new Set<string>();
  for (const msg of messages) {
    for (const id of collectHeartbeatToolUseIds(msg)) heartbeatIds.add(id);
  }
  if (heartbeatIds.size === 0) return 0;
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = getMessageRoleLocal(msg);
    if (role === "toolResult" || role === "tool") {
      const tcId = msg.toolCallId ?? msg.tool_call_id ?? msg.message?.toolCallId ?? msg.message?.tool_call_id;
      if (tcId && heartbeatIds.has(tcId)) { messages.splice(i, 1); removed++; continue; }
    }
    if (role === "assistant") {
      const content = getMessageContentLocal(msg);
      if (!Array.isArray(content)) continue;
      const beforeLen = content.length;
      for (let j = content.length - 1; j >= 0; j--) {
        if (isHeartbeatToolUseBlock(content[j])) content.splice(j, 1);
      }
      if (content.length < beforeLen) {
        removed++;
        if (content.length === 0) messages.splice(i, 1);
      }
    }
  }
  return removed;
}
