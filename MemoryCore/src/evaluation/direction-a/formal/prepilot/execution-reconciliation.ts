import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { hashCanonical, immutableCopy, sha256 } from "../core/canonical.js";
import { FROZEN_DESIGN_BINDING } from "../config/frozen-design.js";
import { AppendOnlyAttemptJournal } from "../acquisition/journal.js";
import { AppendOnlyBudgetSnapshotJournal } from "../acquisition/budget.js";
import { reconstructResumeState } from "../acquisition/resume.js";
import { CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT, CURRENT_FORMAL_EXECUTION_LEDGER, deriveCurrentFormalExecutionState, parseCurrentFormalExecutionEvents,
  type CurrentFormalExecutionStateAttestation } from "./execution-state-attestation.js";

export interface ReconciliationEvidence {
  path: string;
  kind: "EXECUTION_LEDGER" | "ATTEMPT_JOURNAL" | "BUDGET_JOURNAL" | "HARBOR_CONFIG" | "HARBOR_JOB_FILE" | "RAW_ARTIFACT" | "NORMAL_RESULT" | "NORMAL_INTEGRITY" | "PAIR_RESULT" | "PAIR_DECISION" | "GROUP_RESULT" | "COMPLETION_MARKER";
  bytes: number;
  sha256: string;
}

export interface CurrentFormalExecutionReconciliation {
  schemaVersion: "direction-a.current-formal.execution-reconciliation.v1";
  generatedAt: string;
  status: "RECONCILIATION_PASS" | "CURRENT_FORMAL_EXECUTION_STATE_AMBIGUOUS";
  protocolHash: string;
  executionLedgerEventCount: number;
  paidTrialStartedCount: number;
  paidTrialFinishedCount: number;
  realAgentCompletedCount: number;
  providerCallCount: number;
  actualCostCny: number;
  attemptJournalStartedCount: number;
  harborConfigCount: number;
  harborJobDirectoryCount: number;
  rawArtifactCount: number;
  normalResultCount: number;
  pairResultCount: number;
  groupResultCount: number;
  completionMarkerCount: number;
  technicalInvalidTrialIds: string[];
  unresolvedPaidTrialIds: string[];
  repairableBindings: string[];
  issues: string[];
  sourceEvidence: ReconciliationEvidence[];
  sourceEvidenceHash: string;
  contentHash: string;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function filesBelow(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const output: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function evidence(path: string, root: string, kind: ReconciliationEvidence["kind"]): Promise<ReconciliationEvidence> {
  const bytes = await readFile(path);
  return { path: relative(root, path).replaceAll("\\", "/"), kind, bytes: (await stat(path)).size, sha256: sha256(bytes) };
}

async function readHashedJson(path: string, issuePrefix: string, issues: string[]): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { contentHash, ...body } = value;
    if (typeof contentHash !== "string" || hashCanonical(body) !== contentHash) issues.push(`${issuePrefix}:CONTENT_HASH_INVALID`);
    return value;
  } catch {
    issues.push(`${issuePrefix}:JSON_INVALID`);
    return undefined;
  }
}

/**
 * Read-only, fail-closed reconciliation across every durable Initial-6 execution surface.
 * It never repairs a ledger and never starts Harbor/provider work.
 */
