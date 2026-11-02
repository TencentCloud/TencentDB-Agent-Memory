import { createHash, randomUUID } from "node:crypto";
import type { MemoryTdaiConfig } from "../../config.js";
import { CheckpointManager, type CheckpointLockOptions } from "../../utils/checkpoint.js";
import type { PersistedSceneDiff, SceneFileSnapshot } from "../scene/scene-extractor.js";
import { parseSceneBlock } from "../scene/scene-format.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { stripSceneNavigation } from "../scene/scene-navigation.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { Logger } from "../types.js";
import { createDecisionProvider } from "../decision/registry.js";
import { DecisionProviderError, type ChoiceQuestion } from "../decision/types.js";
import { emitJevDiagnostic, type JevCorrelation } from "./jev-diagnostics.js";

export const JEV_PROMPT_VERSION = "l3-memory-change-v1";
export const JEV_STATE_LIMIT_CHARS = 32_000;
const QUESTION_ID = "memory_change";

export const JEV_INSTRUCTIONS = "Compare each changed scene's current durable conclusion against current_persona, then return exactly one label using strict priority. Classify conflict only if ANY scene invalidates, contradicts, or replaces a fact or principle that current_persona still asserts. Classify boundary_change only if ANY scene durably changes the applicability of a rule still present in current_persona. A newly stated restriction or expansion of an existing rule's scope is boundary_change, not new_rule. Classify new_rule only if ANY scene adds a separate durable persona-level rule that current_persona does not already contain and that is not merely an applicability change to an existing rule. Otherwise classify reinforcement when the scenes only support or restate what current_persona already says, and none when they add no durable persona-level information. Historical statements inside a scene are context, not active beliefs by themselves: if current_persona already contains the replacement conclusion, a scene that narrates the old-to-new history is reinforcement, not conflict. Never let reinforcing or irrelevant scenes outvote a genuine higher-priority change. Priority is conflict > boundary_change > new_rule > reinforcement > none.";

export const JEV_CRITERIA = {
  conflict: "A changed scene contradicts or replaces a belief still asserted in current_persona.",
  boundary_change: "A changed scene durably restricts or expands where a current_persona rule applies.",
  new_rule: "A changed scene adds a separate durable persona-level rule, not a scope change, absent from current_persona.",
  reinforcement: "The scenes support or restate current_persona, including already-synced old-to-new history.",
  none: "The scenes add no durable persona-level information.",
} as const;

export type JevChangeType = keyof typeof JEV_CRITERIA;
const IMMEDIATE = new Set<JevChangeType>(["conflict", "boundary_change", "new_rule"]);

interface SceneSummary {
  filename: string;
  sha256: string;
  chars: number;
  parseable: boolean;
  created: string;
  updated: string;
  heat: number;
}

export interface L2SceneDiffDiagnostic {
  before_files: string[];
  after_files: string[];
  created: SceneSummary[];
  updated: Array<{ before: SceneSummary; after: SceneSummary }>;
  deleted: SceneSummary[];
}

export interface L3JevExecutionContext {
  l2TaskId?: string;
  l3TaskId?: string;
  jevGateId?: string;
  sceneDiff?: L2SceneDiffDiagnostic;
  signal?: AbortSignal;
  teamId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
}

export interface JevGateResult {
  kind: "immediate" | "deferred" | "unavailable" | "not_applicable";
  shouldGenerate: boolean;
  label?: JevChangeType;
  reason: string;
  called: boolean;
  latencyMs: number;
  gateId: string;
}

interface ChangedScene {
  filename: string;
  summary: string;
  updated: string;
  full_content: string;
  sha256: string;
  chars: number;
  parseable: boolean;
}

interface SceneEligibility {
  filename: string;
  updated: string;
  parseable: boolean;
  selected: boolean;
  exclusion_reason: string | null;
}

interface JevCallObservation {
  status?: number;
  rawResponse?: unknown;
}

class JevGateAnswerError extends Error {
  constructor(readonly reason: "missing_answer" | "invalid_choice", message: string) {
    super(message);
    this.name = "JevGateAnswerError";
  }
}

