import { randomUUID } from "node:crypto";

export const BRANCH_ENTRY_TYPE = "tdai-memory/branch@1";
export const BRANCH_HEADER = "x-tdai-memory-branch";

const SAFE_BRANCH_ID = /^[A-Za-z0-9._-]{1,128}$/;

interface BranchEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

function isBranchEntry(value: unknown): value is BranchEntryLike {
  return Boolean(
    value
      && typeof value === "object"
      && (value as BranchEntryLike).type === "custom"
      && (value as BranchEntryLike).customType === BRANCH_ENTRY_TYPE,
  );
}

function isValidBranchId(value: unknown): value is string {
  return typeof value === "string" && SAFE_BRANCH_ID.test(value);
}

/** Return the newest valid v1 marker visible from the active Pi tree branch. */
export function restoreBranchId(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isBranchEntry(entry) || !entry.data || typeof entry.data !== "object") continue;
    const branchId = (entry.data as { branchId?: unknown }).branchId;
    if (isValidBranchId(branchId)) return branchId;
  }
  return undefined;
}

export function createBranchId(): string {
  return `branch-${randomUUID()}`;
}

/** Branch isolation is enabled by default; 0/false/off/no explicitly disable it. */
export function branchIsolationEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
