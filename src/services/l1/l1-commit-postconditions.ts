import { createHash } from "node:crypto";
import { readAllMemoryRecords } from "../../core/record/l1-reader.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { IMemoryStore } from "../../core/store/types.js";
import { assertL1RetrievalEffect } from "../../gateway/control-plane/l1-postcondition.js";

export async function assertL1CommitPostconditions(input: {
  baseDir: string;
  record: MemoryRecord;
  targetIds: string[];
  vectorStore?: IMemoryStore;
}): Promise<void> {
  const digest = (content: string) =>
    createHash("sha256").update(content).digest("hex");
  const expected = digest(input.record.content);
  const jsonl = await readAllMemoryRecords(input.baseDir);
  const fileRecord = jsonl.findLast(({ id }) => id === input.record.id);
  if (!fileRecord || digest(fileRecord.content) !== expected)
    throw new Error(`JSONL postcondition failed for ${input.record.id}`);
  if (!input.vectorStore) return;
  await assertL1RetrievalEffect({
    store: input.vectorStore,
    id: input.record.id,
    content: input.record.content,
    deletedTargetIds: input.targetIds,
  });
}
