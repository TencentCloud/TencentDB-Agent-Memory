import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CheckpointManager } from "./checkpoint.js";
import { countL1JsonlLines, countL1JsonlLinesSince } from "../core/record/l1-reader.js";
import { countL0JsonlStats } from "../core/conversation/l0-recorder.js";

describe("CheckpointManager.recalibrate", () => {
  let dataDirs: string[] = [];

  beforeEach(() => {
    dataDirs = [];
  });

  afterEach(async () => {
    await Promise.all(dataDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeDataDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
    dataDirs.push(dir);
    return dir;
  }

  it("overwrites the four calibrated counters with the supplied actual values", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // Seed some non-zero initial state via existing public API so the file
    // exists with real values, then recalibrate to authoritative counts.
    await mgr.markL1ExtractionComplete("sess-a", 5, 1000, "scene-x");

    const result = await mgr.recalibrate({
      totalMemoriesExtracted: 42,
      l0ConversationsCount: 7,
      totalProcessed: 100,
      memoriesSinceLastPersona: 13,
    });

    // Four calibrated fields reflect the supplied actual values.
    expect(result.was.total_memories_extracted).toBe(5);
    expect(result.was.l0_conversations_count).toBe(0);
    expect(result.was.total_processed).toBe(0);
    expect(result.was.memories_since_last_persona).toBe(5);

    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(7);
    expect(cp.total_processed).toBe(100);
    expect(cp.memories_since_last_persona).toBe(13);
  });

  it("returns the pre-recalibration values in `was` for caller logging", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // Establish known prior values via captureAtomically (sets total_processed
    // and l0_conversations_count) and markL1ExtractionComplete (sets the
    // memory counters).
    await mgr.captureAtomically("sess-b", undefined, async () => ({
      maxTimestamp: 2000,
      messageCount: 10,
    }));
    await mgr.markL1ExtractionComplete("sess-b", 3, 2000, "scene-y");

    const result = await mgr.recalibrate({
      totalMemoriesExtracted: 999,
      l0ConversationsCount: 999,
      totalProcessed: 999,
      memoriesSinceLastPersona: 999,
    });

    // was must snapshot the values that existed BEFORE this recalibrate call.
    expect(result.was).toEqual({
      total_memories_extracted: 3,
      l0_conversations_count: 1,
      total_processed: 10,
      memories_since_last_persona: 3,
    });
  });

  it("is idempotent: repeated calls with the same values leave state unchanged", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    const actual = {
      totalMemoriesExtracted: 50,
      l0ConversationsCount: 8,
      totalProcessed: 200,
      memoriesSinceLastPersona: 20,
    };

    await mgr.recalibrate(actual);
    const first = await mgr.recalibrate(actual);

    // Second call's `was` equals the values set by the first call.
    expect(first.was).toEqual({
      total_memories_extracted: 50,
      l0_conversations_count: 8,
      total_processed: 200,
      memories_since_last_persona: 20,
    });

    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(50);
    expect(cp.l0_conversations_count).toBe(8);
    expect(cp.total_processed).toBe(200);
    expect(cp.memories_since_last_persona).toBe(20);
  });

  it("does not touch unrelated fields (persona, scenes, cursors, per-session state)", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // Populate unrelated fields via existing public methods.
    await mgr.setPersonaUpdateRequest("drift-detected");
    await mgr.incrementScenesProcessed();
    await mgr.markL1ExtractionComplete("sess-c", 4, 3000, "scene-z");
    await mgr.captureAtomically("sess-c", undefined, async () => ({
      maxTimestamp: 3500,
      messageCount: 6,
    }));

    // Snapshot the unrelated fields before recalibrate.
    const before = await mgr.read();
    const beforePersonaAt = before.last_persona_at;
    const beforePersonaTime = before.last_persona_time;
    const beforeRequestPersona = before.request_persona_update;
    const beforePersonaReason = before.persona_update_reason;
    const beforeScenes = before.scenes_processed;
    const beforeLastCapturedTs = before.last_captured_timestamp;
    const beforeRunner = before.runner_states["sess-c"];
    const beforePipeline = before.pipeline_states["sess-c"];

    await mgr.recalibrate({
      totalMemoriesExtracted: 77,
      l0ConversationsCount: 9,
      totalProcessed: 300,
      memoriesSinceLastPersona: 0,
    });

    const after = await mgr.read();
    // Unrelated global fields are untouched.
    expect(after.last_persona_at).toBe(beforePersonaAt);
    expect(after.last_persona_time).toBe(beforePersonaTime);
    expect(after.request_persona_update).toBe(beforeRequestPersona);
    expect(after.persona_update_reason).toBe(beforePersonaReason);
    expect(after.scenes_processed).toBe(beforeScenes);
    expect(after.last_captured_timestamp).toBe(beforeLastCapturedTs);
    // Per-session split state is untouched.
    expect(after.runner_states["sess-c"]).toEqual(beforeRunner);
    expect(after.pipeline_states["sess-c"]).toEqual(beforePipeline);
    // Only the four calibrated fields changed.
    expect(after.total_memories_extracted).toBe(77);
    expect(after.l0_conversations_count).toBe(9);
    expect(after.total_processed).toBe(300);
    expect(after.memories_since_last_persona).toBe(0);
  });
});

