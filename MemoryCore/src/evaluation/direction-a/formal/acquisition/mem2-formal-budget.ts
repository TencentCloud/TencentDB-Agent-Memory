import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hashCanonical } from "../core/canonical.js";

export interface Mem2FormalBudgetLedgerState {
  schemaVersion: "direction-a.mem2-source.global-budget.v3" | "direction-a.mem2-source.global-budget.v4"
    | "direction-a.mem2-source.global-budget.v5";
  hardCapCny: number;
  budgetExpansionAuthorityHash?: string;
  a1BudgetExtensionAmendmentSha256?: string;
  observedUsageAccountedCny: number;
  providerBillingUnknownReserveCny: number;
  downstreamFormalReserveFloorCny: number;
  activeReservations: Array<{ reservationId: string; workerId: string; unitId: string; phase: string; amountCny: number;
    authorizationHash?: string; populationHash?: string; commit?: string; tree?: string; policyFamilyHash?: string;
    modelHash?: string; outputRoot?: string; journalRoot?: string; rawArtifactRoot?: string; createdAt: string }>;
  completedReservations: Array<Record<string, unknown>>;
  predecessorStateHash: string;
  timeoutRepairAuthorityHash: string;
  contentHash: string;
}

export interface Mem2StageReservationBinding {
  workerId:string;unitId:string;phase:"MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY";amountCny:number;
  authorizationHash:string;populationHash:string;commit:string;tree:string;policyFamilyHash:string;modelHash:string;
  outputRoot:string;journalRoot:string;rawArtifactRoot:string;
}
export type Mem2StageReservationResult={status:"FRESH_RESERVED"|"ACTIVE_REUSED"|"COMPLETED_REUSED";reservationId:string;
  completedReservation?:Record<string,unknown>};

export function assertMem2FormalBudgetLedgerState(state: Mem2FormalBudgetLedgerState): void {
  const { contentHash, ...body } = state;
  const active = state.activeReservations.reduce((sum, row) => sum + row.amountCny, 0);
  const legacy = state.schemaVersion === "direction-a.mem2-source.global-budget.v3"
    && state.hardCapCny === 30 && state.budgetExpansionAuthorityHash === undefined;
  const expanded = state.schemaVersion === "direction-a.mem2-source.global-budget.v4"
    && state.hardCapCny === 53 && /^[a-f0-9]{64}$/.test(state.budgetExpansionAuthorityHash ?? "");
  const a1Extended=state.schemaVersion==="direction-a.mem2-source.global-budget.v5"&&state.hardCapCny>=53&&state.hardCapCny<=68
    &&/^[a-f0-9]{64}$/.test(state.budgetExpansionAuthorityHash??"")
    &&/^[a-f0-9]{64}$/.test(state.a1BudgetExtensionAmendmentSha256??"");
  if (hashCanonical(body) !== contentHash || (!legacy && !expanded&&!a1Extended) || state.observedUsageAccountedCny < 0
    || state.providerBillingUnknownReserveCny < 0 || state.downstreamFormalReserveFloorCny < 0
    || state.observedUsageAccountedCny + state.providerBillingUnknownReserveCny + active
      + state.downstreamFormalReserveFloorCny > state.hardCapCny + 1e-12) throw new Error("MEM2_FORMAL_BUDGET_LEDGER_INVALID");
}

export function buildA1ExtendedBudgetLedger(predecessor:Mem2FormalBudgetLedgerState,input:{
  effectiveHardCapCny:number;a1BudgetExtensionAmendmentSha256:string;minimumRequiredHardCapCny:number;
}):Mem2FormalBudgetLedgerState{
  assertMem2FormalBudgetLedgerState(predecessor);
  if(predecessor.schemaVersion!=="direction-a.mem2-source.global-budget.v4"||predecessor.hardCapCny!==53
    ||predecessor.activeReservations.length!==0||input.effectiveHardCapCny!==input.minimumRequiredHardCapCny
    ||input.effectiveHardCapCny<53||input.effectiveHardCapCny>68
    ||!/^[a-f0-9]{64}$/.test(input.a1BudgetExtensionAmendmentSha256))throw new Error("MEM2_A1_BUDGET_EXTENSION_LEDGER_INVALID");
  const {contentHash:_old,schemaVersion:_schema,hardCapCny:_cap,predecessorStateHash:_predecessor,...rest}=predecessor;
  const body={...rest,schemaVersion:"direction-a.mem2-source.global-budget.v5" as const,
    hardCapCny:input.effectiveHardCapCny,a1BudgetExtensionAmendmentSha256:input.a1BudgetExtensionAmendmentSha256,
    predecessorStateHash:predecessor.contentHash};
  const next={...body,contentHash:hashCanonical(body)};
  assertMem2FormalBudgetLedgerState(next);
  return next;
}

async function lock(path: string): Promise<ReturnType<typeof open>> {
  await mkdir(dirname(path), { recursive: true });
  try { return await open(path, "wx"); }
  catch (error) { throw new Error(`MEM2_FORMAL_BUDGET_LEDGER_LOCKED:${String(error)}`); }
}

export class Mem2FormalBudgetLedger {
  readonly statePath: string;
  readonly lockPath: string;
  constructor(path: string) { this.statePath = resolve(path); this.lockPath = `${this.statePath}.lock`; }

  async read(): Promise<Mem2FormalBudgetLedgerState> {
    const state = JSON.parse(await readFile(this.statePath, "utf8")) as Mem2FormalBudgetLedgerState;
    assertMem2FormalBudgetLedgerState(state);
    return state;
  }

