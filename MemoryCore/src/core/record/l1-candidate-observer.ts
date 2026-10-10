import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { DedupDecision, ExtractedMemory } from "./l1-writer.js";
import type { Logger } from "../types.js";

type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
type Candidate = ExtractedMemory & { record_id: string };
export type ObservationPath = "dedup" | "dedup_fallback" | "dedup_disabled";
export type ObservationReason = "unchanged" | "insufficient_evidence" | "temporary" | "conflict";
export interface CandidateObservation {
  candidate_id: string;
  disposition: "baseline" | "defer" | "reject";
  reason: ObservationReason;
  /** An uncalibrated score; never write authorization. */
  confidence: number | null;
}
export interface CandidateObservationInput {
  path: ObservationPath;
  candidates: readonly Candidate[];
  decisions?: readonly DedupDecision[];
  sourceMessages: readonly ConversationMessage[];
}
export interface CandidateObservationSnapshot {
  readonly path: ObservationPath;
  readonly candidates: Frozen<Candidate[]>;
  /** Effective decisions, aligned with candidates; missing decisions default to store. */
  readonly decisions: Frozen<DedupDecision[]>;
  readonly sourceMessages: Frozen<ConversationMessage[]>;
  readonly writeAuthorized: false;
}
export type CandidateObserver = (
  snapshot: CandidateObservationSnapshot,
  signal: AbortSignal,
) => unknown | Promise<unknown>;
export interface CandidateObserverOptions {
  mode?: "off" | "shadow";
  observer?: CandidateObserver;
  /** Cooperative only; blocking synchronous JavaScript cannot be preempted. */
  timeoutMs?: number;
}
export const CANDIDATE_OBSERVER_LIMITS = Object.freeze({
  candidates: 32, messages: 64, decisions: 64, targets: 16, sourceReferences: 64,
  idCharacters: 256, stringBytes: 8192, payloadBytes: 65536, nodes: 4096,
  depth: 8, inFlight: 4, defaultTimeoutMs: 100, maxTimeoutMs: 1000,
});
type ResultReason = "off" | "observed" | "no_candidates" | "missing_observer" |
  "invalid_configuration" | "invalid_input" | "capacity" | "busy" |
  "observer_error" | "timeout" | "invalid_output";
export interface CandidateObservationResult {
  readonly reason: ResultReason;
  readonly baselinePreserved: true;
  readonly observations: Frozen<CandidateObservation[]>;
}
const EMPTY = Object.freeze([]);
const busy = new WeakSet<CandidateObserver>();
let inFlight = 0;
class InputError extends Error {
  constructor(readonly reason: "capacity" | "invalid_input") { super(reason); }
}
function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new InputError("invalid_input");
}
function cap(condition: unknown): asserts condition {
  if (!condition) throw new InputError("capacity");
}

/** Bound the two existing extraction windows before allocating a combined array. */
export function observationMessageWindow(
  background: readonly ConversationMessage[], recent: readonly ConversationMessage[],
): ConversationMessage[] {
  cap(background.length + recent.length <= CANDIDATE_OBSERVER_LIMITS.messages);
  return background.concat(recent);
}

