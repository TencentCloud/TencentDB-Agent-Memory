import type { IMemoryStore, IsolationFilter } from "./types.js";

export interface StrictDeleteL1Result {
  deletedIds: string[];
  error?: Error;
}

/**
 * Delete L1 records with strict error semantics while retaining successful ids
 * from the earlier part of a batch. Genuine misses remain non-errors.
 */
export async function deleteL1RecordsStrict(
  store: IMemoryStore,
  ids: string[],
  filter?: IsolationFilter,
): Promise<StrictDeleteL1Result> {
  const deletedIds: string[] = [];
  for (const id of ids) {
    try {
      if (await store.deleteL1(id, filter, { throwOnError: true })) {
        deletedIds.push(id);
      }
    } catch (err) {
      return {
        deletedIds,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
  return { deletedIds };
}
