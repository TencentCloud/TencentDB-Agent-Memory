import { createHash } from "node:crypto";

import { boundSkillTrace, boundText, safeJson, textParts } from "./sanitize.js";
import type { CapturedTurn, JsonRecord, OpenCodeMessage, SkillMessage } from "./types.js";

function timeOf(info: JsonRecord): number {
  const time = info.time;
  if (!time || typeof time !== "object") return Date.now();
  const value = (time as JsonRecord).completed ?? (time as JsonRecord).created;
  return typeof value === "number" ? value : Date.now();
}

function terminalAssistant(message: OpenCodeMessage): boolean {
  if (message.info.role !== "assistant" || message.info.error || message.info.summary === true) return false;
  const finish = message.info.finish ?? message.info.stopReason;
  if (["error", "aborted", "tool-calls", "tool_calls", "function_call"].includes(String(finish))) return false;
  const time = message.info.time;
  return !!time && typeof time === "object" && typeof (time as JsonRecord).completed === "number";
}

function toolMessage(part: JsonRecord, timestamp: number, maxChars: number): SkillMessage[] {
  if (part.type !== "tool" || typeof part.callID !== "string") return [];
  const state = part.state;
  if (!state || typeof state !== "object") return [];
  const data = state as JsonRecord;
  const status = String(data.status ?? "");
  if (!["completed", "error"].includes(status)) return [];
  const name = typeof part.tool === "string" ? part.tool : "unknown";
  const input = boundText(safeJson(data.input ?? {}), maxChars);
  const rawOutput = status === "completed" ? (data.output ?? data.metadata ?? "[empty tool result]") : (data.error ?? "[tool failed]");
  const output = boundText(typeof rawOutput === "string" ? rawOutput : safeJson(rawOutput), maxChars);
  return [
    { role: "tool_call", content: input || "{}", tool_name: name, tool_call_id: part.callID, timestamp },
    { role: "tool_result", content: output || "[empty tool result]", tool_name: name, tool_call_id: part.callID, timestamp },
  ];
}

function userFor(messages: OpenCodeMessage[], assistantIndex: number, parentId?: string): OpenCodeMessage | undefined {
  if (parentId) {
    const exact = messages.find((m) => m.info.role === "user" && m.info.id === parentId);
    if (exact) return exact;
  }
  for (let i = assistantIndex - 1; i >= 0; i -= 1) if (messages[i]?.info.role === "user") return messages[i];
  return undefined;
}

function assistantRun(messages: OpenCodeMessage[], userIndex: number, finalIndex: number): OpenCodeMessage[] {
  return messages.slice(userIndex + 1, finalIndex + 1).filter((m) => m.info.role === "assistant" && !m.info.error);
}

function completedTurnAt(
  sessionId: string,
  messages: OpenCodeMessage[],
  finalIndex: number,
  maxChars: number,
  maxSkillBytes: number,
): CapturedTurn | null {
  const final = messages[finalIndex];
  if (!final || !terminalAssistant(final)) return null;
  const sourceId = typeof final.info.id === "string" ? final.info.id : "";
  if (!sourceId) return null;
  const parentId = typeof final.info.parentID === "string" ? final.info.parentID : undefined;
  const user = userFor(messages, finalIndex, parentId);
  if (!user) return null;
  const userIndex = messages.indexOf(user);
  const userText = textParts(user.parts, maxChars);
  if (!userText) return null;

  const trace: SkillMessage[] = [{ role: "user", content: userText, timestamp: timeOf(user.info) }];
  const finalChunks: string[] = [];
  for (const assistant of assistantRun(messages, userIndex, finalIndex)) {
    const timestamp = timeOf(assistant.info);
    let buffer: string[] = [];
    const flush = (): void => {
      const text = boundText(buffer.join("\n\n"), maxChars);
      buffer = [];
      if (!text) return;
      trace.push({ role: "assistant", content: text, timestamp });
      if (assistant === final) finalChunks.push(text);
    };
    for (const part of assistant.parts) {
      if (part.type === "text" && part.synthetic !== true && typeof part.text === "string") buffer.push(part.text);
      if (part.type === "tool") {
        flush();
        trace.push(...toolMessage(part, timestamp, maxChars));
      }
    }
    flush();
  }
  const finalText = boundText(finalChunks.join("\n\n"), maxChars);
  if (!finalText) return null;
  const key = createHash("sha256").update(sessionId).update("\0").update(sourceId).digest("hex");
  return {
    key,
    sessionId,
    sourceId,
    user: userText,
    assistant: finalText,
    capturedAtMs: timeOf(final.info),
    skillMessages: boundSkillTrace(trace, maxSkillBytes),
  };
}

export function completedTurns(
  sessionId: string,
  messages: OpenCodeMessage[],
  maxChars: number,
  maxSkillBytes: number,
): CapturedTurn[] {
  return messages.flatMap((_, index) => {
    const turn = completedTurnAt(sessionId, messages, index, maxChars, maxSkillBytes);
    return turn ? [turn] : [];
  });
}

export function latestCompletedTurn(
  sessionId: string,
  messages: OpenCodeMessage[],
  maxChars: number,
  maxSkillBytes: number,
): CapturedTurn | null {
  return completedTurns(sessionId, messages, maxChars, maxSkillBytes).at(-1) ?? null;
}
