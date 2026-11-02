/**
 * Subagent detection (MemoryProxy/docs/session-cos.md §2).
 *
 * Only requests carrying one of the per-agent markers below count as a
 * subagent; everything else is the main line. The decision looks at this one
 * request only (headers, system, messages), never at earlier requests.
 * Markers come from MemoryProxy/docs/subagent-requests.md.
 */

import { createHash } from "node:crypto";
import { firstHumanUserText, systemText, userMessageTexts } from "./messages.js";

export interface SubagentInfo {
  /** 父会话 id，作为 x-tdai-session-id */
  parentSessionId: string;
  /** 子 agent id；客户端不给时省略，由调用方用首条真人 user 消息的哈希补上 */
  subagentId?: string;
}

export interface SubagentRequest {
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: unknown;
  /** The main line's session id, for agents whose subagents share it. */
  sessionId: string;
}

/** 返回 null 表示主线请求 */
export type SubagentDetector = (req: SubagentRequest) => SubagentInfo | null;

const HASH_HEX_LENGTH = 16;
const UNKNOWN_SUBAGENT_ID = "unknown";

function header(req: SubagentRequest, name: string): string | undefined {
  const value = req.headers[name];
  return value ? value : undefined;
}

function messagesOf(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null) return [];
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.messages)) return b.messages;
  if (Array.isArray(b.input)) return b.input;
  return [];
}

const detectClaudeCode: SubagentDetector = (req) => {
  const agentId = header(req, "x-claude-code-agent-id");
  if (!agentId) return null;
  return {
    parentSessionId: header(req, "x-claude-code-session-id") ?? req.sessionId,
    subagentId: agentId,
  };
};

const detectCodeBuddy: SubagentDetector = (req) => {
  if (header(req, "x-agent-type")?.toLowerCase() !== "subagent") return null;
  return {
    parentSessionId: header(req, "x-parent-conversation-id") ?? req.sessionId,
    subagentId: header(req, "x-conversation-id"),
  };
};

const detectOpenCode: SubagentDetector = (req) => {
  const parent = header(req, "x-parent-session-id");
  if (!parent) return null;
  return { parentSessionId: parent, subagentId: header(req, "x-session-id") };
};

const DSH_SUBAGENT_MARKER = "You are a delegated subagent";

const detectDsh: SubagentDetector = (req) => {
  const hit = userMessageTexts(messagesOf(req.body)).some((t) => t.includes(DSH_SUBAGENT_MARKER));
  return hit ? { parentSessionId: req.sessionId } : null;
};

const HERMES_SUBAGENT_MARKER = "Platform: subagent";

const detectHermes: SubagentDetector = (req) =>
  systemText(req.body).includes(HERMES_SUBAGENT_MARKER) ? { parentSessionId: req.sessionId } : null;

const OPENCLAW_SUBAGENT_MARKER = "## Subagent Context";
const OPENCLAW_SESSION_RE = /Your session:\s*agent:[^\s:]+:subagent:([0-9A-Za-z-]+)/;

const detectOpenClaw: SubagentDetector = (req) => {
  const system = systemText(req.body);
  if (!system.includes(OPENCLAW_SUBAGENT_MARKER)) return null;
  return { parentSessionId: req.sessionId, subagentId: OPENCLAW_SESSION_RE.exec(system)?.[1] };
};

/** Codex subagent markers are not confirmed yet: every request is main line. */
const detectCodex: SubagentDetector = () => null;

const DETECTORS: Record<string, SubagentDetector> = {
  "claude-code": detectClaudeCode,
  codebuddy: detectCodeBuddy,
  workbuddy: detectCodeBuddy,
  opencode: detectOpenCode,
  dsh: detectDsh,
  hermes: detectHermes,
  openclaw: detectOpenClaw,
  codex: detectCodex,
};

/**
 * Hash of the first human user message. Every request of one line replays the
 * same opening, so this stays stable across the line and differs between
 * subagents with different task prompts.
 */
export function subagentIdFromMessages(messages: unknown[]): string | null {
  const text = firstHumanUserText(messages);
  if (text === null) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_HEX_LENGTH);
}

/**
 * Dispatch to the detector registered for `agent` (from the URL). Agents
 * without a detector are main line. A detected subagent always comes back with
 * `subagentId` set, falling back to the first-human-message hash of `req.body`,
 * so pass the client's body as received, before injection.
 */
export function detectSubagent(agent: string, req: SubagentRequest): Required<SubagentInfo> | null {
  const detector = DETECTORS[agent];
  const info = detector ? detector(req) : null;
  if (!info) return null;
  const subagentId = info.subagentId || subagentIdFromMessages(messagesOf(req.body)) || UNKNOWN_SUBAGENT_ID;
  return { parentSessionId: info.parentSessionId, subagentId };
}
