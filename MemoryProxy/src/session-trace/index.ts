/**
 * Online session trace: record every LLM call of a conversation line to
 * MemoryCore `/v3/session/add` (MemoryProxy/docs/session-cos.md).
 *
 * Handlers integrate in three steps:
 *   1. `createSessionCallSeed` — right after the body is parsed, before any
 *      injection or session-init rewrite: classification and subagent
 *      detection read the client's body as received.
 *   2. `buildSessionCallContext` — just before forwarding: identity plus the
 *      body sent upstream. A retry replaces `request` with the retry body.
 *   3. `submitSessionCall` — once the reply is complete or the call failed:
 *      records it in the background, and indexes the stored object by
 *      instance and `started_at` in ClickHouse (`session_trace_index`).
 */

import type { ProxyConfig } from "../types.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { isLegacyProxyPath } from "../routes/whitelist.js";
import { trackWrite } from "../tdai/pending-writes.js";
import { writeSessionTraceIndexRow } from "../clickhouse.js";
import { log } from "../report/log.js";
import { buildCallBody, responseFromText, type SessionProtocol } from "./record.js";
import { detectSubagent, type SubagentInfo } from "./subagent.js";
import { SESSION_UPLOAD_MAX_QUEUED_BYTES, sessionUploadQueue } from "./upload-queue.js";
import type { SessionIdentity, SessionUploadTarget } from "./uploader.js";

export {
  AnthropicMessageAssembler,
  OpenAIChatAssembler,
  ResponsesAssembler,
  parseSseData,
  type ResponseAssembler,
} from "./assemble.js";
export { responseFromText, type SessionProtocol } from "./record.js";

/** `agent` of records from the legacy `/proxy/` entry, whose URL names no agent. */
const UNKNOWN_AGENT = "unknown";

export interface SessionCallSeed {
  protocol: SessionProtocol;
  /** The URL's agent segment; `unknown` on the legacy `/proxy/` entry. */
  agent: string;
  startedAt: string;
  mainSessionId: string;
  subagent: Required<SubagentInfo> | null;
}

/** What a handler hands its forward step so the context is built right before the fetch. */
export interface PendingSessionCall {
  seed: SessionCallSeed | null;
  sessionInfo?: Record<string, unknown> | null;
  authUserId?: string | null;
}

export interface SessionCallContext {
  seed: SessionCallSeed;
  target: SessionUploadTarget;
  identity: SessionIdentity;
  /** The body sent upstream for the reply being recorded. */
  request: Record<string, unknown>;
  /** The proxy's per-call trace ID: `traceId` in the logs, `metadata.requestId` on the Langfuse generation. */
  traceId?: string;
  /** Remote compression calls made while preparing `request`. */
  compressionObservations?: Record<string, unknown>[];
  /** Byte budget shared by all in-flight uploads (`tdai.sessionTrace.maxQueuedBytes`). */
  maxQueuedBytes: number;
}

