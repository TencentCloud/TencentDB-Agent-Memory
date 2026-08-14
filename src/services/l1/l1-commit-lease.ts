import type { Logger } from "../../core/types.js";
import { withStoreApplyLock } from "../../gateway/apply-executor/store-lock.js";

const COMMIT_LEASE_TTL_MS = 30_000;

export async function withL1CommitLease<T>(input: {
  dataDir: string;
  logger: Logger;
  commit: (assertOwned: () => void) => Promise<T>;
}): Promise<{ ok: true; value: T } | { ok: false }> {
  return await withStoreApplyLock(input.dataDir, async (assertOwned) => {
    assertOwned();
    const value = await input.commit(assertOwned);
    assertOwned();
    return { ok: true, value };
  }, { ttlMs: COMMIT_LEASE_TTL_MS });
}
