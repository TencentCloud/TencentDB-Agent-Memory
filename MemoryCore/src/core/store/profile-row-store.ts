/**
 * Runtime narrowing for the profile-row surface.
 *
 * `IMemoryStore` declares the profile-row methods as optional because SQLite does
 * not implement them. A row-view filesystem (`ProfileRowStorageBackend`) needs all
 * of them, so selection code narrows with `isProfileRowStore()` and fails fast with
 * `BackendCapabilityError` when the configured store cannot serve rows.
 *
 * The static counterpart is `ProfileRowCapableStore` in types.ts — prefer taking
 * that type as a parameter so `tsc` rejects the bad combination before runtime.
 */

import type { IMemoryStore, ProfileRowCapableStore } from "./types.js";

/** The methods a store must expose to back a row-view filesystem. */
export const PROFILE_ROW_METHODS = [
  "pullProfiles",
  "queryProfilesByIds",
  "queryProfiles",
  "countProfiles",
  "syncProfiles",
  "deleteProfiles",
] as const;

export type ProfileRowMethod = (typeof PROFILE_ROW_METHODS)[number];

/** List the profile-row methods a store is missing (empty = fully capable). */
export function missingProfileRowMethods(store: IMemoryStore): ProfileRowMethod[] {
  return PROFILE_ROW_METHODS.filter(
    (m) => typeof (store as unknown as Record<string, unknown>)[m] !== "function",
  );
}

/** Narrow a store to one that can back a row-view filesystem. */
export function isProfileRowStore(store: IMemoryStore): store is ProfileRowCapableStore {
  return missingProfileRowMethods(store).length === 0;
}

/**
 * Raised when a resolved backend combination cannot work — e.g. a file plane of
 * `rowfs` on top of a data plane that has no profile rows.
 *
 * The message names the offending combination and how to fix it, because this
 * surfaces during wiring where the operator can still change configuration.
 */
export class BackendCapabilityError extends Error {
  readonly dbKind: string;
  readonly fsKind: string;
  readonly missing: readonly string[];

  constructor(params: { dbKind: string; fsKind: string; missing: readonly string[] }) {
    const { dbKind, fsKind, missing } = params;
    super(
      `Backend combination db="${dbKind}" x fs="${fsKind}" is not supported: ` +
        `the data plane does not provide profile rows ` +
        `(missing: ${missing.join(", ") || "none"}). ` +
        `Either switch the file plane to a non-row backend (FILE_STORE_MODE=local), ` +
        `or switch the data plane to one that stores profile rows (STORE_MODE=mongodb).`,
    );
    this.name = "BackendCapabilityError";
    this.dbKind = dbKind;
    this.fsKind = fsKind;
    this.missing = missing;
  }
}

/**
 * Narrow or throw. Use at wiring time so a bad configuration fails with a
 * diagnosable message instead of an undefined-is-not-a-function deep in a read.
 */
export function requireProfileRowStore(
  store: IMemoryStore,
  ctx: { dbKind: string; fsKind: string },
): ProfileRowCapableStore {
  const missing = missingProfileRowMethods(store);
  if (missing.length > 0) {
    throw new BackendCapabilityError({ ...ctx, missing });
  }
  return store as ProfileRowCapableStore;
}
