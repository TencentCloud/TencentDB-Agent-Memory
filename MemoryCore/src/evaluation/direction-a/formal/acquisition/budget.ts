import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BudgetAuthorizationManifest } from "../core/contracts.js";
import { FROZEN_DESIGN_BINDING } from "../config/frozen-design.js";
import { INITIAL6_BUDGET_AUTHORITY } from "../config/initial6-budget-authority.js";
import { assertBudgetAuthorizationManifest } from "../core/budget-authorization.js";

export interface PilotCostForecast {
  schemaVersion: "direction-a.pilot-cost-forecast.v1";
  totalPilotCostSamplesCny: number[];
  conservativeP95Cny: number;
  safetyMultiplier: 1.2;
  plannedCapCny: number;
  planningTargetCny: 100;
  contentHash: string;
}

export function buildPilotCostForecast(totalPilotCostSamplesCny: readonly number[]): PilotCostForecast {
  if (!totalPilotCostSamplesCny.length || totalPilotCostSamplesCny.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("P95 forecast requires non-negative total-Pilot cost samples");
  const sorted = [...totalPilotCostSamplesCny].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  const conservativeP95Cny = sorted[index];
  const body = { schemaVersion: "direction-a.pilot-cost-forecast.v1" as const, totalPilotCostSamplesCny: sorted,
    conservativeP95Cny, safetyMultiplier: 1.2 as const,
    plannedCapCny: conservativeP95Cny * 1.2,
    planningTargetCny: INITIAL6_BUDGET_AUTHORITY.planningTargetCny };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as PilotCostForecast;
}

export interface BudgetReservation {
  reservationId: string;
  unitId: string;
  expectedUnitCny: number;
  technicalRetryReserveCny: number;
  reservedCny: number;
  reservedPaidCalls: number;
  status: "RESERVED" | "RECONCILED" | "RELEASED";
  actualCny?: number;
  actualPaidCalls?: number;
}

export interface AtomicBudgetSnapshot {
  authorizationHash: string;
  forecastHash: string;
  reservations: BudgetReservation[];
}

export interface PersistentBudgetSnapshotEvent {
  schemaVersion: "direction-a.current-formal.budget-snapshot-event.v1";
  sequence: number;
  occurredAt: string;
  snapshot: AtomicBudgetSnapshot;
  previousEventHash: string | "GENESIS";
  eventHash: string;
}

export class AppendOnlyBudgetSnapshotJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}

  async read(): Promise<PersistentBudgetSnapshotEvent[]> {
    let text = "";
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as PersistentBudgetSnapshotEvent);
    let previous: string | "GENESIS" = "GENESIS";
    rows.forEach((row, index) => {
      const { eventHash, ...body } = row;
      if (row.schemaVersion !== "direction-a.current-formal.budget-snapshot-event.v1" || row.sequence !== index + 1
        || row.previousEventHash !== previous || hashCanonical(body) !== eventHash || !Number.isFinite(Date.parse(row.occurredAt))) {
        throw new Error(`BUDGET_SNAPSHOT_JOURNAL_CORRUPT:${index + 1}`);
      }
      previous = row.eventHash;
    });
    return rows;
  }

  append(snapshot: AtomicBudgetSnapshot, occurredAt = new Date().toISOString()): Promise<PersistentBudgetSnapshotEvent> {
    const operation = this.queue.then(async () => {
      const rows = await this.read(); const previousEventHash = rows.at(-1)?.eventHash ?? "GENESIS";
      const body = { schemaVersion: "direction-a.current-formal.budget-snapshot-event.v1" as const,
        sequence: rows.length + 1, occurredAt, snapshot: structuredClone(snapshot), previousEventHash };
      const event = { ...body, eventHash: hashCanonical(body) };
      await mkdir(dirname(this.path), { recursive: true }); const handle = await open(this.path, "a");
      try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      return event;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

export class AtomicPilotBudgetGuard {
  private readonly reservations = new Map<string, BudgetReservation>();
  private readonly authorizationHash: string;
  private readonly planningTargetCny: number;

  private readonly forecastHash: string;
  constructor(readonly authorization: BudgetAuthorizationManifest, readonly forecast: PilotCostForecast | Initial6CostForecast, snapshot?: AtomicBudgetSnapshot) {
    assertBudgetAuthorizationManifest(authorization, FROZEN_DESIGN_BINDING.protocolHash, authorization.executionManifestHash, INITIAL6_BUDGET_AUTHORITY.planningTargetCny);
    const { contentHash: forecastHash, ...forecastBody } = forecast;
    if (hashCanonical(forecastBody) !== forecastHash) throw new Error("Pilot cost forecast content hash mismatch");
    if (forecast.schemaVersion === "direction-a.initial6-cost-forecast.v3") assertInitial6CostForecast(forecast);
    this.authorizationHash = hashCanonical(authorization);
    this.forecastHash = forecastHash;
    const plannedCapCny = forecast.schemaVersion === "direction-a.initial6-cost-forecast.v3" ? forecast.selectedPlan.safetyAdjustedP95Cny : forecast.plannedCapCny;
    const forecastTargetCny = forecast.planningTargetCny;
    this.planningTargetCny = authorization.planningTargetCny;
    if (forecastTargetCny !== INITIAL6_BUDGET_AUTHORITY.planningTargetCny
      || authorization.planningTargetCny !== INITIAL6_BUDGET_AUTHORITY.planningTargetCny
      || plannedCapCny > INITIAL6_BUDGET_AUTHORITY.planningTargetCny) throw new Error("CNY100_PLANNING_TARGET_MISMATCH");
    if (snapshot) {
      if (snapshot.authorizationHash !== this.authorizationHash || snapshot.forecastHash !== forecast.contentHash) throw new Error("Budget resume snapshot authority mismatch");
      snapshot.reservations.forEach((row) => this.reservations.set(row.reservationId, structuredClone(row)));
      this.assertTotalsWithinLimits(true);
    }
  }

  private totals(): { cny: number; calls: number } {
    const active = [...this.reservations.values()].filter((row) => row.status !== "RELEASED");
    return { cny: active.reduce((sum, row) => sum + (row.status === "RECONCILED" ? row.actualCny! : row.reservedCny), 0),
      calls: active.reduce((sum, row) => sum + (row.status === "RECONCILED" ? row.actualPaidCalls! : row.reservedPaidCalls), 0) };
  }

  private assertTotalsWithinLimits(allowReconciledOvershoot = false): void {
    const totals = this.totals();
    if (!allowReconciledOvershoot && totals.cny > this.planningTargetCny + 1e-12) throw new Error(`PLANNING_BUDGET_TARGET_EXCEEDED:${totals.cny}>${this.planningTargetCny}`);
    if (totals.calls > this.authorization.maxPaidCalls) throw new Error(`ATOMIC_BUDGET_CALLS_EXCEEDED:${totals.calls}>${this.authorization.maxPaidCalls}`);
  }

  reserveCompleteCausalUnit(input: { unitId: string; expectedUnitCny: number; technicalRetryReserveCny: number; paidCallsIncludingRetry: number }): BudgetReservation {
    if (!input.unitId || !(input.expectedUnitCny >= 0) || !(input.technicalRetryReserveCny >= 0) || !Number.isInteger(input.paidCallsIncludingRetry) || input.paidCallsIncludingRetry < 1) throw new Error("Invalid complete-unit reservation");
    if ([...this.reservations.values()].some((row) => row.unitId === input.unitId && row.status !== "RELEASED")) throw new Error(`Causal unit ${input.unitId} already has an active reservation`);
    const reservedCny = input.expectedUnitCny + input.technicalRetryReserveCny;
    const reservationId = `reservation-${hashCanonical({ input, sequence: this.reservations.size + 1 }).slice(0, 20)}`;
    const reservation: BudgetReservation = { reservationId, unitId: input.unitId, expectedUnitCny: input.expectedUnitCny,
      technicalRetryReserveCny: input.technicalRetryReserveCny, reservedCny, reservedPaidCalls: input.paidCallsIncludingRetry, status: "RESERVED" };
    this.reservations.set(reservationId, reservation);
    try { this.assertTotalsWithinLimits(); } catch (error) { this.reservations.delete(reservationId); throw error; }
    return structuredClone(reservation);
  }

  reconcile(reservationId: string, actualCny: number, actualPaidCalls: number): BudgetReservation {
    const prior = this.reservations.get(reservationId);
    if (!prior || prior.status !== "RESERVED") throw new Error(`Unknown/non-reserved budget reservation ${reservationId}`);
    if (!Number.isFinite(actualCny) || actualCny < 0 || !Number.isInteger(actualPaidCalls) || actualPaidCalls < 0) throw new Error("Invalid actual unit cost/call count");
    // The CNY reservation is a planning amount, not an absolute ceiling: once a
    // complete causal group has started, its fully reconciled cost may exceed
    // that amount. Provider-call scope remains a hard boundary.
    if (actualPaidCalls > prior.reservedPaidCalls) throw new Error("Actual causal unit exceeded its hard provider-call reservation");
    const next: BudgetReservation = { ...prior, status: "RECONCILED", actualCny, actualPaidCalls };
    this.reservations.set(reservationId, next); this.assertTotalsWithinLimits(true); return structuredClone(next);
  }

  releaseUnused(reservationId: string): void {
    const prior = this.reservations.get(reservationId);
    if (!prior || prior.status !== "RESERVED") throw new Error(`Unknown/non-reserved budget reservation ${reservationId}`);
    this.reservations.set(reservationId, { ...prior, status: "RELEASED" });
  }

  snapshot(): AtomicBudgetSnapshot {
    return { authorizationHash: this.authorizationHash, forecastHash: this.forecastHash,
      reservations: [...this.reservations.values()].sort((a, b) => a.reservationId.localeCompare(b.reservationId)).map((row) => structuredClone(row)) };
  }

  remainingCapacity(): { cny: number; paidCalls: number } {
    const totals = this.totals();
    return { cny: Math.max(0, this.planningTargetCny - totals.cny), paidCalls: Math.max(0, this.authorization.maxPaidCalls - totals.calls) };
  }
}

export interface Initial6CandidatePlanForecast {
  groupCount: number;
  additionalGroupCount: number;
  deepReferenceCount: 2 | 3 | 4 | 6;
  normalValidTrials: number;
  ordinaryValidArmTrials: number;
  deepValidArmTrials: number;
  technicalRetryReserveTrials: number;
  reservedTaskExecutingTrials: number;
  maxPaidCalls: number;
  costP50Cny: number;
  costP90Cny: number;
  conservativeP95Cny: number;
  safetyAdjustedP95Cny: number;
  feasible: boolean;
}

export interface Initial6CostForecast {
  schemaVersion: "direction-a.initial6-cost-forecast.v3";
  pricingAuthorityHash: string;
  pricingMode: "DEEPSEEK_OFF_PEAK_ONLY";
  pricingProvenanceUrl: string;
  pricingRetrievedAt: string;
  empiricalCostSupportCny: number[];
  empiricalCostSourceHash: string;
  bootstrapPolicy: { seed: string; samples: 20000; nestedTrialPrefixes: true };
  technicalRetryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT";
  technicalRetryLimitPerGroup: number;
  maxProviderCallsPerTaskExecutingTrial: number;
  candidatePlans: Initial6CandidatePlanForecast[];
  selectedPlan: Initial6CandidatePlanForecast;
  planningTargetCny: 100;
  monetaryLimitSemantics: "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT";
  safetyMultiplier: 1.2;
  contentHash: string;
}

function quantile(sorted: readonly number[], probability: number): number {
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

function seededUint32(seed: string): () => number {
  let state = Number.parseInt(hashCanonical(seed).slice(0, 8), 16) >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

export function buildInitial6CostForecast(input: {
  pricingRetrievedAt: string;
  empiricalCostSupportCny: readonly number[];
  empiricalCostSourceHash: string;
  maximumCandidateGroupCount: number;
  technicalRetryLimitPerGroup: number;
  maxProviderCallsPerTaskExecutingTrial: number;
}): Initial6CostForecast {
  if (!Number.isFinite(Date.parse(input.pricingRetrievedAt)) || !input.empiricalCostSourceHash) throw new Error("INITIAL6_COST_PROVENANCE_INCOMPLETE");
  if (!input.empiricalCostSupportCny.length || input.empiricalCostSupportCny.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("INITIAL6_COST_SUPPORT_INVALID");
  if (!Number.isInteger(input.maximumCandidateGroupCount) || input.maximumCandidateGroupCount < 6
    || !Number.isInteger(input.technicalRetryLimitPerGroup) || input.technicalRetryLimitPerGroup < 0
    || !Number.isInteger(input.maxProviderCallsPerTaskExecutingTrial) || input.maxProviderCallsPerTaskExecutingTrial < 1) throw new Error("INITIAL6_CALL_GRAPH_INVALID");
  const seed = "direction-a-initial6-offpeak-cost-bootstrap-2026-09-05-v2";
  const deepCounts = [2, 3, 4, 6] as const;
  const planShapes: Array<Omit<Initial6CandidatePlanForecast, "costP50Cny" | "costP90Cny" | "conservativeP95Cny" | "safetyAdjustedP95Cny" | "feasible">> = [];
  for (let groupCount = 6; groupCount <= input.maximumCandidateGroupCount; groupCount += 1) for (const deepReferenceCount of deepCounts) {
    if (deepReferenceCount > groupCount) continue;
    const normalValidTrials = groupCount;
    const ordinaryValidArmTrials = (groupCount - deepReferenceCount) * 5 * 2;
    const deepValidArmTrials = deepReferenceCount * 8 * 2;
    const technicalRetryReserveTrials = groupCount * input.technicalRetryLimitPerGroup;
    const reservedTaskExecutingTrials = normalValidTrials + ordinaryValidArmTrials + deepValidArmTrials + technicalRetryReserveTrials;
    planShapes.push({ groupCount, additionalGroupCount: groupCount - 6, deepReferenceCount, normalValidTrials, ordinaryValidArmTrials,
      deepValidArmTrials, technicalRetryReserveTrials, reservedTaskExecutingTrials,
      maxPaidCalls: reservedTaskExecutingTrials * input.maxProviderCallsPerTaskExecutingTrial });
  }
  const neededPrefixes = new Set(planShapes.map((row) => row.reservedTaskExecutingTrials));
  const totals = new Map<number, number[]>([...neededPrefixes].map((count) => [count, []]));
  const maxPrefix = Math.max(...neededPrefixes);
  const random = seededUint32(seed);
  for (let simulation = 0; simulation < 20000; simulation += 1) {
    let cumulative = 0;
    for (let trial = 1; trial <= maxPrefix; trial += 1) {
      cumulative += input.empiricalCostSupportCny[random() % input.empiricalCostSupportCny.length];
      if (neededPrefixes.has(trial)) totals.get(trial)!.push(cumulative);
    }
  }
  const candidatePlans = planShapes.map((shape): Initial6CandidatePlanForecast => {
    const samples = totals.get(shape.reservedTaskExecutingTrials)!.sort((a, b) => a - b);
    const conservativeP95Cny = quantile(samples, 0.95);
    const safetyAdjustedP95Cny = conservativeP95Cny * 1.2;
    return { ...shape, costP50Cny: quantile(samples, 0.5), costP90Cny: quantile(samples, 0.9), conservativeP95Cny, safetyAdjustedP95Cny,
      feasible: safetyAdjustedP95Cny <= INITIAL6_BUDGET_AUTHORITY.planningTargetCny };
  });
  const feasible = candidatePlans.filter((row) => row.feasible).sort((a, b) => b.additionalGroupCount - a.additionalGroupCount
    || b.deepReferenceCount - a.deepReferenceCount || a.safetyAdjustedP95Cny - b.safetyAdjustedP95Cny);
  if (!feasible.length) throw new Error("CORE_DECISION_REQUIRED:INITIAL_PILOT_BUDGET_INFEASIBLE");
  const selectedPlan = feasible[0];
  const minimum = candidatePlans.find((row) => row.groupCount === 6 && row.deepReferenceCount === 2)!;
  if (!minimum.feasible) throw new Error("CORE_DECISION_REQUIRED:INITIAL_PILOT_BUDGET_INFEASIBLE");
  const body = { schemaVersion: "direction-a.initial6-cost-forecast.v3" as const, pricingAuthorityHash: INITIAL6_BUDGET_AUTHORITY.contentHash,
    pricingMode: "DEEPSEEK_OFF_PEAK_ONLY" as const, pricingProvenanceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    pricingRetrievedAt: input.pricingRetrievedAt, empiricalCostSupportCny: [...input.empiricalCostSupportCny].sort((a, b) => a - b),
    empiricalCostSourceHash: input.empiricalCostSourceHash,
    bootstrapPolicy: { seed, samples: 20000 as const, nestedTrialPrefixes: true as const }, technicalRetryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT" as const,
    technicalRetryLimitPerGroup: input.technicalRetryLimitPerGroup, maxProviderCallsPerTaskExecutingTrial: input.maxProviderCallsPerTaskExecutingTrial,
    candidatePlans, selectedPlan, planningTargetCny: INITIAL6_BUDGET_AUTHORITY.planningTargetCny,
    monetaryLimitSemantics: "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT" as const, safetyMultiplier: 1.2 as const };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as Initial6CostForecast;
}

export function assertInitial6CostForecast(value: Initial6CostForecast): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("INITIAL6_COST_FORECAST_HASH_MISMATCH");
  if (value.pricingAuthorityHash !== INITIAL6_BUDGET_AUTHORITY.contentHash || value.pricingMode !== "DEEPSEEK_OFF_PEAK_ONLY"
    || value.planningTargetCny !== INITIAL6_BUDGET_AUTHORITY.planningTargetCny || value.safetyMultiplier !== 1.2
    || value.monetaryLimitSemantics !== "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT") throw new Error("INITIAL6_COST_FORECAST_AUTHORITY_MISMATCH");
  const selected = value.candidatePlans.find((row) => hashCanonical(row) === hashCanonical(value.selectedPlan));
  if (!selected || !selected.feasible || selected.deepReferenceCount < 2 || selected.groupCount < 6
    || selected.safetyAdjustedP95Cny > value.planningTargetCny) throw new Error("INITIAL6_COST_FORECAST_SELECTED_PLAN_INVALID");
  for (const row of value.candidatePlans) {
    const expectedTrials = row.normalValidTrials + row.ordinaryValidArmTrials + row.deepValidArmTrials + row.technicalRetryReserveTrials;
    if (row.reservedTaskExecutingTrials !== expectedTrials || row.maxPaidCalls !== expectedTrials * value.maxProviderCallsPerTaskExecutingTrial
      || row.ordinaryValidArmTrials !== (row.groupCount - row.deepReferenceCount) * 5 * 2
      || row.deepValidArmTrials !== row.deepReferenceCount * 8 * 2
      || row.technicalRetryReserveTrials !== row.groupCount * value.technicalRetryLimitPerGroup) throw new Error("INITIAL6_COST_FORECAST_CALL_GRAPH_MISMATCH");
  }
}
