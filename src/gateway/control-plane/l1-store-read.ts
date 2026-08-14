import type { IMemoryStore, L1RecordRow } from "../../core/store/types.js";

/** Backend-neutral exact lookup used by agentic L1 recovery. */
export async function readStoredL1Record(
  store: IMemoryStore,
  id: string,
): Promise<L1RecordRow | null> {
  return await store.getL1ById(id);
}