export async function reconcileCurrentFormalExecution(repoRoot: string, generatedAt = new Date().toISOString()): Promise<CurrentFormalExecutionReconciliation> {
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("CURRENT_FORMAL_RECONCILIATION_TIME_INVALID");
  const root = resolve(repoRoot);
  const runtime = join(root, CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT);
  const ledgerPath = join(root, CURRENT_FORMAL_EXECUTION_LEDGER);
  const sourceEvidence: ReconciliationEvidence[] = [];
  let ledgerText = "";
  if (await exists(ledgerPath)) { ledgerText = await readFile(ledgerPath, "utf8"); sourceEvidence.push(await evidence(ledgerPath, root, "EXECUTION_LEDGER")); }
  const events = parseCurrentFormalExecutionEvents(ledgerText);
  const issues: string[] = [];
  const repairableBindings: string[] = [];
  const starts = events.filter((row) => row.eventType === "PAID_TRIAL_STARTED");
  const finishes = events.filter((row) => row.eventType === "PAID_TRIAL_FINISHED");
  const calls = events.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED");
  const startByAttempt = new Map<string, typeof starts[number]>();
  for (const row of starts) {
    if (!row.attemptId || startByAttempt.has(row.attemptId)) issues.push(`DUPLICATE_OR_INVALID_PAID_TRIAL_START:${row.attemptId ?? "MISSING"}`);
    else startByAttempt.set(row.attemptId, row);
  }
  const finishByAttempt = new Map<string, typeof finishes[number]>();
  for (const row of finishes) {
    if (!row.attemptId || finishByAttempt.has(row.attemptId)) issues.push(`DUPLICATE_OR_INVALID_PAID_TRIAL_FINISH:${row.attemptId ?? "MISSING"}`);
    else finishByAttempt.set(row.attemptId, row);
  }
  const callKeys = new Set<string>();
  for (const row of calls) {
    const key = `${row.attemptId ?? "MISSING"}:${row.providerCallOrdinal ?? "MISSING"}`;
    if (!row.attemptId || !startByAttempt.has(row.attemptId) || callKeys.has(key)) issues.push(`PROVIDER_CALL_LEDGER_BINDING_INVALID:${key}`);
    callKeys.add(key);
  }
  const realCompletions = events.filter((row) => row.eventType === "REAL_AGENT_TRIAL_COMPLETED");
  const realCompletionIds = new Set<string>();
  for (const row of realCompletions) {
    if (!row.attemptId || !startByAttempt.has(row.attemptId) || realCompletionIds.has(row.attemptId)) {
      issues.push(`REAL_AGENT_COMPLETION_BINDING_INVALID:${row.attemptId ?? "MISSING"}`);
    } else realCompletionIds.add(row.attemptId);
  }

  const attemptFiles = (await filesBelow(join(runtime, "attempt-events"))).filter((path) => path.endsWith(".jsonl"));
  let attemptJournalStartedCount = 0;
  const attemptStates: Array<ReturnType<typeof reconstructResumeState>> = [];
  for (const path of attemptFiles) {
    sourceEvidence.push(await evidence(path, root, "ATTEMPT_JOURNAL"));
    const state = reconstructResumeState(await new AppendOnlyAttemptJournal(path).read(), FROZEN_DESIGN_BINDING.protocolHash);
    attemptStates.push(state);
    attemptJournalStartedCount += state.startedAttemptIds.size;
    const terminalAttemptIds = new Set(state.events.filter((event) => ["ATTEMPT_VALID", "ATTEMPT_SCIENTIFIC_ACTION_FAILURE", "ATTEMPT_TECHNICAL_INVALID", "ATTEMPT_INTEGRITY_INVALID", "ATTEMPT_NOT_DISPATCHED"]
      .includes(event.eventType)).map((event) => event.attemptId));
    for (const attemptId of state.startedAttemptIds) {
      if (!terminalAttemptIds.has(attemptId)) issues.push(`ATTEMPT_JOURNAL_TRANSACTION_UNRESOLVED:${attemptId}`);
    }
  }

  const budgetFiles = (await filesBelow(runtime)).filter((path) => basename(path) === "budget-snapshots.jsonl");
  let latestBudgetSnapshot: Awaited<ReturnType<AppendOnlyBudgetSnapshotJournal["read"]>>[number]["snapshot"] | undefined;
  for (const path of budgetFiles) {
    sourceEvidence.push(await evidence(path, root, "BUDGET_JOURNAL"));
    const snapshots = await new AppendOnlyBudgetSnapshotJournal(path).read();
    latestBudgetSnapshot = snapshots.at(-1)?.snapshot;
  }
  if (budgetFiles.length > 1) issues.push(`BUDGET_JOURNAL_CARDINALITY_INVALID:${budgetFiles.length}`);
  const configFiles = (await filesBelow(join(runtime, "harbor-configs"))).filter((path) => path.endsWith(".json"));
  const configJobNames = new Set<string>();
  for (const path of configFiles) {
    sourceEvidence.push(await evidence(path, root, "HARBOR_CONFIG"));
    const config = JSON.parse(await readFile(path, "utf8")) as { job_name?: string };
    if (!config.job_name || configJobNames.has(config.job_name)) issues.push(`HARBOR_CONFIG_IDENTITY_INVALID:${relative(root, path)}`);
    else configJobNames.add(config.job_name);
  }
  const jobsRoot = join(runtime, "harbor-jobs");
  const jobDirectories = (await exists(jobsRoot)) ? (await readdir(jobsRoot, { withFileTypes: true })).filter((row) => row.isDirectory()).map((row) => row.name).sort() : [];
  const jobFiles = await filesBelow(jobsRoot);
  for (const path of jobFiles) sourceEvidence.push(await evidence(path, root, "HARBOR_JOB_FILE"));
  for (const jobName of configJobNames) {
    const matches = starts.filter((row) => row.jobName === jobName);
    if (!jobDirectories.includes(jobName) && matches.length === 0) repairableBindings.push(`CONFIG_WRITTEN_BEFORE_START:${jobName}`);
    else if (matches.length !== 1) issues.push(`HARBOR_CONFIG_START_BINDING_INVALID:${jobName}`);
  }
  for (const jobName of jobDirectories) {
    const matches = starts.filter((row) => row.jobName === jobName);
    if (matches.length !== 1) issues.push(`HARBOR_JOB_START_BINDING_INVALID:${jobName}`);
  }
  for (const row of starts) {
    if (!row.jobName || !configJobNames.has(row.jobName)) issues.push(`PAID_TRIAL_CONFIG_MISSING:${row.attemptId}`);
    if (!row.jobName || !jobDirectories.includes(row.jobName)) issues.push(`RESUME_PAID_ATTEMPT_STATE_AMBIGUOUS:${row.attemptId}:JOB_DIRECTORY_MISSING`);
  }

  const rawFiles = (await filesBelow(join(runtime, "raw"))).filter((path) => path.endsWith(".json"));
  for (const path of rawFiles) sourceEvidence.push(await evidence(path, root, "RAW_ARTIFACT"));
  const rawPathByHash = new Map(rawFiles.map((path) => [basename(path, ".json"), path]));
  for (const state of attemptStates) for (const [attemptId, rawHash] of state.rawHashByAttempt) {
    const path = rawPathByHash.get(rawHash);
    if (!path || sha256(await readFile(path)) !== rawHash) issues.push(`RAW_ARTIFACT_BINDING_INVALID:${attemptId}:${rawHash}`);
    const finish = finishByAttempt.get(attemptId);
    if (!finish || finish.terminalStatus !== "VALID_RESULT") issues.push(`RAW_ARTIFACT_WITHOUT_VALID_PROVIDER_RESULT:${attemptId}`);
  }
  for (const state of attemptStates) for (const event of state.events) {
    if (!event.attemptId) continue;
    const finish = finishByAttempt.get(event.attemptId);
    if (event.eventType === "ATTEMPT_VALID" && finish?.terminalStatus !== "VALID_RESULT") {
      issues.push(`ATTEMPT_VALID_WITHOUT_VALID_PROVIDER_RESULT:${event.attemptId}`);
    }
    if (event.eventType === "ATTEMPT_TECHNICAL_INVALID" && finish?.terminalStatus !== "TECHNICAL_INVALID") {
      issues.push(`ATTEMPT_TECHNICAL_WITHOUT_TECHNICAL_PROVIDER_RESULT:${event.attemptId}`);
    }
  }
  for (const state of attemptStates) {
    const terminalEvents = state.events.filter((event) => event.attemptId
      && ["ATTEMPT_VALID", "ATTEMPT_SCIENTIFIC_ACTION_FAILURE", "ATTEMPT_TECHNICAL_INVALID", "ATTEMPT_INTEGRITY_INVALID", "ATTEMPT_NOT_DISPATCHED"].includes(event.eventType));
    const terminalByAttempt = new Map(terminalEvents.map((event) => [event.attemptId!, event]));
    for (const attemptId of new Set(terminalEvents.map((event) => event.attemptId!))) {
      if (terminalEvents.filter((event) => event.attemptId === attemptId).length !== 1) issues.push(`ATTEMPT_JOURNAL_TERMINAL_CARDINALITY_INVALID:${attemptId}`);
      if (!state.startedAttemptIds.has(attemptId)) issues.push(`ATTEMPT_JOURNAL_TERMINAL_WITHOUT_START:${attemptId}`);
    }
    for (const event of state.events.filter((row) => row.eventType === "ATTEMPT_STARTED")) {
      const attemptId = event.attemptId!; const paidStart = startByAttempt.get(attemptId); const terminal = terminalByAttempt.get(attemptId);
      if (terminal?.eventType === "ATTEMPT_NOT_DISPATCHED") {
        if (paidStart || finishByAttempt.has(attemptId) || calls.some((row) => row.attemptId === attemptId)) {
          issues.push(`ATTEMPT_NOT_DISPATCHED_HAS_PAID_EVIDENCE:${attemptId}`);
        }
      } else if (!paidStart) issues.push(`CAUSAL_ATTEMPT_WITHOUT_PAID_TRIAL_START:${attemptId}`);
      else if (paidStart.arm !== event.arm || paidStart.causalGroupId !== String(event.pairId).replace(/:pair-[0-9]+$/, "")) {
        issues.push(`CAUSAL_ATTEMPT_PAID_IDENTITY_DRIFT:${attemptId}`);
      }
    }
  }
  const resultRoot = join(runtime, "results");
  const normalFiles = (await filesBelow(join(resultRoot, "normal"))).filter((path) => path.endsWith(".json"));
  const normalIntegrityFiles = (await filesBelow(join(resultRoot, "integrity"))).filter((path) => path.endsWith(".json"));
  const pairFiles = (await filesBelow(join(resultRoot, "pairs"))).filter((path) => path.endsWith(".json"));
  const pairDecisionFiles = (await filesBelow(join(resultRoot, "pair-decisions"))).filter((path) => path.endsWith(".json"));
  const groupFiles = (await filesBelow(join(resultRoot, "groups"))).filter((path) => path.endsWith(".json"));
  const completionFiles = (await filesBelow(resultRoot)).filter((path) => basename(path) === "INITIAL6_PILOT_COMPLETION.json");
  for (const path of normalFiles) sourceEvidence.push(await evidence(path, root, "NORMAL_RESULT"));
  for (const path of normalIntegrityFiles) sourceEvidence.push(await evidence(path, root, "NORMAL_INTEGRITY"));
  for (const path of pairFiles) sourceEvidence.push(await evidence(path, root, "PAIR_RESULT"));
  for (const path of pairDecisionFiles) sourceEvidence.push(await evidence(path, root, "PAIR_DECISION"));
  for (const path of groupFiles) sourceEvidence.push(await evidence(path, root, "GROUP_RESULT"));
  for (const path of completionFiles) sourceEvidence.push(await evidence(path, root, "COMPLETION_MARKER"));

  const committedPairs = new Map<string, { fullAttemptId: string; removeAttemptId: string }>();
  for (const state of attemptStates) for (const pairId of state.pairIds) {
    const commit = state.events.find((event) => event.eventType === "PAIR_COMMITTED" && event.pairId === pairId)!;
    const fullAttemptId = String(commit.payload.fullAttemptId ?? ""); const removeAttemptId = String(commit.payload.removeAttemptId ?? "");
    if (!fullAttemptId || !removeAttemptId || committedPairs.has(pairId)) issues.push(`PAIR_COMMIT_IDENTITY_INVALID:${pairId}`);
    else committedPairs.set(pairId, { fullAttemptId, removeAttemptId });
  }
  const pairArtifacts = new Map<string, Record<string, unknown>>();
  for (const path of pairFiles) {
    const artifact = await readHashedJson(path, `PAIR_RESULT_INVALID:${relative(root, path).replaceAll("\\", "/")}`, issues);
    if (!artifact) continue;
    const pairId = typeof artifact.pairId === "string" ? artifact.pairId : "";
    if (!pairId || pairArtifacts.has(pairId)) issues.push(`PAIR_RESULT_IDENTITY_INVALID:${pairId || relative(root, path)}`);
    else pairArtifacts.set(pairId, artifact);
  }
  for (const [pairId, commit] of committedPairs) {
    const artifact = pairArtifacts.get(pairId);
    if (!artifact) repairableBindings.push(`PAIR_COMMITTED_BEFORE_RESULT_ARTIFACT:${pairId}`);
    else if (artifact.fullAttemptId !== commit.fullAttemptId || artifact.removeAttemptId !== commit.removeAttemptId
      || artifact.causalGroupId !== pairId.replace(/:pair-[0-9]+$/, "") || artifact.protocolHash !== FROZEN_DESIGN_BINDING.protocolHash) {
      issues.push(`PAIR_RESULT_COMMIT_BINDING_INVALID:${pairId}`);
    }
    const markers = events.filter((event) => event.eventType === "CAUSAL_Y_COMMITTED" && event.attemptId === pairId);
    if (!markers.length) repairableBindings.push(`PAIR_RESULT_BEFORE_CAUSAL_Y_MARKER:${pairId}`);
    else if (markers.length !== 1 || markers[0].causalGroupId !== pairId.replace(/:pair-[0-9]+$/, "")) {
      issues.push(`CAUSAL_Y_MARKER_BINDING_INVALID:${pairId}`);
    }
  }
  for (const pairId of pairArtifacts.keys()) if (!committedPairs.has(pairId)) issues.push(`PAIR_RESULT_WITHOUT_PAIR_COMMIT:${pairId}`);
  for (const marker of events.filter((event) => event.eventType === "CAUSAL_Y_COMMITTED")) {
    if (!marker.attemptId || !committedPairs.has(marker.attemptId)) issues.push(`CAUSAL_Y_MARKER_WITHOUT_PAIR_COMMIT:${marker.attemptId ?? "MISSING"}`);
  }

  const normalArtifactGroupIds = new Set<string>();
  const normalArtifacts = new Map<string, Record<string, unknown>>();
  for (const path of normalFiles) {
    const artifact = await readHashedJson(path, `NORMAL_RESULT_INVALID:${relative(root, path).replaceAll("\\", "/")}`, issues);
    if (!artifact) continue;
    if (typeof artifact.causalGroupId !== "string" || normalArtifactGroupIds.has(artifact.causalGroupId)) {
      issues.push(`NORMAL_RESULT_IDENTITY_INVALID:${artifact.causalGroupId ?? relative(root, path)}`);
    } else { normalArtifactGroupIds.add(artifact.causalGroupId); normalArtifacts.set(artifact.causalGroupId, artifact); }
    const result = artifact.result as { technicalMetadata?: { resultHash?: unknown } } | undefined;
    const resultHash = result?.technicalMetadata?.resultHash;
    const matches = finishes.filter((event) => event.terminalStatus === "VALID_RESULT" && event.arm === "NORMAL"
      && event.causalGroupId === artifact.causalGroupId && event.resultHash === resultHash);
    if (matches.length !== 1 || artifact.taskId !== matches[0]?.taskId) issues.push(`NORMAL_RESULT_LEDGER_BINDING_INVALID:${artifact.causalGroupId ?? relative(root, path)}`);
  }
  for (const finish of finishes.filter((event) => event.arm === "NORMAL" && event.terminalStatus === "VALID_RESULT")) {
    if (!finish.causalGroupId || !normalArtifactGroupIds.has(finish.causalGroupId)) repairableBindings.push(`NORMAL_RESULT_WRAPPER_MISSING:${finish.attemptId}`);
  }
  const integrityGroupIds = new Set<string>();
  for (const path of normalIntegrityFiles) {
    const artifact = await readHashedJson(path, `NORMAL_INTEGRITY_INVALID:${relative(root, path).replaceAll("\\", "/")}`, issues);
    if (!artifact) continue;
    const groupId = typeof artifact.causalGroupId === "string" ? artifact.causalGroupId : "";
    if (!groupId || integrityGroupIds.has(groupId)) issues.push(`NORMAL_INTEGRITY_IDENTITY_INVALID:${groupId || relative(root, path)}`);
    else {
      integrityGroupIds.add(groupId); const normal = normalArtifacts.get(groupId);
      if (!normal) issues.push(`NORMAL_INTEGRITY_WITHOUT_RESULT:${groupId}`);
      else if (artifact.taskId !== normal.taskId || artifact.frozenStateHash !== normal.frozenStateHash) issues.push(`NORMAL_INTEGRITY_RESULT_BINDING_INVALID:${groupId}`);
    }
  }
  for (const groupId of normalArtifactGroupIds) if (!integrityGroupIds.has(groupId)) repairableBindings.push(`NORMAL_INTEGRITY_WRAPPER_MISSING:${groupId}`);

  const groupArtifacts = new Map<string, Record<string, unknown>>();
  for (const path of groupFiles) {
    const artifact = await readHashedJson(path, `GROUP_RESULT_INVALID:${relative(root, path).replaceAll("\\", "/")}`, issues);
    if (!artifact) continue;
    const groupId = typeof artifact.causalGroupId === "string" ? artifact.causalGroupId : "";
    if (!groupId || groupArtifacts.has(groupId)) { issues.push(`GROUP_RESULT_IDENTITY_INVALID:${groupId || relative(root, path)}`); continue; }
    groupArtifacts.set(groupId, artifact);
    const groupCalls = calls.filter((event) => event.causalGroupId === groupId);
    const actualCny = groupCalls.reduce((sum, event) => sum + (event.amountCny ?? 0), 0);
    const pairs = [...pairArtifacts.values()].filter((pair) => pair.causalGroupId === groupId);
    if (artifact.actualPaidCalls !== groupCalls.length || typeof artifact.actualCostCny !== "number"
      || Math.abs(artifact.actualCostCny - actualCny) > 1e-12 || artifact.pairCount !== pairs.length) {
      issues.push(`GROUP_RESULT_EXECUTION_BINDING_INVALID:${groupId}`);
    }
  }
  if (latestBudgetSnapshot) {
    const activeUnitIds = new Set<string>();
    for (const reservation of latestBudgetSnapshot.reservations.filter((row) => row.status !== "RELEASED")) {
      if (activeUnitIds.has(reservation.unitId)) issues.push(`BUDGET_RESERVATION_UNIT_DUPLICATE:${reservation.unitId}`);
      activeUnitIds.add(reservation.unitId);
      const artifact = groupArtifacts.get(reservation.unitId);
      if (reservation.status === "RECONCILED") {
        if (!artifact) repairableBindings.push(`BUDGET_RECONCILED_BEFORE_GROUP_RESULT:${reservation.unitId}`);
        else if (reservation.actualPaidCalls !== artifact.actualPaidCalls || reservation.actualCny !== artifact.actualCostCny) {
          issues.push(`BUDGET_GROUP_RECONCILIATION_DRIFT:${reservation.unitId}`);
        }
      } else if (artifact) issues.push(`GROUP_RESULT_WITH_UNRECONCILED_BUDGET:${reservation.unitId}`);
    }
    for (const groupId of groupArtifacts.keys()) if (!activeUnitIds.has(groupId)) issues.push(`GROUP_RESULT_WITHOUT_BUDGET_RESERVATION:${groupId}`);
  } else if (groupArtifacts.size) issues.push("GROUP_RESULTS_WITHOUT_BUDGET_JOURNAL");

  const pairDecisionsByPath = new Map<string, Record<string, unknown>>();
  for (const path of pairDecisionFiles) {
    const artifact = await readHashedJson(path, `PAIR_DECISION_INVALID:${relative(root, path).replaceAll("\\", "/")}`, issues);
    if (!artifact) continue;
    pairDecisionsByPath.set(resolve(path), artifact);
    if (!Number.isInteger(artifact.validPairs) || typeof artifact.deepReference !== "boolean" || !Array.isArray(artifact.differences)) {
      issues.push(`PAIR_DECISION_SHAPE_INVALID:${relative(root, path).replaceAll("\\", "/")}`);
    }
  }
  const pairsByGroup = new Map<string, Record<string, unknown>[]>();
  for (const artifact of pairArtifacts.values()) {
    const groupId = String(artifact.causalGroupId ?? "");
    pairsByGroup.set(groupId, [...(pairsByGroup.get(groupId) ?? []), artifact]);
  }
  for (const [groupId, groupPairs] of pairsByGroup) {
    groupPairs.sort((a, b) => Number(a.pairIndex) - Number(b.pairIndex));
    for (let index = 1; index <= groupPairs.length; index += 1) {
      const path = resolve(resultRoot, "pair-decisions", hashCanonical(groupId).slice(0, 20), `prefix-${index}.json`);
      const decision = pairDecisionsByPath.get(path);
      if (!decision) repairableBindings.push(`PAIR_DECISION_MISSING:${groupId}:prefix-${index}`);
      else if (decision.validPairs !== index || hashCanonical(decision.differences) !== hashCanonical(groupPairs.slice(0, index).map((pair) => pair.difference))) {
        issues.push(`PAIR_DECISION_PAIR_BINDING_INVALID:${groupId}:prefix-${index}`);
      }
    }
  }
  for (const path of completionFiles) {
    const artifact = await readHashedJson(path, "INITIAL6_COMPLETION_INVALID", issues);
    if (!artifact) continue;
    if (artifact.status !== "INITIAL_6_TASK_PILOT_COMPLETE" || artifact.taskCount !== 6
      || artifact.groupCount !== groupArtifacts.size || artifact.paidCalls !== calls.length
      || typeof artifact.actualCostCny !== "number" || Math.abs(artifact.actualCostCny - calls.reduce((sum, row) => sum + (row.amountCny ?? 0), 0)) > 1e-12) {
      issues.push("INITIAL6_COMPLETION_EXECUTION_BINDING_INVALID");
    }
  }

  for (const [attemptId, start] of startByAttempt) {
    const finish = finishByAttempt.get(attemptId);
    if (!finish) issues.push(`RESUME_PAID_ATTEMPT_STATE_AMBIGUOUS:${attemptId}:TERMINAL_EVENT_MISSING`);
    else {
      if (finish.jobName !== start.jobName || finish.arm !== start.arm || finish.taskId !== start.taskId
        || finish.causalGroupId !== start.causalGroupId || !finish.resultHash
        || (finish.terminalStatus !== "VALID_RESULT" && finish.terminalStatus !== "TECHNICAL_INVALID")) {
        issues.push(`PAID_TRIAL_TERMINAL_IDENTITY_DRIFT:${attemptId}`);
      }
      const resultFiles = jobFiles.filter((path) => {
        const parts = relative(jobsRoot, path).replaceAll("\\", "/").split("/");
        return parts.length === 3 && parts[0] === start.jobName && parts[2] === "result.json";
      });
      if (resultFiles.length !== 1) issues.push(`PAID_TRIAL_RESULT_FILE_CARDINALITY_INVALID:${attemptId}:${resultFiles.length}`);
      else {
        const resultBytes = await readFile(resultFiles[0]);
        if (sha256(resultBytes) !== finish.resultHash) issues.push(`PAID_TRIAL_RESULT_HASH_MISMATCH:${attemptId}`);
        try {
          const result = JSON.parse(resultBytes.toString("utf8")) as { exception_info?: unknown; step_results?: Array<{
            exception_info?: unknown; agent_result?: { n_input_tokens?: number; n_cache_tokens?: number; n_output_tokens?: number;
              metadata?: { n_episodes?: number; api_request_times_msec?: unknown[] } } }> };
          const step = result.step_results?.[0]; const agent = step?.agent_result;
          const expectedCalls = agent?.metadata?.n_episodes ?? agent?.metadata?.api_request_times_msec?.length;
          const attemptCalls = calls.filter((row) => row.attemptId === attemptId);
          const nativeAgentExecutionStarted = Boolean(agent) && Number.isInteger(expectedCalls) && expectedCalls! > 0;
          if (agent && (!Number.isInteger(expectedCalls) || expectedCalls! < 0 || attemptCalls.length !== expectedCalls)) {
            issues.push(`PAID_TRIAL_PROVIDER_CALL_COUNT_DRIFT:${attemptId}`);
          } else if (!agent && attemptCalls.length) {
            issues.push(`PAID_TRIAL_PROVIDER_CALL_WITHOUT_NATIVE_AGENT:${attemptId}`);
          }
          if (agent) {
            const totals = {
              input: attemptCalls.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
              cached: attemptCalls.reduce((sum, row) => sum + (row.cachedInputTokens ?? 0), 0),
              output: attemptCalls.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
            };
            if (totals.input !== agent.n_input_tokens || totals.cached !== agent.n_cache_tokens || totals.output !== agent.n_output_tokens) {
              issues.push(`PAID_TRIAL_TOKEN_ACCOUNTING_DRIFT:${attemptId}`);
            }
            const expectedCost = ((totals.input - totals.cached) * 4.5 + totals.cached * 0.15 + totals.output * 13.5) / 1_000_000;
            const ledgerCost = attemptCalls.reduce((sum, row) => sum + (row.amountCny ?? 0), 0);
            if (Math.abs(expectedCost - ledgerCost) > 1e-12) issues.push(`PAID_TRIAL_COST_ACCOUNTING_DRIFT:${attemptId}`);
          }
          if (finish.terminalStatus === "VALID_RESULT" && (result.exception_info || step?.exception_info || !agent || !expectedCalls)) {
            issues.push(`PAID_TRIAL_VALID_RESULT_NATIVE_COMPLETENESS_INVALID:${attemptId}`);
          }
          if (nativeAgentExecutionStarted && !realCompletionIds.has(attemptId)) issues.push(`PAID_TRIAL_REAL_COMPLETION_MISSING:${attemptId}`);
          if (!nativeAgentExecutionStarted && realCompletionIds.has(attemptId)) issues.push(`REAL_AGENT_COMPLETION_WITHOUT_NATIVE_EXECUTION:${attemptId}`);
        } catch { issues.push(`PAID_TRIAL_RESULT_JSON_INVALID:${attemptId}`); }
      }
      const ordinals = calls.filter((row) => row.attemptId === attemptId).map((row) => row.providerCallOrdinal!).sort((a, b) => a - b);
      if (ordinals.some((ordinal, index) => ordinal !== index + 1)) issues.push(`PROVIDER_CALL_ORDINAL_GAP:${attemptId}`);
    }
  }
  for (const attemptId of finishByAttempt.keys()) if (!startByAttempt.has(attemptId)) issues.push(`PAID_TRIAL_FINISH_WITHOUT_START:${attemptId}`);
  const unresolvedPaidTrialIds = [...startByAttempt.keys()].filter((id) => !finishByAttempt.has(id)).sort();
  const technicalInvalidTrialIds = finishes.filter((row) => row.terminalStatus === "TECHNICAL_INVALID").map((row) => row.attemptId!).sort();
  const sortedEvidence = sourceEvidence.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  const blockingRepairableBindings = repairableBindings.filter((binding) => !binding.startsWith("CONFIG_WRITTEN_BEFORE_START:"));
  const body = {
    schemaVersion: "direction-a.current-formal.execution-reconciliation.v1" as const,
    generatedAt,
    status: issues.length || blockingRepairableBindings.length ? "CURRENT_FORMAL_EXECUTION_STATE_AMBIGUOUS" as const : "RECONCILIATION_PASS" as const,
    protocolHash: FROZEN_DESIGN_BINDING.protocolHash,
    executionLedgerEventCount: events.length,
    paidTrialStartedCount: startByAttempt.size,
    paidTrialFinishedCount: finishByAttempt.size,
    realAgentCompletedCount: realCompletionIds.size,
    providerCallCount: calls.length,
    actualCostCny: calls.reduce((sum, row) => sum + (row.amountCny ?? 0), 0),
    attemptJournalStartedCount,
    harborConfigCount: configFiles.length,
    harborJobDirectoryCount: jobDirectories.length,
    rawArtifactCount: rawFiles.length,
    normalResultCount: normalFiles.length,
    pairResultCount: pairFiles.length,
    groupResultCount: groupFiles.length,
    completionMarkerCount: completionFiles.length,
    technicalInvalidTrialIds,
    unresolvedPaidTrialIds,
    repairableBindings: [...new Set(repairableBindings)].sort(),
    issues: [...new Set(issues)].sort(),
    sourceEvidence: sortedEvidence,
    sourceEvidenceHash: hashCanonical(sortedEvidence),
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as CurrentFormalExecutionReconciliation;
}

export function assertCurrentFormalExecutionReconciliation(value: CurrentFormalExecutionReconciliation): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash || value.sourceEvidenceHash !== hashCanonical(value.sourceEvidence)) {
    throw new Error("CURRENT_FORMAL_EXECUTION_RECONCILIATION_HASH_MISMATCH");
  }
  const blockingRepairs = value.repairableBindings.filter((binding) => !binding.startsWith("CONFIG_WRITTEN_BEFORE_START:"));
  if (value.status !== "RECONCILIATION_PASS" || value.issues.length || blockingRepairs.length || value.unresolvedPaidTrialIds.length) {
    throw new Error(`CURRENT_FORMAL_EXECUTION_STATE_AMBIGUOUS:${[...value.issues, ...blockingRepairs].join("|")}`);
  }
}

