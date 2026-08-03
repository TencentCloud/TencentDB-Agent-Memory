/**
 * engine-helpers.ts — Small helper functions used by the context engine
 * (assemble / compact / hook handlers). Extracted from index.ts
 * (Group D decomposition).
 */
import type { OffloadStateManager } from "./state-manager.js";

export function parseCreateSkillCommand(
  prompt: string,
): { mmdName: string | null; skillFocus: string | null } | null {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/create-skill(?:\s+(.*))?$/i);
  if (!match) return null;
  const args = (match[1] || "").trim();
  if (!args) return { mmdName: null, skillFocus: null };
  const parts = args.split(/\s+/);
  const mmdName = parts[0] || null;
  const skillFocus = parts.slice(1).join(" ") || null;
  return { mmdName, skillFocus };
}

export function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Compute a fingerprint for a message (role + first 200 chars of content). */
export function _msgFingerprint(msg: any): number {
  const role = msg.role ?? msg.message?.role ?? msg.type ?? "";
  let content = "";
  const raw = msg.type === "message" ? msg.message?.content : msg.content;
  if (typeof raw === "string") content = raw.slice(0, 200);
  else if (Array.isArray(raw)) content = JSON.stringify(raw).slice(0, 200);
  return simpleHash(`${role}:${content}`);
}

export function _extractLatestTurn(_messages: any[], currentPrompt: string | null): string | null {
  const effectivePrompt = _isHeartbeatText(currentPrompt ?? "") ? null : currentPrompt;
  if (!effectivePrompt) return null;
  return `[User]: ${String(effectivePrompt).slice(0, 500)}`;
}

export function _extractMsgText(msg: any): string {
  const content = msg.content ?? msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ");
  return "";
}

export function _normalizePromptForCompare(text: string | null): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Check if a message text looks like a heartbeat probe.
 * Matches both user heartbeat prompts and assistant HEARTBEAT_OK replies.
 */
export function _isHeartbeatText(text: string): boolean {
  return text.includes("HEARTBEAT") || text.includes("heartbeat");
}

export const INTERNAL_SESSION_RE = /memory-.*-session-\d+/;

export function isInternalMemorySession(sessionKey: string | null | undefined): boolean {
  return typeof sessionKey === "string" && INTERNAL_SESSION_RE.test(sessionKey);
}