  private async write(state: Mem2FormalBudgetLedgerState): Promise<void> {
    const { contentHash: _old, ...body } = state;
    const next = { ...body, contentHash: hashCanonical(body) };
    assertMem2FormalBudgetLedgerState(next);
    const temporary = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.statePath);
  }

  async reserve(input: { workerId: string; unitId: string; amountCny: number; authorizationHash: string;
    phase?: "POST_ADAPTER_MINIMUM_SMOKE" | "MEM2_FORMAL_TRAIN_DEV" | "MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY"
      | "MEM2_DEV_SUPPORT_AUGMENTATION_V1" | "MEM2_CAL_A1_CAUSAL_AUDIT" }): Promise<string> {
    if (!input.workerId || !input.unitId || !input.authorizationHash || !(input.amountCny > 0)) throw new Error("MEM2_FORMAL_RESERVATION_INVALID");
    const handle = await lock(this.lockPath);
    try {
      const state = await this.read();
      if (state.activeReservations.some((row) => row.unitId === input.unitId)
        || state.completedReservations.some((row) => row.unitId === input.unitId)) throw new Error(`MEM2_FORMAL_UNIT_ALREADY_ACCOUNTED:${input.unitId}`);
      const reservationId = `mem2-formal-${hashCanonical({ ...input, predecessor: state.contentHash }).slice(0, 20)}`;
      state.activeReservations.push({ reservationId, workerId: input.workerId, unitId: input.unitId,
        phase: input.phase ?? "MEM2_FORMAL_TRAIN_DEV", amountCny: input.amountCny,
        authorizationHash:input.authorizationHash,createdAt: new Date().toISOString() });
      await this.write(state);
      return reservationId;
    } finally { await handle.close(); await unlink(this.lockPath).catch(() => undefined); }
  }

  async reserveOrResumeStage(input:Mem2StageReservationBinding):Promise<Mem2StageReservationResult>{
    const requiredHashes=[input.authorizationHash,input.populationHash,input.commit,input.tree,input.policyFamilyHash,input.modelHash];
    if(!input.workerId||!input.unitId||input.phase!=="MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY"||!(input.amountCny>0)
      ||requiredHashes.some(value=>!(/^[a-f0-9]{40}$/.test(value)||/^[a-f0-9]{64}$/.test(value)))
      ||![input.outputRoot,input.journalRoot,input.rawArtifactRoot].every(Boolean))throw new Error("MEM2_CAL_STAGE_RESERVATION_INVALID");
    const handle=await lock(this.lockPath);
    try{
      const state=await this.read();
      const expected={workerId:input.workerId,unitId:input.unitId,phase:input.phase,amountCny:input.amountCny,
        authorizationHash:input.authorizationHash,populationHash:input.populationHash,commit:input.commit,tree:input.tree,
        policyFamilyHash:input.policyFamilyHash,modelHash:input.modelHash,outputRoot:resolve(input.outputRoot),
        journalRoot:resolve(input.journalRoot),rawArtifactRoot:resolve(input.rawArtifactRoot)};
      const assertSame=(row:Record<string,unknown>)=>{
        for(const [key,value] of Object.entries(expected))if(row[key]!==value)throw new Error(`MEM2_CAL_STAGE_RESERVATION_BINDING_MISMATCH:${key}`);
      };
      const active=state.activeReservations.find(row=>row.unitId===input.unitId||row.phase===input.phase&&row.workerId===input.workerId);
      if(active){assertSame(active as unknown as Record<string,unknown>);return {status:"ACTIVE_REUSED",reservationId:active.reservationId};}
      const completed=state.completedReservations.find(row=>row.unitId===input.unitId||row.phase===input.phase&&row.workerId===input.workerId);
      if(completed){assertSame(completed);return {status:"COMPLETED_REUSED",reservationId:String(completed.reservationId),completedReservation:completed};}
      const reservationId=`mem2-formal-${hashCanonical({...expected,predecessor:state.contentHash}).slice(0,20)}`;
      state.activeReservations.push({...expected,reservationId,createdAt:new Date().toISOString()});
      await this.write(state);
      return {status:"FRESH_RESERVED",reservationId};
    }finally{await handle.close();await unlink(this.lockPath).catch(()=>undefined);}
  }

  async reconcile(input: { reservationId: string; observedUsageCostCny: number; paidLogicalCalls: number; unknownUsageCalls: number }): Promise<void> {
    if (!(input.observedUsageCostCny >= 0) || !Number.isInteger(input.paidLogicalCalls) || input.paidLogicalCalls < 0
      || !Number.isInteger(input.unknownUsageCalls) || input.unknownUsageCalls < 0 || input.unknownUsageCalls > input.paidLogicalCalls) {
      throw new Error("MEM2_FORMAL_RECONCILIATION_INVALID");
    }
    const handle = await lock(this.lockPath);
    try {
      const state = await this.read(); const index = state.activeReservations.findIndex((row) => row.reservationId === input.reservationId);
      if (index < 0) throw new Error(`MEM2_FORMAL_RESERVATION_NOT_ACTIVE:${input.reservationId}`);
      const [reservation] = state.activeReservations.splice(index, 1);
      const unknownAdded = input.unknownUsageCalls ? Math.max(0, reservation.amountCny - input.observedUsageCostCny) : 0;
      state.observedUsageAccountedCny += input.observedUsageCostCny;
      state.providerBillingUnknownReserveCny += unknownAdded;
      state.completedReservations.push({ ...reservation, reservedCny: reservation.amountCny,
        observedUsageCostCny: input.observedUsageCostCny, providerBillingUnknownReserveAddedCny: unknownAdded,
        paidLogicalCalls: input.paidLogicalCalls, unknownUsageCalls: input.unknownUsageCalls, completedAt: new Date().toISOString() });
      await this.write(state);
    } finally { await handle.close(); await unlink(this.lockPath).catch(() => undefined); }
  }
}
