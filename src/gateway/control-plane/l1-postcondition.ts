import { createHash } from "node:crypto";
import type { IMemoryStore } from "../../core/store/types.js";
import { readStoredL1Record } from "./l1-store-read.js";

export async function assertL1RetrievalEffect(input: {
  store: IMemoryStore;
  id: string;
  content: string;
  deletedTargetIds: string[];
}): Promise<void> {
  const stored = await readStoredL1Record(input.store, input.id);
  if (!stored || digest(stored.content) !== digest(input.content))
    throw new Error(`retrieval postcondition failed for ${input.id}`);
  const survivors: string[] = [];
  for (const id of input.deletedTargetIds) {
    if (await readStoredL1Record(input.store, id)) survivors.push(id);
  }
  if (survivors.length > 0)
    throw new Error(`target delete postcondition failed: ${survivors.join(", ")}`);
}

const digest = (content: string) =>
  createHash("sha256").update(content).digest("hex");