// ============================================================
// Integration tests: real JSONL files → drift reproduction → recalibrate
// Covers drift reproduction, stale-row counting, persona consistency,
// degraded fallback, and empty-last_persona_time semantics.
// Uses the real filesystem (temp dirs) — no store mocks — so the
// recalibrate path is exercised end-to-end against actual JSONL shards.
// ============================================================

/** Build a minimal valid L1 MemoryRecord JSONL line with the given updatedAt. */
function l1Line(opts: {
  id?: string;
  updatedAt: string;
  createdAt?: string;
  sessionKey?: string;
  sessionId?: string;
}): string {
  return JSON.stringify({
    id: opts.id ?? "mem-1",
    content: "some memory content",
    type: "episodic",
    priority: 50,
    scene_name: "scene-default",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: opts.createdAt ?? opts.updatedAt,
    updatedAt: opts.updatedAt,
    sessionKey: opts.sessionKey ?? "sess-int",
    sessionId: opts.sessionId ?? "sid-int",
  });
}

/** Build a minimal valid L0MessageRecord JSONL line with the given recordedAt. */
function l0Line(opts: {
  recordedAt: string;
  id?: string;
  role?: "user" | "assistant";
  sessionKey?: string;
  sessionId?: string;
}): string {
  return JSON.stringify({
    sessionKey: opts.sessionKey ?? "sess-int",
    sessionId: opts.sessionId ?? "sid-int",
    recordedAt: opts.recordedAt,
    id: opts.id ?? "msg-1",
    role: opts.role ?? "user",
    content: "hello",
    timestamp: Date.parse(opts.recordedAt) || 0,
  });
}

