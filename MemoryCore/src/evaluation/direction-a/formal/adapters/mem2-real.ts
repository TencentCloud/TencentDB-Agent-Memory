import { hashCanonical } from "../core/canonical.js";
import type { CausalGroupId, CausalRowId, FrozenNormalUnit, StatisticalClusterId } from "../core/contracts.js";

export interface Mem2OfficialTask {
  causalGroupId: CausalGroupId;
  causalRowId: CausalRowId;
  componentId: StatisticalClusterId;
  frozenTaskState: unknown;
  taskAgentPrompt: string;
  evaluatorOnlyGoldHash: string;
}

export function buildMem2FrozenNormalUnit(task: Mem2OfficialTask, protocolHash: string, hashes: { frozenStateHash: string; recallSnapshotHash: string; targetSpecHash: string; normalArtifactHash: string }): FrozenNormalUnit {
  if (!task.taskAgentPrompt.trim()) throw new Error("Mem2 task-agent prompt is empty");
  if (task.taskAgentPrompt.includes(task.evaluatorOnlyGoldHash)) throw new Error("Evaluator-side gold leaked into Mem2 task-agent prompt");
  return { schemaVersion: "direction-a.current-formal.v1", causalGroupId: task.causalGroupId, causalRowId: task.causalRowId,
    statisticalClusterId: task.componentId, environmentId: "MEM2ACT", permission: "PILOT_TRAIN_DEV", protocolHash, ...hashes };
}

export function mem2AdapterProvenance(task: Mem2OfficialTask): string {
  return hashCanonical({ causalGroupId: task.causalGroupId, causalRowId: task.causalRowId, componentId: task.componentId,
    frozenTaskStateHash: hashCanonical(task.frozenTaskState), taskAgentPromptHash: hashCanonical(task.taskAgentPrompt), evaluatorOnlyGoldHash: task.evaluatorOnlyGoldHash });
}
