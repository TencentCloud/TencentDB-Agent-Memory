/**
 * The `/v3/session/add` request body of one online LLM call
 * (MemoryCore/docs/cos-format.md, online call record).
 *
 * Every call is recorded as it happened: the body sent upstream and the reply
 * the upstream gave, nothing filtered or rewritten. Turns, user queries and
 * system prompts are left for downstream to derive.
 */

export type SessionProtocol = "openai" | "anthropic" | "responses";

export interface SessionCallBody {
  source: "online";
  agent: string;
  started_at: string;
  ended_at: string;
  protocol: SessionProtocol;
  model: string;
  /** Upstream HTTP status; 0 when no response was received. */
  status: number;
  trace_id?: string;
  upstream_request_id?: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | string;
  subagent?: string;
  /** One entry per remote compression call made while preparing `request`. */
  compression_observations?: Record<string, unknown>[];
}

export interface CallBodyInput {
  agent: string;
  startedAt: string;
  endedAt: string;
  protocol: SessionProtocol;
  model: string;
  status: number;
  traceId?: string;
  upstreamRequestId?: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | string;
  subagentId?: string;
  compressionObservations?: Record<string, unknown>[];
}

export function buildCallBody(input: CallBodyInput): SessionCallBody {
  const body: SessionCallBody = {
    source: "online",
    agent: input.agent,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    protocol: input.protocol,
    model: input.model,
    status: input.status,
    request: input.request,
    response: input.response,
  };
  if (input.traceId) body.trace_id = input.traceId;
  if (input.upstreamRequestId) body.upstream_request_id = input.upstreamRequestId;
  if (input.subagentId) body.subagent = input.subagentId;
  if (input.compressionObservations?.length) body.compression_observations = input.compressionObservations;
  return body;
}

/** An upstream body as stored: the parsed JSON object, or the raw text when it is not one. */
export function responseFromText(text: string): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON — keep the text
  }
  return text;
}
