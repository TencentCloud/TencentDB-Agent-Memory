/**
 * Online session trace: record each turn's ending LLM call to MemoryCore
 * `/v3/session/add` (MemoryProxy/docs/session-cos.md).
 *
 * Handlers integrate in three steps:
 *   1. `createSessionTurnSeed` — right after the body is parsed, before any
 *      injection or session-init rewrite: classification, subagent detection
 *      and `user_query` all read the client's body as received.
 *   2. `buildSessionTurnContext` — just before forwarding: identity plus the
 *      message array actually sent upstream.
 *   3. `submitSessionTurn` — once the reply is complete: records it in the
 *      background if this call ended the turn.
 *
 * No state is kept across requests: `started_at` is the start of the ending
 * call itself, so turns with a tool loop start late.
 */

import type { ProxyConfig } from "../types.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { isLegacyProxyPath } from "../routes/whitelist.js";
import { extractLatestUserMessage } from "../tdai/recorder.js";
import { trackWrite } from "../tdai/pending-writes.js";
import { log } from "../report/log.js";
import type { ModelReply } from "./assemble.js";
import { requestMessages, type SessionProtocol } from "./messages.js";
import { buildTurnBody, isTurnEnd } from "./record.js";
import { detectSubagent, type SubagentInfo } from "./subagent.js";
import { SESSION_UPLOAD_MAX_QUEUED_BYTES, sessionUploadQueue } from "./upload-queue.js";
import type { SessionTurnIdentity, SessionUploadTarget } from "./uploader.js";

export type { ModelReply } from "./assemble.js";
export {
  AnthropicMessageAssembler,
  OpenAIChatAssembler,
  ResponsesAssembler,
  anthropicReplyFromJson,
  openaiReplyFromJson,
  parseSseData,
  responsesReplyFromJson,
} from "./assemble.js";
export type { SessionProtocol } from "./messages.js";

export interface SessionTurnSeed {
  protocol: SessionProtocol;
  startedAt: string;
  userQuery: string;
  mainSessionId: string;
  subagent: Required<SubagentInfo> | null;
}

/** What a handler hands its forward step so the context is built right before the fetch. */
export interface PendingSessionTurn {
  seed: SessionTurnSeed | null;
  sessionInfo?: Record<string, unknown> | null;
  authUserId?: string | null;
}

export interface SessionTurnContext {
  seed: SessionTurnSeed;
  target: SessionUploadTarget;
  identity: SessionTurnIdentity;
  /** The message array sent upstream, system messages included. */
  messages: unknown[];
  /** Byte budget shared by all in-flight uploads (`tdai.sessionTrace.maxQueuedBytes`). */
  maxQueuedBytes: number;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function isSessionTraceEnabled(config: ProxyConfig): boolean {
  return config.tdai?.enabled === true && !!config.tdai.endpoint;
}

/**
 * Returns null when the request is not recorded at all: the feature is off,
 * or the agent adapter does not classify it as `main` (fork / sidequery /
 * auxiliary are dropped). The agent-less legacy `/proxy/` entry is recorded
 * without subagent detection: every request goes to the main line.
 */
export function createSessionTurnSeed(
  config: ProxyConfig,
  args: {
    agent: string;
    path: string;
    protocol: SessionProtocol;
    /** Lower-cased header names. */
    headers: Record<string, string>;
    body: unknown;
    sessionId: string;
    startedAt: string;
  },
): SessionTurnSeed | null {
  if (!isSessionTraceEnabled(config)) return null;
  try {
    const body = (typeof args.body === "object" && args.body !== null ? args.body : {}) as Record<string, unknown>;
    const kind = resolveAgentAdapter(args.agent).classifyRequest(body, args.path, args.headers);
    if (kind !== "main") return null;
    return {
      protocol: args.protocol,
      startedAt: args.startedAt,
      userQuery: extractLatestUserMessage(requestMessages(args.protocol, body))?.content ?? "",
      mainSessionId: args.sessionId,
      subagent: isLegacyProxyPath(args.path)
        ? null
        : detectSubagent(args.agent, { headers: args.headers, body, sessionId: args.sessionId }),
    };
  } catch (err) {
    log.warn("session-trace:seed_failed", { agent: args.agent, error: String(err) });
    return null;
  }
}

export function buildSessionTurnContext(
  config: ProxyConfig,
  seed: SessionTurnSeed | null | undefined,
  args: {
    spaceId: string;
    /** Session-init binding; `team_id` / `user_id` are read when they are non-empty strings. */
    sessionInfo?: Record<string, unknown> | null;
    authUserId?: string | null;
    upstreamBody: unknown;
  },
): SessionTurnContext | null {
  if (!seed) return null;
  const teamId = pickString(args.sessionInfo?.team_id);
  const maxQueuedBytes = config.tdai.sessionTrace?.maxQueuedBytes;
  return {
    seed,
    target: { endpoint: config.tdai.endpoint, apiKey: config.tdai.apiKey },
    identity: {
      serviceId: args.spaceId || config.tdai.serviceId,
      userId: pickString(args.sessionInfo?.user_id) || args.authUserId || "unknown",
      sessionId: seed.subagent?.parentSessionId ?? seed.mainSessionId,
      ...(teamId ? { teamId } : {}),
    },
    messages: requestMessages(seed.protocol, args.upstreamBody),
    maxQueuedBytes: typeof maxQueuedBytes === "number" && maxQueuedBytes > 0
      ? maxQueuedBytes
      : SESSION_UPLOAD_MAX_QUEUED_BYTES,
  };
}

/** Fire-and-forget; never throws. */
export function submitSessionTurn(
  ctx: SessionTurnContext | null | undefined,
  reply: ModelReply | null | undefined,
  model: string,
): void {
  if (!ctx || !reply) return;
  try {
    if (!isTurnEnd(ctx.seed.protocol, reply)) {
      log.debug("session-trace:not_turn_end", {
        session: ctx.identity.sessionId,
        stop: reply.stopReason,
        tools: reply.toolCallCount,
      });
      return;
    }
    const body = buildTurnBody({
      startedAt: ctx.seed.startedAt,
      endedAt: new Date().toISOString(),
      userQuery: ctx.seed.userQuery,
      model: model || "unknown",
      messages: ctx.messages,
      reply,
      subagentId: ctx.seed.subagent?.subagentId,
    });
    if (!body) {
      log.debug("session-trace:no_messages", { session: ctx.identity.sessionId });
      return;
    }
    trackWrite(sessionUploadQueue.submit(ctx.target, ctx.identity, body, ctx.maxQueuedBytes)).catch(() => { /* logged inside */ });
  } catch (err) {
    log.warn("session-trace:submit_failed", { session: ctx.identity.sessionId, error: String(err) });
  }
}
