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

interface TurnAccumulator {
  userText: string;
  trace: SkillMessage[];
}

function appendAssistant(trace: SkillMessage[], assistant: OpenCodeMessage, maxChars: number): string {
  const timestamp = timeOf(assistant.info);
  const textChunks: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    const text = boundText(buffer.join("\n\n"), maxChars);
    buffer = [];
    if (!text) return;
    trace.push({ role: "assistant", content: text, timestamp });
    textChunks.push(text);
  };
  for (const part of assistant.parts) {
    if (part.type === "text" && part.synthetic !== true && typeof part.text === "string") buffer.push(part.text);
    if (part.type === "tool") {
      flush();
      trace.push(...toolMessage(part, timestamp, maxChars));
    }
  }
  flush();
  return boundText(textChunks.join("\n\n"), maxChars);
}

export function completedTurns(
  sessionId: string,
  messages: OpenCodeMessage[],
  maxChars: number,
  maxSkillBytes: number,
): CapturedTurn[] {
  const turns: CapturedTurn[] = [];
  const usersById = new Map<string, TurnAccumulator>();
  let currentUser: TurnAccumulator | undefined;

  for (const message of messages) {
    if (message.info.role === "user") {
      const userText = textParts(message.parts, maxChars);
      currentUser = {
        userText,
        trace: userText ? [{ role: "user", content: userText, timestamp: timeOf(message.info) }] : [],
      };
      if (typeof message.info.id === "string") usersById.set(message.info.id, currentUser);
      continue;
    }
    if (message.info.role !== "assistant" || message.info.error) continue;

    const parentId = typeof message.info.parentID === "string" ? message.info.parentID : undefined;
    const user = (parentId ? usersById.get(parentId) : undefined) ?? currentUser;
    if (!user) continue;
    const finalText = appendAssistant(user.trace, message, maxChars);
    if (!terminalAssistant(message) || !user.userText || !finalText) continue;

    const sourceId = typeof message.info.id === "string" ? message.info.id : "";
    if (!sourceId) continue;
    turns.push({
      key: createHash("sha256").update(sessionId).update("\0").update(sourceId).digest("hex"),
      sessionId,
      sourceId,
      user: user.userText,
      assistant: finalText,
      capturedAtMs: timeOf(message.info),
      skillMessages: boundSkillTrace(user.trace, maxSkillBytes),
    });
  }
  return turns;
}

export function latestCompletedTurn(
  sessionId: string,
  messages: OpenCodeMessage[],
  maxChars: number,
  maxSkillBytes: number,
): CapturedTurn | null {
  return completedTurns(sessionId, messages, maxChars, maxSkillBytes).at(-1) ?? null;
}