export interface ReconciledCurrentFormalExecutionStateAttestation extends Omit<CurrentFormalExecutionStateAttestation,
  "schemaVersion" | "derivationPolicy" | "generatedAt" | "contentHash"> {
  schemaVersion: "direction-a.current-formal.execution-state-attestation.v2";
  generatedAt: string;
  derivationPolicy: "CROSS_LEDGER_RECONCILIATION_V1";
  reconciliationHash: string;
  reconciliationStatus: "RECONCILIATION_PASS";
  contentHash: string;
}

export async function deriveReconciledCurrentFormalExecutionState(repoRoot: string, generatedAt = new Date().toISOString()): Promise<{
  reconciliation: CurrentFormalExecutionReconciliation;
  state: ReconciledCurrentFormalExecutionStateAttestation;
}> {
  const reconciliation = await reconcileCurrentFormalExecution(repoRoot, generatedAt);
  assertCurrentFormalExecutionReconciliation(reconciliation);
  const ledgerState = await deriveCurrentFormalExecutionState(repoRoot, generatedAt);
  if (ledgerState.paidCallsExecuted !== reconciliation.providerCallCount
    || Math.abs(ledgerState.actualCostCny - reconciliation.actualCostCny) > 1e-12
    || ledgerState.realAgentCalls !== reconciliation.realAgentCompletedCount) {
    throw new Error("CURRENT_FORMAL_EXECUTION_STATE_AMBIGUOUS:LEDGER_RECONCILIATION_COUNTER_DRIFT");
  }
  const { schemaVersion: _schema, derivationPolicy: _policy, generatedAt: _generated, contentHash: _hash, ...shared } = ledgerState;
  const body = { schemaVersion: "direction-a.current-formal.execution-state-attestation.v2" as const, generatedAt,
    derivationPolicy: "CROSS_LEDGER_RECONCILIATION_V1" as const, ...shared,
    reconciliationHash: reconciliation.contentHash, reconciliationStatus: "RECONCILIATION_PASS" as const };
  const state = immutableCopy({ ...body, contentHash: hashCanonical(body) }) as ReconciledCurrentFormalExecutionStateAttestation;
  return { reconciliation, state };
}

export function assertReconciledCurrentFormalExecutionStateAttestation(value: ReconciledCurrentFormalExecutionStateAttestation,
  reconciliation?: CurrentFormalExecutionReconciliation): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash || value.derivationPolicy !== "CROSS_LEDGER_RECONCILIATION_V1"
    || value.reconciliationStatus !== "RECONCILIATION_PASS" || !value.reconciliationHash
    || value.ledgerRelativePath !== CURRENT_FORMAL_EXECUTION_LEDGER) {
    throw new Error("CURRENT_FORMAL_RECONCILED_STATE_ATTESTATION_INVALID");
  }
  if (reconciliation) {
    assertCurrentFormalExecutionReconciliation(reconciliation);
    if (value.reconciliationHash !== reconciliation.contentHash || value.paidCallsExecuted !== reconciliation.providerCallCount
      || value.realAgentCalls !== reconciliation.realAgentCompletedCount || Math.abs(value.actualCostCny - reconciliation.actualCostCny) > 1e-12) {
      throw new Error("CURRENT_FORMAL_RECONCILED_STATE_BINDING_MISMATCH");
    }
  }
}
