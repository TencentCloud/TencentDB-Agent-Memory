/**
 * Host-owned HTTP client for the shared judge service.
 *
 * CostGuard only needs enabled / cadence / latch fields. URL and timeouts
 * stay here so the published host does not leak extension routing types.
 */

import { randomUUID } from "node:crypto";

export interface JudgeServiceConfig {
  enabled: boolean;
  baseUrl: string;
  userTurnTimeoutMs: number;
  agentTurnTimeoutMs: number;
}

export interface AgentTurnJudgeRequest {
  sessionId: string;
  messages: unknown[];
  requestId?: string;
  /** Wire format of `messages`; the judge infers it when absent. */
  protocol?: "openai" | "anthropic";
  /** Model the client asked for, for the judge's decision log. */
  modelId?: string;
  turnSeq?: number;
  toolTurnCount?: number;
  /** Eval-harness run ids (X-Job-Id / X-Trial-Id), logged next to the decision. */
  jobId?: string;
  trialId?: string;
  /** `shadow` marks a decision that is logged but not written into the request. */
  effortPolicy?: string;
}

/** The seven-rung decision ladder; the proxy folds a rung onto each model's own. */
export const REASONING_EFFORT_RUNGS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffortRung = typeof REASONING_EFFORT_RUNGS[number];

export interface AgentTurnJudgeResponse {
  upgrade: boolean;
  turn_id: string;
  needs_stronger_model: number;
  stuck_type: string;
  n_agent_turns: number;
  evidence_turns: number[];
  blocker_category: string;
  reason: string;
  reasoning_effort?: ReasoningEffortRung;
}

export interface UserTurnJudgeRequest {
  sessionId: string;
  userQuery: string;
  requestId?: string;
  /** Observability only: lets the judge log which model the user turn went to. */
  turnSeq?: number;
  modelId?: string;
  protocol?: "openai" | "anthropic";
  jobId?: string;
  trialId?: string;
  effortPolicy?: string;
}

export interface UserTurnJudgeResult {
  upgrade: boolean;
  dsatScore?: number;
  reason?: string;
  requestId: string;
  latencyMs: number;
}

interface UserTurnJudgeResponse {
  upgrade: boolean;
  request_id: string;
  dsat_score: number;
  hit_dimensions: string[];
  scores: Record<string, unknown>;
  reason: string;
}

function judgeEndpoint(config: JudgeServiceConfig, kind: "user-turn" | "agent-turn"): string {
  return `${config.baseUrl.replace(/\/+$/, "")}/judge/${kind}`;
}

function isJudgeResponse(value: unknown): value is AgentTurnJudgeResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  const effort = response.reasoning_effort;
  const effortOk = effort === undefined
    || (REASONING_EFFORT_RUNGS as readonly unknown[]).includes(effort);
  return (
    typeof response.upgrade === "boolean"
    && typeof response.turn_id === "string"
    && typeof response.needs_stronger_model === "number"
    && Number.isFinite(response.needs_stronger_model)
    && typeof response.stuck_type === "string"
    && typeof response.n_agent_turns === "number"
    && Number.isFinite(response.n_agent_turns)
    && Array.isArray(response.evidence_turns)
    && response.evidence_turns.every((turn) => typeof turn === "number" && Number.isFinite(turn))
    && typeof response.blocker_category === "string"
    && typeof response.reason === "string"
    && effortOk
  );
}

function isUserJudgeResponse(value: unknown): value is UserTurnJudgeResponse {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).upgrade === "boolean";
}

/**
 * Read judge transport settings from the opaque costGuard.options.judge blob.
 * Returns null when judging is off or the service URL is missing.
 */
export function readJudgeTransport(options: Record<string, unknown>): JudgeServiceConfig | null {
  const raw = options.judge;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const judge = raw as Record<string, unknown>;
  if (judge.enabled !== true) return null;
  if (typeof judge.baseUrl !== "string" || judge.baseUrl.length === 0) return null;
  return {
    enabled: true,
    baseUrl: judge.baseUrl,
    userTurnTimeoutMs: typeof judge.userTurnTimeoutMs === "number" && judge.userTurnTimeoutMs > 0
      ? judge.userTurnTimeoutMs
      : 25_000,
    agentTurnTimeoutMs: typeof judge.agentTurnTimeoutMs === "number" && judge.agentTurnTimeoutMs > 0
      ? judge.agentTurnTimeoutMs
      : 10_000,
  };
}

export async function judgeAgentTurn(
  config: JudgeServiceConfig,
  request: AgentTurnJudgeRequest,
): Promise<AgentTurnJudgeResponse> {
  if (!config.enabled || !config.baseUrl) {
    throw new Error("judge service is disabled or has no base URL");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.agentTurnTimeoutMs);
  try {
    const response = await fetch(judgeEndpoint(config, "agent-turn"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": request.sessionId,
        "x-request-id": request.requestId ?? randomUUID(),
      },
      body: JSON.stringify({
        messages: request.messages,
        protocol: request.protocol,
        model: request.modelId,
        turn_seq: request.turnSeq,
        tool_turn_count: request.toolTurnCount,
        job_id: request.jobId,
        trial_id: request.trialId,
        effort_policy: request.effortPolicy,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`judge returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!isJudgeResponse(body)) {
      throw new Error("judge returned an invalid response");
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function judgeUserTurn(
  config: JudgeServiceConfig,
  request: UserTurnJudgeRequest,
): Promise<UserTurnJudgeResult> {
  if (!config.enabled || !config.baseUrl) {
    throw new Error("judge service is disabled or has no base URL");
  }

  const requestId = request.requestId ?? randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.userTurnTimeoutMs);
  const start = Date.now();
  try {
    const response = await fetch(judgeEndpoint(config, "user-turn"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": request.sessionId,
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        user_query: request.userQuery,
        turn_seq: request.turnSeq,
        model: request.modelId,
        protocol: request.protocol,
        job_id: request.jobId,
        trial_id: request.trialId,
        effort_policy: request.effortPolicy,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`user judge returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!isUserJudgeResponse(body)) {
      throw new Error("user judge returned an invalid response");
    }

    const dsatScore = typeof body.dsat_score === "number" && Number.isFinite(body.dsat_score)
      ? body.dsat_score
      : undefined;
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    return {
      upgrade: body.upgrade,
      dsatScore,
      reason,
      requestId,
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}