export function summarizeSceneDiff(diff: PersistedSceneDiff): L2SceneDiffDiagnostic {
  return {
    before_files: diff.beforeFiles,
    after_files: diff.afterFiles,
    created: diff.created.map(summarizeSnapshot),
    updated: diff.updated.map(({ before, after }) => ({
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
    })),
    deleted: diff.deleted.map(summarizeSnapshot),
  };
}

export async function evaluateL3JevGate(opts: {
  dataDir: string;
  cfg: MemoryTdaiConfig;
  logger: Logger;
  instanceId?: string;
  storage?: StorageAdapter;
  checkpointLock?: CheckpointLockOptions;
  triggerReason: string;
  context?: L3JevExecutionContext;
  fetcher?: typeof fetch;
}): Promise<JevGateResult> {
  const startedAt = Date.now();
  const gateId = opts.context?.jevGateId ?? randomUUID();
  const mode = opts.cfg.persona.jev.diagnostics.mode;
  const correlation: JevCorrelation = {
    instance_id: opts.instanceId,
    team_id: opts.context?.teamId,
    user_id: opts.context?.userId,
    agent_id: opts.context?.agentId,
    session_id: opts.context?.sessionId,
    l2_task_id: opts.context?.l2TaskId,
    l3_task_id: opts.context?.l3TaskId,
    jev_gate_id: gateId,
    prompt_version: JEV_PROMPT_VERSION,
  };
  const finish = (result: Omit<JevGateResult, "latencyMs" | "gateId">): JevGateResult => ({
    ...result,
    latencyMs: Date.now() - startedAt,
    gateId,
  });
  const checkpoint = new CheckpointManager(
    opts.dataDir, opts.logger, opts.storage, opts.checkpointLock,
  );
  let cp: Awaited<ReturnType<CheckpointManager["read"]>>;
  let personaRaw: string | null;
  let loaded: Awaited<ReturnType<typeof loadChangedScenes>>;
  try {
    cp = await checkpoint.read();
    personaRaw = await readOptionalPersona(opts.dataDir, opts.storage);
    loaded = await loadChangedScenes(opts.dataDir, opts.storage, cp.last_persona_time);
  } catch (error) {
    const reason = "input_read_failed";
    emitDecision(opts, correlation, {
      label: "unavailable",
      action: "degraded",
      call_failure: reason,
      attempts: 0,
      latency_ms: Date.now() - startedAt,
      generator_entered: false,
    });
    emitInvariant(opts, correlation, false, false, true);
    return finish({
      kind: "unavailable",
      shouldGenerate: false,
      reason,
      called: false,
    });
  }
  const personaBody = stripSceneNavigation(personaRaw ?? "").trim();
  const changedScenes = loaded.changedScenes;
  const unreadableChangedScenes = loaded.eligibility
    .filter((scene) => scene.exclusion_reason === "scene_file_unreadable")
    .map((scene) => scene.filename);
  const inputIncomplete = unreadableChangedScenes.length > 0;
  const hasCandidateInput = personaBody.length > 0 && changedScenes.length > 0;
  const stateObject = {
    current_persona: personaBody,
    changed_scenes: changedScenes.map(({ filename, summary, updated, full_content }) => ({
      filename, summary, updated, content: full_content,
    })),
  };
  const state = JSON.stringify(stateObject);
  const inputTooLarge = state.length > JEV_STATE_LIMIT_CHARS;
  const callExpected = hasCandidateInput && !inputIncomplete && !inputTooLarge;
  const selectedNames = changedScenes.map((scene) => scene.filename);
  const l2Names = l2ChangedNames(opts.context?.sceneDiff);
  const missingFromJev = l2Names.filter((name) => !selectedNames.includes(name));
  const unexpectedInJev = selectedNames.filter((name) => !l2Names.includes(name));
  const matchesL2Diff = !opts.context?.sceneDiff ||
    (missingFromJev.length === 0 && unexpectedInJev.length === 0);

  emitJevDiagnostic(opts.logger, mode, "memory.l3_jev.eligibility", correlation, {
    trigger_mode: opts.cfg.persona.triggerMode,
    persona_trigger_should: false,
    persona_trigger_reason: opts.triggerReason,
    last_persona_time: cp.last_persona_time,
    scenes: loaded.eligibility,
    call_expected: callExpected,
    suppression_reason: !personaBody
      ? "missing_persona_body"
      : inputIncomplete
        ? "changed_scene_unreadable"
      : changedScenes.length === 0
        ? "no_changed_scenes"
        : inputTooLarge
          ? "input_too_large"
          : null,
  });

  if (personaBody && inputIncomplete) {
    emitDecision(opts, correlation, {
      label: "unavailable",
      action: "degraded",
      call_failure: "changed_scene_unreadable",
      unreadable_scenes: unreadableChangedScenes,
      attempts: 0,
      latency_ms: Date.now() - startedAt,
      generator_entered: false,
    });
    emitInvariant(opts, correlation, false, false, matchesL2Diff);
    return finish({
      kind: "unavailable",
      shouldGenerate: false,
      reason: "changed_scene_unreadable",
      called: false,
    });
  }

  if (!hasCandidateInput) {
    emitInvariant(opts, correlation, false, false, matchesL2Diff);
    return finish({
      kind: "not_applicable",
      shouldGenerate: false,
      reason: !personaBody ? "missing_persona_body" : "no_changed_scenes",
      called: false,
    });
  }

  emitJevDiagnostic(opts.logger, mode, "memory.l3_jev.input", correlation, {
    selected_scenes: changedScenes.map((scene) => ({
      filename: scene.filename,
      updated: scene.updated,
      sha256: scene.sha256,
      chars: scene.chars,
      parseable: scene.parseable,
    })),
    selected_scene_matches_l2_diff: matchesL2Diff,
    missing_from_jev: missingFromJev,
    unexpected_in_jev: unexpectedInJev,
    persona_sha256: sha256(personaBody),
    persona_chars: personaBody.length,
    state_sha256: sha256(state),
    state_chars: state.length,
    input_limit_chars: JEV_STATE_LIMIT_CHARS,
    truncated: false,
    ...(mode === "full" ? {
      current_persona: personaBody,
      changed_scenes: changedScenes,
      state,
    } : {}),
  });

  if (inputTooLarge) {
    opts.logger.warn(
      `[memory-tdai] [l3-jev] input too large (${state.length} > ${JEV_STATE_LIMIT_CHARS}); deferring L3`,
    );
    emitDecision(opts, correlation, {
      label: "unavailable",
      action: "degraded",
      call_failure: "input_too_large",
      attempts: 0,
      latency_ms: Date.now() - startedAt,
      generator_entered: false,
    });
    emitInvariant(opts, correlation, false, false, matchesL2Diff);
    return finish({
      kind: "unavailable",
      shouldGenerate: false,
      reason: "input_too_large",
      called: false,
    });
  }

  throwIfAborted(opts.context?.signal);
  const observation: JevCallObservation = {};
  const decisionCfg = opts.cfg.persona.jev;
  const client = createDecisionProvider(
    decisionCfg.provider || "jev",
    {
      endpoint: decisionCfg.endpoint,
      apiKey: decisionCfg.apiKey,
      model: decisionCfg.model,
      timeoutMs: decisionCfg.timeoutMs,
      options: decisionCfg.options,
    },
    { fetcher: observeJevFetch(opts.fetcher, observation, mode === "full") },
  );
  const question: ChoiceQuestion = {
    type: "choice",
    id: QUESTION_ID,
    instructions: JEV_INSTRUCTIONS,
    criteria: JEV_CRITERIA,
  };
  const attemptStarted = Date.now();
  const callStarted = true;
  try {
    const answers = await client.askChoices(state, [question]);
    throwIfAborted(opts.context?.signal);
    const answer = answers.get(QUESTION_ID);
    if (!answer?.choice) {
      throw new JevGateAnswerError("missing_answer", "response missing memory_change choice");
    }
    const label = answer.choice.trim();
    if (!isChangeType(label)) {
      throw new JevGateAnswerError("invalid_choice", `choice is outside the allowed labels: ${label}`);
    }
    emitJevDiagnostic(opts.logger, mode, "memory.l3_jev.attempt", correlation, {
      attempt: 1,
      request_started: true,
      started_at: new Date(attemptStarted).toISOString(),
      endpoint_host: endpointHost(opts.cfg.persona.jev.endpoint),
      model: client.model,
      provider: client.name,
      timeout_ms: opts.cfg.persona.jev.timeoutMs,
      http_status: observation.status,
      latency_ms: Date.now() - attemptStarted,
      retry: false,
      retry_reason: null,
      valid_choice: label,
      ...(mode === "full" ? {
        raw_response: redactKnownSecret(observation.rawResponse, opts.cfg.persona.jev.apiKey),
      } : {}),
    });
    const shouldGenerate = IMMEDIATE.has(label);
    emitDecision(opts, correlation, {
      label,
      action: shouldGenerate ? "immediate" : "defer",
      call_failure: null,
      attempts: 1,
      latency_ms: Date.now() - startedAt,
      generator_entered: shouldGenerate,
    });
    emitInvariant(opts, correlation, callExpected, callStarted, matchesL2Diff);
    return finish({
      kind: shouldGenerate ? "immediate" : "deferred",
      shouldGenerate,
      label,
      reason: "jev_decision",
      called: true,
    });
  } catch (error) {
    throwIfAborted(opts.context?.signal);
    const failureReason = classifyJevFailure(error, observation.status);
    emitJevDiagnostic(opts.logger, mode, "memory.l3_jev.attempt", correlation, {
      attempt: 1,
      request_started: true,
      started_at: new Date(attemptStarted).toISOString(),
      endpoint_host: endpointHost(opts.cfg.persona.jev.endpoint),
      model: client.model,
      provider: client.name,
      timeout_ms: opts.cfg.persona.jev.timeoutMs,
      http_status: observation.status,
      error: error instanceof Error ? error.message : String(error),
      latency_ms: Date.now() - attemptStarted,
      retry: false,
      retry_reason: null,
      valid_choice: null,
      ...(mode === "full" ? {
        raw_response: redactKnownSecret(observation.rawResponse, opts.cfg.persona.jev.apiKey),
      } : {}),
    }, "error");
    opts.logger.warn(
      `[memory-tdai] [l3-jev] unavailable reason=${failureReason}; ` +
      "deferring L3 without advancing persona checkpoint",
    );
    emitDecision(opts, correlation, {
      label: "unavailable",
      action: "degraded",
      call_failure: failureReason,
      attempts: 1,
      latency_ms: Date.now() - startedAt,
      generator_entered: false,
    });
    emitInvariant(opts, correlation, callExpected, callStarted, matchesL2Diff);
    return finish({
      kind: "unavailable",
      shouldGenerate: false,
      reason: failureReason,
      called: true,
    });
  }
}