/** Copy only JSON-like own data properties, rejecting getters, cycles and class instances. */
function copier() {
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  return function copy(value: unknown, depth = 0): unknown {
    cap(++nodes <= CANDIDATE_OBSERVER_LIMITS.nodes && depth <= CANDIDATE_OBSERVER_LIMITS.depth);
    if (typeof value === "string") {
      // Bound before encoding, so an oversized string does not allocate another large buffer.
      cap(value.length <= CANDIDATE_OBSERVER_LIMITS.stringBytes);
      const size = Buffer.byteLength(value, "utf8");
      cap(size <= CANDIDATE_OBSERVER_LIMITS.stringBytes);
      bytes += size;
      cap(bytes <= CANDIDATE_OBSERVER_LIMITS.payloadBytes);
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") { requireInput(Number.isFinite(value)); return value; }
    requireInput(typeof value === "object");
    const object = value as object;
    const array = Array.isArray(object);
    requireInput(array || Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null);
    requireInput(!active.has(object));
    active.add(object);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    // Do not materialize an unbounded keys array for a potentially large metadata object.
    let ownCount = 0;
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      cap(++ownCount <= CANDIDATE_OBSERVER_LIMITS.nodes);
      requireInput(key !== "__proto__" && key !== "prototype" && key !== "constructor");
      copy(key, depth + 1);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      requireInput(descriptor && "value" in descriptor && descriptor.enumerable);
      const cloned = copy(descriptor.value, depth + 1);
      Object.defineProperty(result, key, { value: cloned, enumerable: true });
    }
    if (array) requireInput(ownCount === (object as unknown[]).length);
    active.delete(object);
    return Object.freeze(result);
  };
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CANDIDATE_OBSERVER_LIMITS.idCharacters;
}
function snapshot(input: CandidateObservationInput): CandidateObservationSnapshot {
  requireInput(["dedup", "dedup_fallback", "dedup_disabled"].includes(input.path));
  requireInput(Array.isArray(input.candidates) && Array.isArray(input.sourceMessages));
  cap(input.candidates.length <= CANDIDATE_OBSERVER_LIMITS.candidates);
  cap(input.sourceMessages.length <= CANDIDATE_OBSERVER_LIMITS.messages);
  requireInput(input.decisions === undefined || Array.isArray(input.decisions));
  cap((input.decisions?.length ?? 0) <= CANDIDATE_OBSERVER_LIMITS.decisions);
  const copy = copier();
  const candidates = copy(input.candidates) as Frozen<Candidate[]>;
  const sourceMessages = copy(input.sourceMessages) as Frozen<ConversationMessage[]>;
  const rawDecisions = copy(input.decisions ?? []) as Frozen<DedupDecision[]>;
  const sourceIds = new Set<string>();
  for (const message of sourceMessages) {
    requireInput(id(message.id) && !sourceIds.has(message.id));
    requireInput(["user", "assistant"].includes(message.role) && typeof message.content === "string" && typeof message.timestamp === "number");
    sourceIds.add(message.id);
  }
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    requireInput(id(candidate.record_id) && !candidateIds.has(candidate.record_id));
    requireInput(typeof candidate.content === "string" && typeof candidate.scene_name === "string" && typeof candidate.priority === "number");
    requireInput(["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"].includes(candidate.type));
    requireInput(candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata));
    requireInput(Array.isArray(candidate.source_message_ids));
    cap(candidate.source_message_ids.length <= CANDIDATE_OBSERVER_LIMITS.sourceReferences);
    requireInput(candidate.source_message_ids.every((sourceId) => id(sourceId) && sourceIds.has(sourceId)));
    candidateIds.add(candidate.record_id);
  }
  const byId = new Map<string, Frozen<DedupDecision>>();
  for (const decision of rawDecisions) {
    requireInput(id(decision.record_id) && ["store", "update", "merge", "skip"].includes(decision.action));
    requireInput(Array.isArray(decision.target_ids));
    cap(decision.target_ids.length <= CANDIDATE_OBSERVER_LIMITS.targets);
    requireInput(decision.target_ids.every(id));
    byId.set(decision.record_id, decision);
  }
  const decisions = Object.freeze(candidates.map((candidate) => byId.get(candidate.record_id) ?? Object.freeze({
    record_id: candidate.record_id, action: "store" as const, target_ids: EMPTY,
  })));
  return Object.freeze({ path: input.path, candidates, decisions, sourceMessages, writeAuthorized: false });
}
function output(value: unknown, input: CandidateObservationSnapshot): Frozen<CandidateObservation[]> {
  requireInput(Array.isArray(value));
  requireInput(value.length === input.candidates.length);
  const copied = copier()(value) as unknown[];
  const remaining = new Set(input.candidates.map((candidate) => candidate.record_id));
  for (const item of copied) {
    requireInput(item && typeof item === "object" && !Array.isArray(item));
    const observation = item as CandidateObservation;
    requireInput(Object.keys(item).sort().join(",") === "candidate_id,confidence,disposition,reason");
    requireInput(remaining.delete(observation.candidate_id));
    requireInput(["baseline", "defer", "reject"].includes(observation.disposition));
    requireInput(["unchanged", "insufficient_evidence", "temporary", "conflict"].includes(observation.reason));
    requireInput(observation.confidence === null || (typeof observation.confidence === "number" && Number.isFinite(observation.confidence) && observation.confidence >= 0 && observation.confidence <= 1));
  }
  requireInput(remaining.size === 0);
  return copied as Frozen<CandidateObservation[]>;
}

