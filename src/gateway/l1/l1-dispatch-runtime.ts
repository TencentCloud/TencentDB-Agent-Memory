import fs from "node:fs/promises";
import path from "node:path";
import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import type {
  L1DispatchFailureKind,
  L1WorksetV1,
} from "../../core/record/l1-agent-types.js";
import type { Logger } from "../../core/types.js";
import { createRun, updateRun } from "../control-plane/run-repo.js";
import { claimRun } from "../control-plane/lease.js";
import { runOwnerId } from "../control-plane/owner.js";
import type { ResolvedRoleContract } from "../consolidation/role-contract-types.js";

export function serializeRoleContract(contract: ResolvedRoleContract): string {
  return JSON.stringify(contract, (_key, value: unknown) =>
    value instanceof Set ? [...value] : value,
  );
}

export async function openL1Run(input: {
  dataDir: string;
  scratchDir: string;
  runId: string;
  workset: L1WorksetV1;
  contract: ResolvedRoleContract;
  now: () => number;
}): Promise<{ owner: string; fence: number }> {
  const nowMs = input.now();
  const contractJson = serializeRoleContract(input.contract);
  await fs.mkdir(path.join(input.scratchDir, "out"), { recursive: true });
  await fs.mkdir(path.join(input.scratchDir, "input"), { recursive: true });
  await fs.writeFile(
    path.join(input.scratchDir, "input", "workset.json"),
    JSON.stringify(input.workset, null, 2),
  );
  createRun(
    input.dataDir,
    {
      runId: input.runId,
      assignmentId: input.workset.assignmentId,
      roleId: input.contract.role,
      contractHash: input.contract.contractHash,
      contractJson,
      binding: JSON.stringify(input.contract.binding),
      inputDigest: digestL1Artifact(input.workset),
      scratchPath: input.scratchDir,
      reason: "l1-extraction",
    },
    new Date(nowMs).toISOString(),
  );
  const owner = runOwnerId(process.pid);
  const claim = claimRun(input.dataDir, input.runId, owner, {
    nowMs,
    ttlMs: Math.max(input.contract.timeoutMs * 3, 60_000),
    state: "running",
  });
  if (!claim.ok) throw new Error(`failed to claim L1 run: ${claim.reason}`);
  return { owner, fence: claim.fence };
}

export function failL1Run(
  dataDir: string,
  runId: string,
  errorKind: L1DispatchFailureKind,
  now: () => number,
): void {
  const nowIso = new Date(now()).toISOString();
  updateRun(
    dataDir,
    runId,
    {
      state: "failed",
      errorClass: errorKind,
      finishedAt: nowIso,
    },
    nowIso,
  );
}