async function loadChangedScenes(
  dataDir: string,
  storage: StorageAdapter | undefined,
  lastPersonaTime: string,
): Promise<{ changedScenes: ChangedScene[]; eligibility: SceneEligibility[] }> {
  const index = await readSceneIndex(dataDir, storage);
  const lastTime = Date.parse(lastPersonaTime);
  const allChanged = !lastPersonaTime;
  const eligibility = index.map((entry): SceneEligibility => {
    const sceneTime = Date.parse(entry.updated);
    const selected = allChanged || !Number.isFinite(lastTime) ||
      !Number.isFinite(sceneTime) || sceneTime > lastTime;
    return {
      filename: entry.filename,
      updated: entry.updated,
      parseable: Number.isFinite(sceneTime),
      selected,
      exclusion_reason: selected ? null : "not_newer_than_last_persona_time",
    };
  });
  const scenes: ChangedScene[] = [];
  for (const entry of [...index].sort((a, b) => a.filename.localeCompare(b.filename))) {
    const status = eligibility.find((candidate) => candidate.filename === entry.filename)!;
    if (!status.selected) continue;
    try {
      const raw = storage
        ? await storage.readFile(`${StoragePaths.sceneBlocksDir}${entry.filename}`)
        : await readLocalFile(dataDir, `scene_blocks/${entry.filename}`);
      if (!raw) {
        status.selected = false;
        status.exclusion_reason = "scene_file_unreadable";
        continue;
      }
      const parsed = parseSceneBlock(raw, entry.filename);
      status.parseable = parsed.meta.created.length > 0 || parsed.meta.updated.length > 0;
      scenes.push({
        filename: entry.filename,
        summary: entry.summary,
        updated: entry.updated,
        full_content: raw,
        sha256: sha256(raw),
        chars: raw.length,
        parseable: status.parseable,
      });
    } catch {
      status.selected = false;
      status.exclusion_reason = "scene_file_unreadable";
    }
  }
  return { changedScenes: scenes, eligibility };
}

