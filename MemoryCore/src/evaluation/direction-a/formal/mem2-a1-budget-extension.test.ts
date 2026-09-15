import { describe, expect, it } from "vitest";
import { drawCalA1AuditSample, freezeAlphaPlan, freezePredictionPopulation }
  from "./analysis/mem2-a1.js";
import { FROZEN_DESIGN_BINDING } from "./config/frozen-design.js";
import { hashCanonical } from "./core/canonical.js";
import { planCost, type BudgetInput } from "./planning/mem2-scale-planner-v2.js";

const h="a".repeat(64);
const rows=Array.from({length:6},(_,i)=>({componentId:`c${i}`,statisticalClusterId:`c${i}`,
  decisions:{P30:i<3},baselineAccepted:false}));
const population=freezePredictionPopulation({purpose:"CAL",environment:"Mem2",rows,
  policies:[{policyId:"P30",predictionVersion:"v1",policyHash:h,threshold:.5,targetCoverage:30}],
  completeQualifiedPartitionHash:hashCanonical(rows.map(row=>({componentId:row.componentId,statisticalClusterId:row.statisticalClusterId}))),
  authorityHashes:{a:h},frozenDesignBindingHash:FROZEN_DESIGN_BINDING.contentHash,sourceSnapshotCodeHash:h,
  profileHash:h,protocolHash:h,verifierHash:h,cheapXFreezeHash:h,preY:true});
const budget:BudgetInput={ledgerHash:h,registryHash:h,reservationAuthorityHash:h,alreadyPaid:10,protectedExposure:3,
  smokeReserve:0,technicalReserve:0,downstreamReservedCost:15,activeDownstreamReserveFloor:15,
  normalExpected:0,normalP95:0,fixed4Expected:.1,max5P95:1,normalAlreadyPurchasedIds:rows.map(row=>row.componentId),
  freshComponentIds:rows.map(row=>row.componentId),hardCapCny:53,authorizedExtensionMaxCny:15,maxExtendedHardCapCny:68};

describe("Mem2 A1 budget extension and one-time CAL SRSWOR",()=>{
  it("uses the exact minimum extension without reducing the downstream reserve",()=>{
    const cost=planCost(budget,population,6);
    expect(cost.minimumRequiredHardCapCny).toBeCloseTo(35.2);
    expect(cost.requiredExtensionCny).toBe(0);
    expect(cost.effectiveHardCapCny).toBe(53);
    expect(cost.downstream_reserved_cost).toBe(15);
    expect(cost.new_incremental_NORMAL_cheapX_count).toBe(0);
  });

  it("distinguishes base-cap and authorized-extension legality",()=>{
    const extended={...budget,alreadyPaid:30,protectedExposure:8};
    const cost=planCost(extended,population,6);
    expect(cost.legalUnderBaseHardCap).toBe(false);
    expect(cost.requiredExtensionCny).toBeCloseTo(7.2);
    expect(cost.effectiveHardCapCny).toBeCloseTo(60.2);
    expect(cost.legalUnderAuthorizedExtension).toBe(true);
    expect(cost.legal).toBe(true);
  });

  it("freezes an exact deterministic V/G-only sample with no replacement",()=>{
    const plans=[freezeAlphaPlan(population,"P30","V",3),freezeAlphaPlan(population,"P30","G",3)];
    const a=drawCalA1AuditSample(population,plans,["P30"],"seed-once");
    const b=drawCalA1AuditSample(population,plans,["P30"],"seed-once");
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.selectedIds).toHaveLength(3);
    expect(new Set(a.selectedIds).size).toBe(3);
    expect(a.sampleDrawn).toBe(true);
    expect(a.calCausalY).toBe(0);
    expect(a.testCausalY).toBe(0);
  });

  it("rejects incomplete pre-draw alpha bindings",()=>{
    expect(()=>drawCalA1AuditSample(population,[freezeAlphaPlan(population,"P30","V",3)],["P30"],"seed"))
      .toThrow("CAL_A1_EXACT_V_G_ALPHA_PLANS_REQUIRED");
  });
});
