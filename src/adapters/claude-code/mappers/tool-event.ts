import { deriveClaudeCodeSessionKey } from "../session-key.js";
import type { ClaudeCodeHookInput, ClaudeCodeToolEvent } from "../types.js";

function compact(value: unknown, maxChars = 240): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function pickString(input: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function hasError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.error != null || obj.is_error === true || obj.status === "error";
}

export function mapPostToolUseInput(input: ClaudeCodeHookInput): ClaudeCodeToolEvent {
  const raw = input as Record<string, unknown>;
  const toolName = pickString(raw, ["tool_name", "toolName", "name"], "unknown");
  const toolUseId = pickString(raw, ["tool_use_id", "toolUseID", "id"], `${toolName}-${Date.now()}`);
  const rawResult = input.tool_response ?? raw.tool_output ?? raw.response ?? raw.result;
  const status = input.hook_event_name === "PostToolUseFailure" || hasError(rawResult) ? "error" : "success";
  const endedAt = new Date().toISOString();

  return {
    sessionKey: deriveClaudeCodeSessionKey({
      cwd: input.cwd,
      sessionId: input.session_id,
    }),
    sessionId: input.session_id,
    cwd: input.cwd,
    toolUseId,
    toolName,
    status,
    endedAt,
    durationMs: typeof input.duration_ms === "number" ? input.duration_ms : undefined,
    inputSummary: compact(input.tool_input),
    resultSummary: compact(rawResult),
    rawInput: input.tool_input,
    rawResult,
  };
}
