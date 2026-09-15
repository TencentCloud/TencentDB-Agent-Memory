import { access, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { join, relative, resolve } from "node:path";
import { hashCanonical, immutableCopy, sha256 } from "../core/canonical.js";
import type { Q6PreYExecutionState } from "./q6-holdout-seal.js";
import { assertQ6PreYExecutionState, type Q6CapacityProxyReport, type Q6HoldoutSeal } from "./q6-holdout-seal.js";

export const CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT = ".research/direction-a/current-formal/pilot/runtime-v3" as const;
export const CURRENT_FORMAL_EXECUTION_LEDGER = `${CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT}/execution-events.jsonl` as const;

export type CurrentFormalExecutionEventType =
  | "PAID_TRIAL_STARTED"
  | "PROVIDER_CALL_COMPLETED"
  | "REAL_AGENT_TRIAL_COMPLETED"
  | "PAID_TRIAL_FINISHED"
  | "CAUSAL_Y_COMMITTED"
  | "PILOT_TASK_CONSUMED"
  | "FORMAL_CAL_TEST_CONSUMED"
  | "SEALED_TEST_CONSUMED"
  | "FORMAL_MAIN_OPENED"
  | "SECRET_CONTENT_READ";

export interface CurrentFormalExecutionEvent {
  schemaVersion: "direction-a.current-formal.execution-event.v1";
  sequence: number;
  eventType: CurrentFormalExecutionEventType;
  occurredAt: string;
  taskId?: string;
  causalGroupId?: string;
  attemptId?: string;
  amountCny?: number;
  providerCallOrdinal?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  jobName?: string;
  arm?: "NORMAL" | "FULL" | "REMOVE";
  pairIndex?: number;
  resultHash?: string;
  terminalStatus?: "VALID_RESULT" | "TECHNICAL_INVALID";
  previousEventHash: string | "GENESIS";
  eventHash: string;
}

export class CurrentFormalExecutionEventJournal {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async read(): Promise<CurrentFormalExecutionEvent[]> {
    try { return parseCurrentFormalExecutionEvents(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  append(input: Omit<CurrentFormalExecutionEvent, "schemaVersion" | "sequence" | "previousEventHash" | "eventHash">): Promise<CurrentFormalExecutionEvent> {
    const operation = this.queue.then(async () => {
      const rows = await this.read();
      const previousEventHash = rows.at(-1)?.eventHash ?? "GENESIS";
      const body = { schemaVersion: "direction-a.current-formal.execution-event.v1" as const, sequence: rows.length + 1,
        ...structuredClone(input), previousEventHash };
      const event: CurrentFormalExecutionEvent = { ...body, eventHash: hashCanonical(body) };
      assertEventShape(event, body.sequence, previousEventHash);
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      return event;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

export interface ExecutionStateSourceEvidence {
  path: string;
  present: boolean;
  bytes: number;
  sha256: string | "ABSENT";
}

export interface CurrentFormalExecutionStateAttestation extends Q6PreYExecutionState {
  schemaVersion: "direction-a.current-formal.execution-state-attestation.v1";
  generatedAt: string;
  derivationPolicy: "PERSISTED_APPEND_ONLY_EXECUTION_LEDGER_ONLY";
  ledgerRelativePath: typeof CURRENT_FORMAL_EXECUTION_LEDGER;
  ledgerEventCount: number;
  pilotIndependentTasksConsumed: number;
  pilotTaskIds: string[];
  actualCostCny: number;
  secretContentReadEvents: number;
  sourceEvidence: ExecutionStateSourceEvidence[];
  currentFormalInventoryHash: string;
  contentHash: string;
}

function assertEventShape(event: CurrentFormalExecutionEvent, expectedSequence: number, previousEventHash: string | "GENESIS"): void {
  if (event.schemaVersion !== "direction-a.current-formal.execution-event.v1") throw new Error("CURRENT_FORMAL_EXECUTION_EVENT_SCHEMA_MISMATCH");
  if (event.sequence !== expectedSequence || event.previousEventHash !== previousEventHash) throw new Error("CURRENT_FORMAL_EXECUTION_EVENT_CHAIN_MISMATCH");
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error("CURRENT_FORMAL_EXECUTION_EVENT_TIME_INVALID");
  const { eventHash, ...body } = event;
  if (hashCanonical(body) !== eventHash) throw new Error("CURRENT_FORMAL_EXECUTION_EVENT_HASH_MISMATCH");
  if (event.amountCny !== undefined && (!Number.isFinite(event.amountCny) || event.amountCny < 0)) throw new Error("CURRENT_FORMAL_EXECUTION_EVENT_COST_INVALID");
  for (const field of ["providerCallOrdinal", "inputTokens", "cachedInputTokens", "outputTokens"] as const) {
    const value = event[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(`CURRENT_FORMAL_EXECUTION_EVENT_${field.toUpperCase()}_INVALID`);
  }
  if (event.eventType === "PILOT_TASK_CONSUMED" && !event.taskId) throw new Error("CURRENT_FORMAL_PILOT_TASK_EVENT_MISSING_TASK_ID");
  if (event.eventType === "PAID_TRIAL_STARTED" && (!event.attemptId || !event.taskId || !event.causalGroupId || !event.jobName || !event.arm)) {
    throw new Error("CURRENT_FORMAL_PAID_TRIAL_START_BINDING_INCOMPLETE");
  }
  if (event.eventType === "PAID_TRIAL_FINISHED" && (!event.attemptId || !event.resultHash || !event.terminalStatus)) {
    throw new Error("CURRENT_FORMAL_PAID_TRIAL_FINISH_BINDING_INCOMPLETE");
  }
}

export function parseCurrentFormalExecutionEvents(text: string): CurrentFormalExecutionEvent[] {
  const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as CurrentFormalExecutionEvent);
  let previous: string | "GENESIS" = "GENESIS";
  rows.forEach((row, index) => { assertEventShape(row, index + 1, previous); previous = row.eventHash; });
  return rows;
}

async function sourceEvidence(path: string, root: string): Promise<ExecutionStateSourceEvidence> {
  try {
    const bytes = await readFile(path);
    return { path: relative(root, path).replaceAll("\\", "/"), present: true, bytes: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path: relative(root, path).replaceAll("\\", "/"), present: false, bytes: 0, sha256: "ABSENT" };
  }
}

async function recursiveInventory(directory: string, root: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  try { await access(directory); } catch { return []; }
  const output: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await recursiveInventory(path, root));
    else if (entry.isFile()) {
      const repositoryPath = relative(root, path).replaceAll("\\", "/");
      if (/\/prepilot\/current-formal-execution-(?:state-attestation-v[123]|reconciliation-v[12])\.json$/.test(repositoryPath)) continue;
      const bytes = await readFile(path);
      output.push({ path: repositoryPath, bytes: (await stat(path)).size, sha256: sha256(bytes) });
    }
  }
  return output;
}

/** Derives state from the one authoritative append-only ledger. No counter is accepted from a caller. */
export async function deriveCurrentFormalExecutionState(repoRoot: string, generatedAt = new Date().toISOString()): Promise<CurrentFormalExecutionStateAttestation> {
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("CURRENT_FORMAL_EXECUTION_ATTESTATION_TIME_INVALID");
  const root = resolve(repoRoot);
  const ledgerPath = join(root, CURRENT_FORMAL_EXECUTION_LEDGER);
  let ledgerText = "";
  try { ledgerText = await readFile(ledgerPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const events = parseCurrentFormalExecutionEvents(ledgerText);
  const pilotTaskIds = [...new Set(events.filter((row) => row.eventType === "PILOT_TASK_CONSUMED").map((row) => row.taskId!))].sort();
  const state: Q6PreYExecutionState = {
    paidCallsExecuted: events.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED").length,
    networkProviderCalls: events.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED").length,
    realAgentCalls: new Set(events.filter((row) => row.eventType === "REAL_AGENT_TRIAL_COMPLETED")
      .map((row) => row.attemptId).filter(Boolean)).size,
    realCausalYProduced: events.filter((row) => row.eventType === "CAUSAL_Y_COMMITTED").length,
    formalCalTestConsumed: events.filter((row) => row.eventType === "FORMAL_CAL_TEST_CONSUMED").length,
    sealedTestConsumed: events.filter((row) => row.eventType === "SEALED_TEST_CONSUMED").length,
    formalMainOpened: events.some((row) => row.eventType === "FORMAL_MAIN_OPENED"),
  };
  const currentFormalRoot = join(root, ".research/direction-a/current-formal");
  const inventory = await recursiveInventory(currentFormalRoot, root);
  const evidence = [await sourceEvidence(ledgerPath, root)];
  const body = {
    schemaVersion: "direction-a.current-formal.execution-state-attestation.v1" as const,
    generatedAt,
    derivationPolicy: "PERSISTED_APPEND_ONLY_EXECUTION_LEDGER_ONLY" as const,
    ledgerRelativePath: CURRENT_FORMAL_EXECUTION_LEDGER,
    ledgerEventCount: events.length,
    ...state,
    pilotIndependentTasksConsumed: pilotTaskIds.length,
    pilotTaskIds,
    actualCostCny: events.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED").reduce((sum, row) => sum + (row.amountCny ?? 0), 0),
    secretContentReadEvents: events.filter((row) => row.eventType === "SECRET_CONTENT_READ").length,
    sourceEvidence: evidence,
    currentFormalInventoryHash: hashCanonical(inventory),
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as CurrentFormalExecutionStateAttestation;
}

export function assertCurrentFormalExecutionStateAttestation(value: CurrentFormalExecutionStateAttestation): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("CURRENT_FORMAL_EXECUTION_STATE_ATTESTATION_HASH_MISMATCH");
  if (value.derivationPolicy !== "PERSISTED_APPEND_ONLY_EXECUTION_LEDGER_ONLY" || value.ledgerRelativePath !== CURRENT_FORMAL_EXECUTION_LEDGER) {
    throw new Error("CURRENT_FORMAL_EXECUTION_STATE_ATTESTATION_POLICY_MISMATCH");
  }
}

function preYStateOf(value: Q6PreYExecutionState): Q6PreYExecutionState {
  return {
    paidCallsExecuted: value.paidCallsExecuted,
    networkProviderCalls: value.networkProviderCalls,
    realAgentCalls: value.realAgentCalls,
    realCausalYProduced: value.realCausalYProduced,
    formalCalTestConsumed: value.formalCalTestConsumed,
    sealedTestConsumed: value.sealedTestConsumed,
    formalMainOpened: value.formalMainOpened,
  };
}

export interface Q6HistoricalPreYAttestation {
  schemaVersion: "direction-a.q6-historical-pre-y-attestation.v1";
  issuedAt: string;
  conclusion: "Q6_SEALED_BEFORE_ANY_CURRENT_FORMAL_CAUSAL_Y";
  q6SealHash: string;
  q6CapacityReportHash: string;
  q6SealDecidedAt: string;
  priorZeroCallArtifact: { path: string; fileSha256: string; contentHash: string; createdAtUtc: string; modifiedAtUtc: string };
  lockedSourceEvidence: Array<{ path: string; fileSha256: string }>;
  gitEvidence: { head: string; tagsAtHead: string[] };
  currentExecutionStateAttestationHash: string;
  historicalState: Q6PreYExecutionState;
  contentHash: string;
}

export function buildQ6HistoricalPreYAttestation(input: {
  issuedAt: string;
  seal: Q6HoldoutSeal;
  capacityReport: Q6CapacityProxyReport;
  priorZeroCallArtifact: Q6HistoricalPreYAttestation["priorZeroCallArtifact"];
  priorZeroCallState: Q6PreYExecutionState;
  lockedSourceEvidence: Q6HistoricalPreYAttestation["lockedSourceEvidence"];
  gitEvidence: Q6HistoricalPreYAttestation["gitEvidence"];
  currentState: CurrentFormalExecutionStateAttestation;
}): Q6HistoricalPreYAttestation {
  if (!Number.isFinite(Date.parse(input.issuedAt))) throw new Error("Q6_PRE_Y_ATTESTATION_TIME_INVALID");
  assertQ6PreYExecutionState(input.priorZeroCallState);
  assertCurrentFormalExecutionStateAttestation(input.currentState);
  assertQ6PreYExecutionState(preYStateOf(input.currentState));
  if (input.seal.capacityReportHash !== input.capacityReport.contentHash) {
    throw new Error("Q6_PRE_Y_ATTESTATION_AUTHORITY_MISMATCH");
  }
  if (Date.parse(input.priorZeroCallArtifact.createdAtUtc) > Date.parse(input.seal.selectionProvenance.decidedAt)
    || Date.parse(input.priorZeroCallArtifact.modifiedAtUtc) > Date.parse(input.seal.selectionProvenance.decidedAt)) {
    throw new Error("Q6_PRE_Y_ZERO_CALL_ARTIFACT_NOT_PRIOR_TO_SEAL");
  }
  if (!input.lockedSourceEvidence.length || input.lockedSourceEvidence.some((row) => !row.path || !row.fileSha256)
    || !input.gitEvidence.head || !input.gitEvidence.tagsAtHead.length) throw new Error("Q6_PRE_Y_LOCKED_SOURCE_EVIDENCE_INCOMPLETE");
  const body = {
    schemaVersion: "direction-a.q6-historical-pre-y-attestation.v1" as const,
    issuedAt: input.issuedAt,
    conclusion: "Q6_SEALED_BEFORE_ANY_CURRENT_FORMAL_CAUSAL_Y" as const,
    q6SealHash: input.seal.contentHash,
    q6CapacityReportHash: input.capacityReport.contentHash,
    q6SealDecidedAt: input.seal.selectionProvenance.decidedAt,
    priorZeroCallArtifact: structuredClone(input.priorZeroCallArtifact),
    lockedSourceEvidence: [...input.lockedSourceEvidence].sort((a, b) => a.path.localeCompare(b.path)),
    gitEvidence: { head: input.gitEvidence.head, tagsAtHead: [...input.gitEvidence.tagsAtHead].sort() },
    currentExecutionStateAttestationHash: input.currentState.contentHash,
    historicalState: structuredClone(input.priorZeroCallState),
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as Q6HistoricalPreYAttestation;
}

export function assertQ6HistoricalPreYAttestation(value: Q6HistoricalPreYAttestation, seal: Q6HoldoutSeal, capacityReport: Q6CapacityProxyReport): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("Q6_PRE_Y_ATTESTATION_HASH_MISMATCH");
  if (value.conclusion !== "Q6_SEALED_BEFORE_ANY_CURRENT_FORMAL_CAUSAL_Y"
    || value.q6SealHash !== seal.contentHash || value.q6CapacityReportHash !== capacityReport.contentHash
    || value.q6SealDecidedAt !== seal.selectionProvenance.decidedAt) throw new Error("Q6_PRE_Y_ATTESTATION_BINDING_MISMATCH");
  assertQ6PreYExecutionState(value.historicalState);
}
