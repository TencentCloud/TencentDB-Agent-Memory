/**
 * overflow-detect.ts — Token overflow error detection and message dump helper.
 * Extracted from llm-input-l3.ts (Group D decomposition).
 */
import type { PluginLogger } from "../../types.js";

export function isTokenOverflowError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("context_length") || msg.includes("context length") ||
    (msg.includes("token") && (msg.includes("exceed") || msg.includes("limit") || msg.includes("overflow") || msg.includes("too long"))) ||
    msg.includes("prompt is too long") || msg.includes("max_tokens") ||
    msg.includes("request too large") || msg.includes("compaction") ||
    msg.includes("prompt_too_long") || msg.includes("string_above_max_length")
  );
}

// Maximum content length (chars) to keep when truncating an oversized message in-place.
// ~2K chars ≈ ~500 tokens — enough to preserve tool_call_id and a snippet of context.
export const EMERGENCY_TRUNCATE_MAX_CHARS = 2000;

export function dumpMessagesSnapshot(label: string, messages: any[], logger: PluginLogger): void {
  const summary: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role ?? msg.message?.role ?? msg.type ?? "?";
    const flags: string[] = [];
    if (msg._mmdContextMessage) flags.push(`mmdCtx=${msg._mmdContextMessage}`);
    if (msg._mmdInjection) flags.push("mmdInj");
    if (msg._offloaded) flags.push("offloaded");
    const content = msg.content ?? msg.message?.content;
    let preview: string;
    if (typeof content === "string") {
      preview = content.slice(0, 120);
    } else if (Array.isArray(content)) {
      const texts = content
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text.slice(0, 80));
      const toolUses = content
        .filter((c: any) => c.type === "tool_use" || c.type === "toolCall")
        .map((c: any) => `tool_use:${c.name ?? c.id ?? "?"}`);
      const toolResults = content
        .filter((c: any) => c.type === "tool_result")
        .map((c: any) => `tool_result:${c.tool_use_id ?? "?"}`);
      preview = [...texts, ...toolUses, ...toolResults].join(" | ").slice(0, 120);
    } else {
      preview = String(content ?? "").slice(0, 80);
    }
    const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
    summary.push(`  [${i}] ${role}${flagStr}: ${preview}`);
  }
  logger.debug?.(
    `[context-offload] MSG-DUMP(${label}) count=${messages.length}\n${summary.join("\n")}`,
  );
}