// A still-pending callback closes over only its bounded detached snapshot, not
// the extraction input factory, original arrays, logger, or options object.
function startObserverTask(observer: CandidateObserver, captured: CandidateObservationSnapshot, signal: AbortSignal) {
  busy.add(observer);
  inFlight++;
  return Promise.resolve().then(() => observer(captured, signal)).then(
    (value) => ({ type: "value" as const, value }),
    () => ({ type: "error" as const }),
  ).finally(() => { busy.delete(observer); inFlight--; });
}

/** Pure shadow observation: the caller must always continue its original writer path. */
export async function observeExtractionCandidates(
  options: CandidateObserverOptions | undefined,
  createInput: () => CandidateObservationInput,
  logger?: Pick<Logger, "info" | "warn">,
): Promise<CandidateObservationResult> {
  // Deliberately do not inspect the lazy input, callback or logger in default-off mode.
  if (options?.mode === undefined || options.mode === "off") {
    return Object.freeze({ reason: "off", baselinePreserved: true, observations: EMPTY });
  }
  const started = performance.now();
  let captured: CandidateObservationSnapshot | undefined;
  const finish = (reason: ResultReason, observations: Frozen<CandidateObservation[]> = EMPTY): CandidateObservationResult => {
    const actions = { store: 0, update: 0, merge: 0, skip: 0 };
    for (const decision of captured?.decisions ?? []) actions[decision.action]++;
    const event = {
      schema: 1, event: "l1_candidate_observer", mode: "shadow", reason,
      baseline_preserved: true, write_authorized: false,
      path: captured?.path ?? null, candidates: captured?.candidates.length ?? null,
      actions, observations: observations.length,
      elapsed_ms: Math.min(2147483647, Math.max(0, Math.round(performance.now() - started))),
    };
    try {
      const line = JSON.stringify(event);
      if (reason === "observed" || reason === "no_candidates") logger?.info(line);
      else logger?.warn(line);
    } catch { /* Logging must not divert or replay the original writer. */ }
    return Object.freeze({ reason, baselinePreserved: true, observations });
  };
  const timeoutMs = options.timeoutMs ?? CANDIDATE_OBSERVER_LIMITS.defaultTimeoutMs;
  if (options.mode !== "shadow" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CANDIDATE_OBSERVER_LIMITS.maxTimeoutMs) return finish("invalid_configuration");
  const observer = options.observer;
  if (typeof observer !== "function") return finish("missing_observer");
  if (busy.has(observer) || inFlight >= CANDIDATE_OBSERVER_LIMITS.inFlight) return finish("busy");
  try { captured = snapshot(createInput()); }
  catch (error) { return finish(error instanceof InputError ? error.reason : "invalid_input"); }
  if (captured.candidates.length === 0) return finish("no_candidates");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Always handle late rejection and keep the slot occupied until genuine settlement.
  const task = startObserverTask(observer, captured, controller.signal);
  const deadline = new Promise<{ type: "timeout" }>((resolve) => {
    timer = setTimeout(() => { resolve({ type: "timeout" }); controller.abort(); }, timeoutMs);
  });
  const settled = await Promise.race([task, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  if (settled.type === "timeout") return finish("timeout");
  if (settled.type === "error") return finish("observer_error");
  try { return finish("observed", output(settled.value, captured)); }
  catch { return finish("invalid_output"); }
}