function emitDecision(
  opts: Parameters<typeof evaluateL3JevGate>[0],
  correlation: JevCorrelation,
  fields: Record<string, unknown>,
): void {
  emitJevDiagnostic(
    opts.logger,
    opts.cfg.persona.jev.diagnostics.mode,
    "memory.l3_jev.decision",
    correlation,
    fields,
  );
}

function emitInvariant(
  opts: Parameters<typeof evaluateL3JevGate>[0],
  correlation: JevCorrelation,
  callExpected: boolean,
  callStarted: boolean,
  matchesL2Diff: boolean,
): void {
  const mismatch = callExpected !== callStarted;
  emitJevDiagnostic(
    opts.logger,
    opts.cfg.persona.jev.diagnostics.mode,
    "memory.l3_jev.invariant",
    correlation,
    {
      call_expected: callExpected,
      call_started: callStarted,
      call_mismatch: mismatch,
      selected_scene_matches_l2_diff: matchesL2Diff,
    },
    mismatch ? "error" : "info",
  );
}

function summarizeSnapshot(snapshot: SceneFileSnapshot): SceneSummary {
  const { filename, sha256: hash, chars, parseable, created, updated, heat } = snapshot;
  return { filename, sha256: hash, chars, parseable, created, updated, heat };
}

function l2ChangedNames(diff?: L2SceneDiffDiagnostic): string[] {
  if (!diff) return [];
  return [
    ...diff.created.map((scene) => scene.filename),
    ...diff.updated.map(({ after }) => after.filename),
  ].sort();
}

