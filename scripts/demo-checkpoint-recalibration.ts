/**
 * Deterministic demo for issue #157: checkpoint counters that never decrease.
 *
 * Reproduces the drift and proves the fix end-to-end:
 *   1. Build a data dir with a KNOWN number of L1 records and L0 conversations.
 *   2. Write a checkpoint whose aggregate counters are inflated (as happens after
 *      `memory-cleaner` runs or JSONL files are trimmed — the old code only ever
 *      increments, so the counters over-report forever).
 *   3. Run CheckpointManager.recalibrate() and show the counters corrected back
 *      to the actual on-disk truth (both the store-backed and JSONL-fallback paths).
 *
 * Run: npm run demo:checkpoint-recalibrate
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointManager, type Checkpoint } from "../src/utils/checkpoint.js";

const printingLogger = {
  info: (msg: string) => console.log(`  ${msg}`),
  warn: (msg: string) => console.warn(`  ${msg}`),
};

/** Write `lineCount` non-empty JSONL lines (plus a blank line, which must be ignored). */
async function writeJsonl(dir: string, name: string, lineCount: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const lines = Array.from({ length: lineCount }, (_, i) => JSON.stringify({ id: `${name}-${i}` }));
  lines.push(""); // trailing blank line — recalibrate must not count it
  await fs.writeFile(path.join(dir, name), lines.join("\n"), "utf-8");
}

async function writeCheckpoint(dataDir: string, patch: Partial<Checkpoint>): Promise<void> {
  const cp = new CheckpointManager(dataDir);
  const current = await cp.read();
  await cp.write({ ...current, ...patch });
}

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-demo-"));

  try {
    // 1. Actual on-disk truth: 5 L1 records, 7 L0 conversations.
    await writeJsonl(path.join(dataDir, "records"), "2026-07-01.jsonl", 3);
    await writeJsonl(path.join(dataDir, "records"), "2026-07-02.jsonl", 2);
    await writeJsonl(path.join(dataDir, "conversations"), "s1.jsonl", 4);
    await writeJsonl(path.join(dataDir, "conversations"), "s2.jsonl", 3);
    const ACTUAL_L1 = 5;
    const ACTUAL_L0 = 7;

    // 2. Simulate drift: counters inflated far above reality (e.g. after cleanup).
    await writeCheckpoint(dataDir, { total_memories_extracted: 999, l0_conversations_count: 512 });

    const cp = new CheckpointManager(dataDir, printingLogger);
    const before = await cp.read();

    console.log("Checkpoint recalibration demo (issue #157)");
    console.log("==========================================");
    console.log(`Actual on-disk truth:  L1 records = ${ACTUAL_L1}, L0 conversations = ${ACTUAL_L0}`);
    console.log("");
    console.log("BEFORE (drifted / inflated counters):");
    console.log(`  total_memories_extracted = ${before.total_memories_extracted}`);
    console.log(`  l0_conversations_count   = ${before.l0_conversations_count}`);
    console.log("");

    // 3a. JSONL fallback path (no store configured).
    console.log("recalibrate() — JSONL fallback path:");
    await cp.recalibrate();
    const afterJsonl = await cp.read();
    console.log("");

    // 3b. Store-backed path (store reports the authoritative L0 count).
    console.log("recalibrate() — store-backed L0 path:");
    await writeCheckpoint(dataDir, { total_memories_extracted: 999, l0_conversations_count: 512 });
    await cp.recalibrate({ vectorStore: { countL0: () => ACTUAL_L0 } });
    const afterStore = await cp.read();
    console.log("");

    console.log("AFTER (recalibrated to actual):");
    console.log(`  total_memories_extracted = ${afterStore.total_memories_extracted}`);
    console.log(`  l0_conversations_count   = ${afterStore.l0_conversations_count}`);
    console.log("");

    const pass =
      afterJsonl.total_memories_extracted === ACTUAL_L1 &&
      afterJsonl.l0_conversations_count === ACTUAL_L0 &&
      afterStore.total_memories_extracted === ACTUAL_L1 &&
      afterStore.l0_conversations_count === ACTUAL_L0;

    console.log(`Result: ${pass ? "PASS ✅ counters corrected downward to on-disk truth" : "FAIL ❌"}`);
    console.log("");
    console.log("Interpretation:");
    console.log("- The old counters only ever increment, so trimming data left them over-reporting forever.");
    console.log("- recalibrate() rebuilds them from records/*.jsonl (L1) and the store / conversations/*.jsonl (L0).");
    console.log("- Blank trailing lines are ignored; failures preserve the previous value instead of crashing.");

    if (!pass) process.exitCode = 1;
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`demo failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
