import { hashCanonical } from "./canonical.js";
import type { BudgetAuthorizationManifest } from "./contracts.js";

export function authorizationContentHash(authorization: Omit<BudgetAuthorizationManifest, "contentHash">): string {
  return hashCanonical(authorization);
}

/** The only semantic validator for the current-formal paid-run authorization. */
export function assertBudgetAuthorizationManifest(
  authorization: BudgetAuthorizationManifest,
  expectedProtocolHash: string,
  expectedExecutionManifestHash: string,
  planningTargetCny: number,
): void {
  const { contentHash, ...body } = authorization;
  if (authorizationContentHash(body) !== contentHash) throw new Error("Budget authorization content/self hash mismatch");
  if (authorization.schemaVersion !== "direction-a.current-formal.budget-authorization.v6") throw new Error("Budget authorization schema mismatch");
  if (!authorization.authorizationId || !authorization.approvedBy || !authorization.approvedAt) throw new Error("Budget authorization metadata is incomplete");
  if (authorization.protocolHash !== expectedProtocolHash) throw new Error("Budget authorization protocol hash mismatch");
  if (authorization.executionManifestHash !== expectedExecutionManifestHash) throw new Error("Budget authorization execution manifest hash mismatch");
  if (authorization.allowRealAgentCalls !== true) throw new Error("Budget authorization does not explicitly allow real Agent calls");
  if (!Number.isInteger(authorization.maxPaidCalls) || authorization.maxPaidCalls < 1
    || !Number.isFinite(authorization.planningTargetCny) || !(authorization.planningTargetCny > 0)) {
    throw new Error("Budget authorization limits are invalid");
  }
  if (!Number.isFinite(planningTargetCny) || planningTargetCny <= 0 || authorization.planningTargetCny !== planningTargetCny
    || authorization.monetaryLimitSemantics !== "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT"
    || authorization.allowCompleteGroupOvershoot !== true) {
    throw new Error(`Budget authorization differs from the frozen CNY${planningTargetCny} planning-target semantics`);
  }
}
