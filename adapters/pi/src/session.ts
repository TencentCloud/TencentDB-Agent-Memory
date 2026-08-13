import { randomUUID } from "node:crypto";

export const BRANCH_ENTRY_TYPE = "tdai-memory/branch@1";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

interface BranchEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

function isBranchEntry(value: unknown): value is BranchEntryLike {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as BranchEntryLike).type === "custom" &&
      (value as BranchEntryLike).customType === BRANCH_ENTRY_TYPE,
  );
}

function validBranchId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

/** Recover only the marker visible from Pi's currently selected tree branch. */
export function restoreBranchId(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isBranchEntry(entry) || !entry.data || typeof entry.data !== "object") continue;
    const branchId = (entry.data as { branchId?: unknown }).branchId;
    if (validBranchId(branchId)) return branchId;
  }
  return undefined;
}

export function createBranchId(): string {
  return `branch-${randomUUID()}`;
}

function safeSegment(value: string): string {
  const result = value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return result || "unknown";
}

/**
 * A tree marker distinguishes siblings within one Pi session. Forks already
 * receive a new Pi session id, so the first segment preserves that boundary.
 */
export function memorySessionId(piSessionId: string, branchId: string): string {
  return `pi-${safeSegment(piSessionId)}-${safeSegment(branchId)}`;
}
