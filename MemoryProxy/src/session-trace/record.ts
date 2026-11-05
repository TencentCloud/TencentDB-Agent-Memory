/**
 * Turn-end judgment and the `/v3/session/add` request body.
 *
 * Only the call that ends a turn is recorded (session-cos.md §1, §4): the
 * reply carries a stop signal and asks for no further tool calls. Judging on
 * "no tool call" rather than one specific value keeps truncated turns
 * (`length` / `max_tokens`) in. A reply without any stop signal is an
 * interrupted stream and is not recorded.
 */

import type { ModelReply } from "./assemble.js";
import type { SessionProtocol } from "./messages.js";
import { stripSystemMessages } from "./messages.js";

const TOOL_STOP_REASONS: Record<SessionProtocol, ReadonlySet<string>> = {
  openai: new Set(["tool_calls", "function_call"]),
  anthropic: new Set(["tool_use", "pause_turn"]),
  responses: new Set(),
};

const RESPONSES_TERMINAL_STATUSES = new Set(["completed", "incomplete"]);

export function isTurnEnd(protocol: SessionProtocol, reply: ModelReply): boolean {
  if (reply.stopReason === null || reply.toolCallCount > 0) return false;
  if (protocol === "responses") return RESPONSES_TERMINAL_STATUSES.has(reply.stopReason);
  return !TOOL_STOP_REASONS[protocol].has(reply.stopReason);
}

export interface SessionTurnBody {
  source: "online";
  started_at: string;
  ended_at: string;
  user_query: string;
  model: string;
  messages: unknown[];
  output: Record<string, unknown>;
  subagent?: string;
}

export interface TurnBodyInput {
  startedAt: string;
  endedAt: string;
  userQuery: string;
  model: string;
  /** The message array sent upstream, system messages included. */
  messages: unknown[];
  reply: ModelReply;
  subagentId?: string;
}

/** Returns null when nothing is left after dropping system / developer messages. */
export function buildTurnBody(input: TurnBodyInput): SessionTurnBody | null {
  const messages = stripSystemMessages(input.messages);
  if (messages.length === 0) return null;
  const body: SessionTurnBody = {
    source: "online",
    started_at: input.startedAt,
    ended_at: input.endedAt,
    user_query: input.userQuery,
    model: input.model,
    messages,
    output: input.reply.output,
  };
  if (input.subagentId) body.subagent = input.subagentId;
  return body;
}
