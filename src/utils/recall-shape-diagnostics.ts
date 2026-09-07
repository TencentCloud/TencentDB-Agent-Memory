/**
 * Lightweight, observation-only diagnostics for recall prompt-cache shape.
 * Snapshots the stable system context hash + dynamic recall placement so
 * operators can verify prefix stability and injectionMode effect from logs.
 * Never changes injection behaviour.
 */

import { createHash } from "node:crypto";

export interface RecallShapeSnapshot {
  /** Short hash of the stable system context (appendSystemContext); "-" when empty. */
  stableHash: string;
  /** Length of the stable block. */
  stableChars: number;
  /** Where dynamic recall landed this turn. */
  dynamicPlacement: "prepend" | "append" | "none";
  /** Length of the dynamic recall block. */
  dynamicChars: number;
}

export function describeRecallShape(
  result: { appendSystemContext?: string; prependContext?: string; appendContext?: string } | undefined,
): RecallShapeSnapshot {
  const stable = result?.appendSystemContext ?? "";
  const prepend = result?.prependContext?.length ?? 0;
  const append = result?.appendContext?.length ?? 0;
  return {
    stableHash: stable ? createHash("sha256").update(stable).digest("hex").slice(0, 8) : "-",
    stableChars: stable.length,
    dynamicPlacement: append > 0 ? "append" : prepend > 0 ? "prepend" : "none",
    dynamicChars: Math.max(prepend, append),
  };
}
