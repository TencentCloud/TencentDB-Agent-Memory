/**
 * Protocol-agnostic readers over a request body, shared by subagent detection
 * and turn-record building.
 *
 * Three request shapes reach the proxy:
 *   - openai     : `messages[]`, system / developer as messages
 *   - anthropic  : `messages[]`, system as the top-level `system` field
 *   - responses  : `input[]` (or a bare string), system as `instructions`
 *                  plus developer / system items inside `input`
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";

export type SessionProtocol = "openai" | "anthropic" | "responses";

const SYSTEM_ROLES = new Set(["system", "developer"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The message array of a request: `messages` for chat protocols, `input` for Responses. */
export function requestMessages(protocol: SessionProtocol, body: unknown): unknown[] {
  if (!isRecord(body)) return [];
  if (protocol === "responses") {
    const input = body.input;
    if (Array.isArray(input)) return input;
    if (typeof input === "string" && input.length > 0) return [{ role: "user", content: input }];
    return [];
  }
  return Array.isArray(body.messages) ? body.messages : [];
}

/** Drop `role: system` / `role: developer` entries, keeping the rest in order. */
export function stripSystemMessages(messages: unknown[]): unknown[] {
  return messages.filter((m) => !(isRecord(m) && typeof m.role === "string" && SYSTEM_ROLES.has(m.role)));
}

/** Plain text of a message `content`: the string itself, or its text / input_text blocks joined. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if ((block.type === "text" || block.type === "input_text") && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Raw text of every `role: user` message, in order. */
export function userMessageTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const m of messages) {
    if (isRecord(m) && m.role === "user") texts.push(contentText(m.content));
  }
  return texts;
}

/**
 * First user message that still has text after stripping harness wrappers.
 * Anthropic `tool_result` blocks and pure `<system-reminder>` messages yield
 * nothing and are skipped.
 */
export function firstHumanUserText(messages: unknown[]): string | null {
  for (const raw of userMessageTexts(messages)) {
    const text = extractUserQueryText(raw);
    if (text) return text;
  }
  return null;
}

/** All system-level text of a request, whichever of the three places it lives in. */
export function systemText(body: unknown): string {
  if (!isRecord(body)) return "";
  const parts: string[] = [];
  if (typeof body.system === "string") parts.push(body.system);
  else if (Array.isArray(body.system)) parts.push(contentText(body.system));
  if (typeof body.instructions === "string") parts.push(body.instructions);
  const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  for (const m of list) {
    if (isRecord(m) && typeof m.role === "string" && SYSTEM_ROLES.has(m.role)) {
      parts.push(contentText(m.content));
    }
  }
  return parts.join("\n");
}