describe("CheckpointManager integration: drift → recalibrate", () => {
  let dataDirs: string[] = [];

  beforeEach(() => {
    dataDirs = [];
  });

  afterEach(async () => {
    await Promise.all(dataDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function makeDataDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-int-"));
    dataDirs.push(dir);
    return dir;
  }

  /** Write the given string content to <baseDir>/records/<fileName>. */
  async function writeRecords(baseDir: string, fileName: string, content: string): Promise<void> {
    const dir = path.join(baseDir, "records");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), content, "utf-8");
  }

  /** Write the given string content to <baseDir>/conversations/<fileName>. */
  async function writeConversations(baseDir: string, fileName: string, content: string): Promise<void> {
    const dir = path.join(baseDir, "conversations");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), content, "utf-8");
  }

  // ── Acceptance 1: drift end-to-end reproduction + correction ──────────────
  it("reproduces counter drift and corrects all four fields to authoritative JSONL counts", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // --- Seed real JSONL data ---
    // records/*.jsonl: 3 L1 memory lines across two daily shards.
    await writeRecords(
      dir,
      "2026-06-24.jsonl",
      l1Line({ id: "m1", updatedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        l1Line({ id: "m2", updatedAt: "2026-06-24T11:00:00.000Z" }) +
        "\n",
    );
    await writeRecords(
      dir,
      "2026-06-25.jsonl",
      l1Line({ id: "m3", updatedAt: "2026-06-25T09:00:00.000Z" }) + "\n",
    );

    // conversations/*.jsonl: 2 distinct capture events (distinct recordedAt),
    // 4 physical message lines.
    await writeConversations(
      dir,
      "2026-06-24.jsonl",
      l0Line({ recordedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        l0Line({ recordedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        l0Line({ recordedAt: "2026-06-24T11:30:00.000Z" }) +
        "\n" +
        l0Line({ recordedAt: "2026-06-24T11:30:00.000Z" }) +
        "\n",
    );

    // --- Simulate drift: inflate counters far above actual JSONL reality ---
    // Use the public mutating API to push the counters to virtual-high values
    // (mimicking a real drift where cleaners deleted data but counters never
    // decremented). markL1ExtractionComplete += memoriesExtracted and
    // memories_since_last_persona; captureAtomically += total_processed and
    // l0_conversations_count.
    await mgr.markL1ExtractionComplete("sess-int", 999, 0, "scene-x");
    await mgr.captureAtomically("sess-int", undefined, async () => ({
      maxTimestamp: 999999,
      messageCount: 999,
    }));

    const drifted = await mgr.read();
    // Sanity: drift is in place before recalibrate.
    expect(drifted.total_memories_extracted).toBe(999);
    expect(drifted.memories_since_last_persona).toBe(999);
    expect(drifted.total_processed).toBe(999);
    expect(drifted.l0_conversations_count).toBe(1); // one captureAtomically call

    // --- Compute authoritative truth from the real JSONL files ---
    const totalMemoriesExtracted = await countL1JsonlLines(dir);
    const l0Stats = await countL0JsonlStats(dir);
    const memoriesSinceLastPersona = await countL1JsonlLinesSince(
      dir,
      drifted.last_persona_time ?? "",
    );
    // total_processed authoritative source is store.countL0(); store is not
    // available in this test, so we use the JSONL-lines fallback (same value
    // the startup degraded path in index.ts picks).
    const totalProcessed = l0Stats.lines;

    expect(totalMemoriesExtracted).toBe(3);
    expect(l0Stats.captures).toBe(2);
    expect(l0Stats.lines).toBe(4);
    expect(memoriesSinceLastPersona).toBe(3); // last_persona_time is "" → all lines

    // --- Recalibrate against the authoritative truth ---
    const { was } = await mgr.recalibrate({
      totalMemoriesExtracted,
      l0ConversationsCount: l0Stats.captures,
      totalProcessed,
      memoriesSinceLastPersona,
    });

    // `was` reflects the drifted (pre-recalibrate) values.
    expect(was).toEqual({
      total_memories_extracted: 999,
      l0_conversations_count: 1,
      total_processed: 999,
      memories_since_last_persona: 999,
    });

    // After recalibrate, all four fields equal the JSONL truth — no longer 999.
    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(3);
    expect(cp.l0_conversations_count).toBe(2);
    expect(cp.total_processed).toBe(4);
    expect(cp.memories_since_last_persona).toBe(3);
  });

  // ── Acceptance 2: update/merge stale rows are counted (not deduped) ────────
  it("counts update/merge stale rows in total_memories_extracted (JSONL is append-only, not deduped)", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // Simulate the JSONL append-only trail left by an update/merge sequence:
    // the SAME id appears multiple times (the older rows are "stale rows"
    // that store-side dedup would remove, but JSONL keeps them because it is
    // append-only). countL1JsonlLines must count every physical line.
    await writeRecords(
      dir,
      "2026-06-24.jsonl",
      // initial store
      l1Line({ id: "mem-x", updatedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        // update of mem-x appends a new line (same id, newer updatedAt)
        l1Line({ id: "mem-x", updatedAt: "2026-06-24T11:00:00.000Z" }) +
        "\n" +
        // merge of mem-x + mem-y appends another line (same id mem-x)
        l1Line({ id: "mem-x", updatedAt: "2026-06-24T12:00:00.000Z" }) +
        "\n" +
        // a fresh store, unrelated
        l1Line({ id: "mem-y", updatedAt: "2026-06-24T12:30:00.000Z" }) +
        "\n",
    );

    const totalCount = await countL1JsonlLines(dir);
    // 4 physical lines — the 3 stale rows for mem-x are NOT deduped.
    expect(totalCount).toBe(4);

    // Recalibrate pushes the (dedup-agnostic) physical line count into the
    // counter, so the counter reflects the JSONL append-only semantics
    // (matching the field's accumulation semantics — each append counts once).
    await mgr.recalibrate({
      totalMemoriesExtracted: totalCount,
      l0ConversationsCount: 0,
      totalProcessed: 0,
      memoriesSinceLastPersona: totalCount,
    });

    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(4);
    expect(cp.memories_since_last_persona).toBe(4);
  });

  // ── Acceptance 7: persona consistency — memories_since_last_persona matches JSONL ──
  it("keeps memories_since_last_persona consistent with the JSONL truth after recalibrate", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    const lastPersonaTime = "2026-06-24T12:00:00.000Z";
    // 2 rows older than (or equal to) last_persona_time, 3 rows strictly after.
    await writeRecords(
      dir,
      "2026-06-24.jsonl",
      l1Line({ id: "old-1", updatedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        l1Line({ id: "old-2", updatedAt: "2026-06-24T11:00:00.000Z" }) +
        "\n" +
        l1Line({ id: "eq", updatedAt: "2026-06-24T12:00:00.000Z" }) + // equal, not counted (strict >)
        "\n" +
        l1Line({ id: "new-1", updatedAt: "2026-06-24T13:00:00.000Z" }) +
        "\n" +
        l1Line({ id: "new-2", updatedAt: "2026-06-24T14:00:00.000Z" }) +
        "\n" +
        l1Line({ id: "new-3", updatedAt: "2026-06-25T09:00:00.000Z" }) +
        "\n",
    );

    // Set checkpoint.last_persona_time via the public persona API so the
    // stored value is realistic. markPersonaGenerated also zeroes
    // memories_since_last_persona — we then re-inflate it to simulate drift.
    await mgr.markPersonaGenerated(100);
    const afterPersona = await mgr.read();
    expect(afterPersona.last_persona_time).toBeTruthy();
    expect(afterPersona.memories_since_last_persona).toBe(0);

    // Simulate drift: memories_since_last_persona was inflated to a virtual-high
    // value (e.g. counter never decremented after cleaner deleted old rows).
    await mgr.recalibrate({
      totalMemoriesExtracted: 999,
      l0ConversationsCount: 0,
      totalProcessed: 0,
      memoriesSinceLastPersona: 999,
    });
    const drifted = await mgr.read();
    expect(drifted.memories_since_last_persona).toBe(999);

    // Authoritative truth: rows strictly newer than last_persona_time.
    const since = await countL1JsonlLinesSince(dir, lastPersonaTime);
    expect(since).toBe(3); // new-1, new-2, new-3

    // Recalibrate memories_since_last_persona to the JSONL truth.
    await mgr.recalibrate({
      totalMemoriesExtracted: 999, // unchanged for this test's focus
      l0ConversationsCount: 0,
      totalProcessed: 0,
      memoriesSinceLastPersona: since,
    });

    const cp = await mgr.read();
    // memories_since_last_persona now equals the JSONL ground truth, not the
    // inflated 999. PersonaTrigger reads this field for its P3/P4 threshold
    // checks; because it matches reality, a persona interval check against
    // this value will not spuriously fire due to pre-cleanup inflation.
    expect(cp.memories_since_last_persona).toBe(3);
  });

  // ── Acceptance 8: degraded fallback uses JSONL lines, not store's 0 ────────
  it("degraded fallback: total_processed uses countL0JsonlStats().lines, not store.countL0()=0", async () => {
    const dir = await makeDataDir();

    // 5 physical message lines across two shards. The store is degraded in
    // this scenario, so the authoritative source for total_processed falls
    // back to the JSONL line count (startup recalibrate degraded fallback).
    await writeConversations(
      dir,
      "2026-06-24.jsonl",
      l0Line({ recordedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        l0Line({ recordedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        l0Line({ recordedAt: "2026-06-24T11:00:00.000Z" }) +
        "\n",
    );
    await writeConversations(
      dir,
      "2026-06-25.jsonl",
      l0Line({ recordedAt: "2026-06-25T09:00:00.000Z" }) +
        "\n" +
        l0Line({ recordedAt: "2026-06-25T10:00:00.000Z" }) +
        "\n",
    );

    const l0Stats = await countL0JsonlStats(dir);
    // lines is the physical message count — the degraded-fallback data source.
    expect(l0Stats.lines).toBe(5);
    // 4 distinct recordedAt values: 06-24T10:00, 06-24T11:00, 06-25T09:00, 06-25T10:00.
    expect(l0Stats.captures).toBe(4);

    // Simulate the index.ts degraded-fallback selection logic:
    //   vectorStore && !vectorStore.isDegraded() ? store.countL0() : l0Stats.lines
    // Here the store reports degraded (countL0() would return 0), so the
    // chosen totalProcessed must be l0Stats.lines, NOT 0.
    const storeCountL0 = 0; // degraded store returns 0
    const isDegraded = true;
    const totalProcessed = !isDegraded ? storeCountL0 : l0Stats.lines;
    expect(totalProcessed).toBe(5); // lines, not 0

    // Recalibrate would then write this authoritative value.
    const mgr = new CheckpointManager(dir);
    await mgr.recalibrate({
      totalMemoriesExtracted: 0,
      l0ConversationsCount: l0Stats.captures,
      totalProcessed,
      memoriesSinceLastPersona: 0,
    });
    const cp = await mgr.read();
    expect(cp.total_processed).toBe(5);
    expect(cp.l0_conversations_count).toBe(4);
  });

  // ── Acceptance 5: last_persona_time === "" counts all lines ───────────────
  it("treats empty last_persona_time as 'never generated persona' and counts all L1 lines", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // A fresh checkpoint has last_persona_time === "" (DEFAULT_CHECKPOINT).
    const fresh = await mgr.read();
    expect(fresh.last_persona_time).toBe("");

    // Seed 3 L1 lines.
    await writeRecords(
      dir,
      "2026-06-24.jsonl",
      l1Line({ id: "a", updatedAt: "2026-06-24T10:00:00.000Z" }) +
        "\n" +
        l1Line({ id: "b", updatedAt: "2026-06-24T11:00:00.000Z" }) +
        "\n" +
        l1Line({ id: "c", updatedAt: "2026-06-25T09:00:00.000Z" }) +
        "\n",
    );

    // With last_persona_time === "", countL1JsonlLinesSince must equal
    // countL1JsonlLines (all lines) — i.e. every memory counts as "since
    // last persona" when no persona has ever been generated.
    const totalLines = await countL1JsonlLines(dir);
    const sinceEmpty = await countL1JsonlLinesSince(dir, "");
    expect(sinceEmpty).toBe(totalLines);
    expect(sinceEmpty).toBe(3);

    // Recalibrate memories_since_last_persona to the full count.
    await mgr.recalibrate({
      totalMemoriesExtracted: totalLines,
      l0ConversationsCount: 0,
      totalProcessed: 0,
      memoriesSinceLastPersona: sinceEmpty,
    });

    const cp = await mgr.read();
    // All lines are "since last persona" — memories_since_last_persona equals
    // the total L1 line count, reflecting the JSONL truth (not a virtual 0 or
    // an inflated value).
    expect(cp.memories_since_last_persona).toBe(3);
    expect(cp.total_memories_extracted).toBe(3);
  });

  // ── Issue #157 repro: manual JSONL pruning (delete lines) ─────────────────
  it("issue repro: manual JSONL pruning — counter inflated, recalibrate drops to surviving lines", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // Seed records/*.jsonl with 5 L1 lines.
    await writeRecords(
      dir,
      "2026-06-24.jsonl",
      l1Line({ id: "m1", updatedAt: "2026-06-24T10:00:00.000Z" }) + "\n" +
      l1Line({ id: "m2", updatedAt: "2026-06-24T11:00:00.000Z" }) + "\n" +
      l1Line({ id: "m3", updatedAt: "2026-06-24T12:00:00.000Z" }) + "\n" +
      l1Line({ id: "m4", updatedAt: "2026-06-24T13:00:00.000Z" }) + "\n" +
      l1Line({ id: "m5", updatedAt: "2026-06-24T14:00:00.000Z" }) + "\n",
    );

    // Counter was inflated to 5 via normal extraction flow.
    await mgr.markL1ExtractionComplete("sess-int", 5);
    expect((await mgr.read()).total_memories_extracted).toBe(5);

    // Manual pruning: rewrite the shard with only 2 surviving lines (delete 3).
    await writeRecords(
      dir,
      "2026-06-24.jsonl",
      l1Line({ id: "m4", updatedAt: "2026-06-24T13:00:00.000Z" }) + "\n" +
      l1Line({ id: "m5", updatedAt: "2026-06-24T14:00:00.000Z" }) + "\n",
    );

    // Counter still says 5 (never decremented) — drift reproduced.
    expect((await mgr.read()).total_memories_extracted).toBe(5);

    // Recalibrate against the surviving JSONL truth.
    const surviving = await countL1JsonlLines(dir);
    expect(surviving).toBe(2);
    await mgr.recalibrate({
      totalMemoriesExtracted: surviving,
      l0ConversationsCount: 0,
      totalProcessed: 0,
      memoriesSinceLastPersona: 0,
    });

    // Counter now reflects actual data (5 → 2).
    expect((await mgr.read()).total_memories_extracted).toBe(2);
  });

  // ── Issue #157 case: memory-cleaner deletes an expired shard file ─────────
  it("cleaner-style: deleting an expired shard file drops the counter via recalibrate", async () => {
    const dir = await makeDataDir();
    const mgr = new CheckpointManager(dir);

    // Two daily shards: 3 lines + 2 lines = 5 total.
    await writeRecords(
      dir,
      "2026-06-23.jsonl",
      l1Line({ id: "old1", updatedAt: "2026-06-23T10:00:00.000Z" }) + "\n" +
      l1Line({ id: "old2", updatedAt: "2026-06-23T11:00:00.000Z" }) + "\n" +
      l1Line({ id: "old3", updatedAt: "2026-06-23T12:00:00.000Z" }) + "\n",
    );
    await writeRecords(
      dir,
      "2026-06-24.jsonl",
      l1Line({ id: "new1", updatedAt: "2026-06-24T10:00:00.000Z" }) + "\n" +
      l1Line({ id: "new2", updatedAt: "2026-06-24T11:00:00.000Z" }) + "\n",
    );
    await mgr.markL1ExtractionComplete("sess-int", 5);
    expect((await mgr.read()).total_memories_extracted).toBe(5);

    // Cleaner removes the expired 2026-06-23 shard file entirely.
    await fs.unlink(path.join(dir, "records", "2026-06-23.jsonl"));

    // Counter still 5 (drift). Recalibrate to surviving shard.
    const surviving = await countL1JsonlLines(dir);
    expect(surviving).toBe(2);
    await mgr.recalibrate({
      totalMemoriesExtracted: surviving,
      l0ConversationsCount: 0,
      totalProcessed: 0,
      memoriesSinceLastPersona: 0,
    });
    expect((await mgr.read()).total_memories_extracted).toBe(2);
  });
});