function isChangeType(value: string): value is JevChangeType {
  return Object.prototype.hasOwnProperty.call(JEV_CRITERIA, value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactKnownSecret(value: unknown, secret: string): unknown {
  if (!secret) return value;
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactKnownSecret(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactKnownSecret(item, secret)]),
    );
  }
  return value;
}

async function readLocalFile(dataDir: string, relative: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return fs.default.readFile(path.default.join(dataDir, relative), "utf-8");
}

async function readOptionalPersona(
  dataDir: string,
  storage?: StorageAdapter,
): Promise<string | null> {
  if (storage) return storage.readFile(StoragePaths.persona);
  try {
    return await readLocalFile(dataDir, "persona.md");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function observeJevFetch(
  fetcher: typeof fetch | undefined,
  observation: JevCallObservation,
  captureRawResponse: boolean,
): typeof fetch {
  const delegate = fetcher ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const response = await delegate(input, init);
    observation.status = response.status;
    if (captureRawResponse) {
      const rawText = await response.clone().text().catch(() => "");
      try {
        observation.rawResponse = JSON.parse(rawText);
      } catch {
        observation.rawResponse = rawText;
      }
    }
    return response;
  };
}

function classifyJevFailure(error: unknown, status?: number): string {
  if (error instanceof JevGateAnswerError) return error.reason;
  if (status !== undefined && (status < 200 || status >= 300)) return `http_${status}`;
  if (error instanceof DecisionProviderError) {
    return error.reason === "http_error" && error.status !== undefined ? `http_${error.status}` : error.reason;
  }
  // 兜底：第三方 provider 未使用 DecisionProviderError 时按消息粗分类。
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("non-JSON")) return "non_json";
  if (message.includes("missing `answers`") || message.includes("unexpected response shape")) {
    return "invalid_response";
  }
  if (message.includes("fetch failed")) return "fetch_failed";
  if (message.includes("not configured") || message.includes("invalid endpoint") || message.includes("must be https")) {
    return "invalid_config";
  }
  return "jev_error";
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("L3 task aborted");
}
