import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { report } from "../../core/report/reporter.js";
import {
  DIRECTION_A_PROTOCOL_VERSION,
  TRACE_VERSION,
  type DirectionATraceEvent,
} from "./protocol.js";

export interface EvaluationContext {
  runId: string;
  episodeId: string;
  taskId?: string;
  turnId?: string;
  /** Optional evaluation-only sink used by offline harnesses and tests. */
  sink?: (event: DirectionATraceEvent) => void;
  /** Evaluation-only paid-call gate. Never installed by production code. */
  beforeModelCall?: (call: EvaluationModelCall) => void | Promise<void>;
  /** Evaluation-only accounting hook. Prompts and credentials are deliberately absent. */
  afterModelCall?: (result: EvaluationModelCallResult) => void | Promise<void>;
  /** Evaluation-only retry policy. Production remains one attempt. */
  retry?: EvaluationRetryPolicy;
}

export interface EvaluationModelCall {
  taskId: string;
  model: string;
  inputCharacters: number;
  maxOutputTokens: number;
}

export interface EvaluationModelCallResult extends EvaluationModelCall {
  attempt: number;
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  errorClass?: string;
  retryable?: boolean;
  willRetry?: boolean;
}

export interface EvaluationRetryPolicy {
  maxAttempts: number;
  shouldRetry: (error: unknown) => boolean;
}

const evaluationContext = new AsyncLocalStorage<EvaluationContext>();

export function withEvaluationContext<T>(context: EvaluationContext, fn: () => T): T {
  if (!context.runId.trim() || !context.episodeId.trim()) {
    throw new Error("Direction A evaluation requires non-empty runId and episodeId");
  }
  return evaluationContext.run(Object.freeze({ ...context }), fn);
}

export function getEvaluationContext(): EvaluationContext | undefined {
  return evaluationContext.getStore();
}

export function requireEvaluationContext(): EvaluationContext {
  const context = getEvaluationContext();
  if (!context) throw new Error("Direction A evaluation context is required");
  return context;
}

/** Production-safe: a strict no-op when no evaluation context is active. */
export function emitEvaluationEvent<T extends Record<string, unknown>>(
  event: string,
  data: T,
): DirectionATraceEvent<T> | undefined {
  const context = getEvaluationContext();
  if (!context) return undefined;
  if (!event.startsWith("direction_a.")) {
    throw new Error(`Direction A event must use direction_a.* namespace: ${event}`);
  }

  const envelope: DirectionATraceEvent<T> = {
    protocolVersion: DIRECTION_A_PROTOCOL_VERSION,
    traceVersion: TRACE_VERSION,
    eventId: randomUUID(),
    event,
    timestamp: new Date().toISOString(),
    runId: context.runId,
    episodeId: context.episodeId,
    taskId: context.taskId,
    turnId: context.turnId,
    data,
  };
  // Evaluation observability is a sidecar. A broken in-memory sink or
  // reporting backend must never replace a production-visible return value or
  // exception. Formal integrity checks that are intentionally fail-closed are
  // performed explicitly by their callers after emitting the diagnostic.
  try {
    context.sink?.(envelope as DirectionATraceEvent);
  } catch {
    // Sidecar isolation is part of the production-equivalence contract.
  }
  try {
    report(event, envelope as unknown as Record<string, unknown>);
  } catch {
    // Reporter failures are non-fatal, matching the rest of production metrics.
  }
  return envelope;
}

export function createInMemoryTraceSink(): {
  events: DirectionATraceEvent[];
  sink: (event: DirectionATraceEvent) => void;
} {
  const events: DirectionATraceEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}