export interface SessionCallOutcome {
  /** Upstream HTTP status; 0 when no response was received. */
  status: number;
  /** Non-stream response body, a reassembled stream, or the error body / message. */
  response: Record<string, unknown> | string;
  /** The model actually called (the retry model after a retry). */
  model: string;
  /** The upstream's `x-request-id` response header. */
  upstreamRequestId?: string;
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
export function createSessionCallSeed(
  config: ProxyConfig,
  args: {
    /** Agent used for classification; on the legacy entry this is the handler's fallback. */
    agent: string;
    path: string;
    protocol: SessionProtocol;
    /** Lower-cased header names. */
    headers: Record<string, string>;
    body: unknown;
    sessionId: string;
    startedAt: string;
  },
): SessionCallSeed | null {
  if (!isSessionTraceEnabled(config)) return null;
  try {
    const body = (typeof args.body === "object" && args.body !== null ? args.body : {}) as Record<string, unknown>;
    const kind = resolveAgentAdapter(args.agent).classifyRequest(body, args.path, args.headers);
    if (kind !== "main") return null;
    const legacy = isLegacyProxyPath(args.path);
    return {
      protocol: args.protocol,
      agent: legacy ? UNKNOWN_AGENT : args.agent,
      startedAt: args.startedAt,
      mainSessionId: args.sessionId,
      subagent: legacy
        ? null
        : detectSubagent(args.agent, { headers: args.headers, body, sessionId: args.sessionId }),
    };
  } catch (err) {
    log.warn("【P1】session-trace:seed_failed", { agent: args.agent, error: String(err) });
    return null;
  }
}

export interface SessionIdentityArgs {
  spaceId: string;
  /** Session-init binding; `team_id` / `user_id` are read when they are non-empty strings. */
  sessionInfo?: Record<string, unknown> | null;
  authUserId?: string | null;
}

function callIdentity(config: ProxyConfig, seed: SessionCallSeed, args: SessionIdentityArgs): SessionIdentity {
  const teamId = pickString(args.sessionInfo?.team_id);
  return {
    serviceId: args.spaceId || config.tdai.serviceId,
    userId: pickString(args.sessionInfo?.user_id) || args.authUserId || "unknown",
    sessionId: seed.subagent?.parentSessionId ?? seed.mainSessionId,
    ...(teamId ? { teamId } : {}),
  };
}

export function buildSessionCallContext(
  config: ProxyConfig,
  seed: SessionCallSeed | null | undefined,
  args: SessionIdentityArgs & {
    request: Record<string, unknown>;
    traceId?: string;
    compressionObservations?: Record<string, unknown>[];
  },
): SessionCallContext | null {
  if (!seed) return null;
  const maxQueuedBytes = config.tdai.sessionTrace?.maxQueuedBytes;
  return {
    seed,
    target: { endpoint: config.tdai.endpoint, apiKey: config.tdai.apiKey },
    identity: callIdentity(config, seed, args),
    request: args.request,
    ...(args.traceId ? { traceId: args.traceId } : {}),
    ...(args.compressionObservations?.length ? { compressionObservations: args.compressionObservations } : {}),
    maxQueuedBytes: typeof maxQueuedBytes === "number" && maxQueuedBytes > 0
      ? maxQueuedBytes
      : SESSION_UPLOAD_MAX_QUEUED_BYTES,
  };
}

/** Core's team segment when `x-tdai-team-id` is not sent (MemoryCore `UNASSIGNED_TEAM`). */
const UNASSIGNED_TEAM = "_unassigned";

/**
 * The directory this conversation line's records land in, in the same form as
 * the `object_key` Core returns (MemoryCore `buildSessionObjectKey`) and with a
 * trailing `/`. The object name inside it is chosen by Core. Undefined when the
 * request is not recorded.
 */
export function sessionTraceDir(
  config: ProxyConfig,
  seed: SessionCallSeed | null | undefined,
  args: SessionIdentityArgs,
): string | undefined {
  if (!seed) return undefined;
  const { teamId, userId, sessionId } = callIdentity(config, seed, args);
  const parts = ["sessions/online", teamId || UNASSIGNED_TEAM, userId, sessionId];
  if (seed.subagent) parts.push("subagents", seed.subagent.subagentId);
  return `${parts.join("/")}/`;
}

/**
 * Records a non-2xx reply that arrived on the streaming path, whose body is an
 * error document rather than SSE. Returns the branch of `body` the handler
 * keeps using; the other branch is read in the background.
 */
export function teeErrorBodyToSessionCall(
  ctx: SessionCallContext | null | undefined,
  body: ReadableStream<Uint8Array>,
  outcome: Omit<SessionCallOutcome, "response">,
): ReadableStream<Uint8Array> {
  if (!ctx) return body;
  const [recorded, passthrough] = body.tee();
  new Response(recorded).text()
    .then((text) => submitSessionCall(ctx, { ...outcome, response: responseFromText(text) }))
    .catch((err: unknown) => log.warn("【P1】session-trace:error_body_failed", { session: ctx.identity.sessionId, error: String(err) }));
  return passthrough;
}

/** Fire-and-forget; never throws. */
export function submitSessionCall(
  ctx: SessionCallContext | null | undefined,
  outcome: SessionCallOutcome,
): void {
  if (!ctx) return;
  try {
    const body = buildCallBody({
      agent: ctx.seed.agent,
      startedAt: ctx.seed.startedAt,
      endedAt: new Date().toISOString(),
      protocol: ctx.seed.protocol,
      model: outcome.model || "unknown",
      status: outcome.status,
      traceId: ctx.traceId,
      upstreamRequestId: outcome.upstreamRequestId,
      request: ctx.request,
      response: outcome.response,
      subagentId: ctx.seed.subagent?.subagentId,
      compressionObservations: ctx.compressionObservations,
    });
    const instanceId = ctx.identity.serviceId;
    trackWrite(
      sessionUploadQueue.submit(ctx.target, ctx.identity, body, ctx.maxQueuedBytes).then((result) => {
        if (result.outcome === "ok" && result.objectKey) {
          writeSessionTraceIndexRow({ instanceId, startedAt: body.started_at, objectKey: result.objectKey });
        }
      }),
    ).catch(() => { /* logged inside */ });
  } catch (err) {
    log.warn("【P1】session-trace:submit_failed", { session: ctx.identity.sessionId, error: String(err) });
  }
}
