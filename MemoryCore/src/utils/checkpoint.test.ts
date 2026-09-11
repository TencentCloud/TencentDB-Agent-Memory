/**
 * Regression tests for #770 — checkpoint read failures must never be silently
 * treated as a first run (which allowed the next mutation to overwrite the only
 * recoverable checkpoint evidence).
 *
 * Failure semantics under test:
 *   - missing checkpoint (ENOENT / storage null)            → DEFAULT_CHECKPOINT
 *   - malformed/truncated JSON + no backup                  → throw (fail closed)
 *   - malformed/truncated JSON + last-known-good `.bak`     → recover from backup
 *   - a mutation after a failed read must NOT overwrite the corrupted file
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointManager, type Checkpoint } from "./checkpoint.js";
import { StoragePaths } from "../core/storage/types.js";
import { StorageAdapter } from "../core/storage/adapter.js";

/** Build a valid, non-default checkpoint payload (mirrors the #770 reproduction). */
function validCheckpoint(overrides: Record<string, unknown> = {}): Checkpoint {
  return {
    last_captured_timestamp: 0,
    total_processed: 99,
    last_persona_at: 0,
    last_persona_time: "",
    request_persona_update: false,
    persona_update_reason: "",
    memories_since_last_persona: 0,
    scenes_processed: 0,
    runner_states: {
      sessionA: { last_captured_timestamp: 1234, last_l1_cursor: 1200, last_scene_name: "checkout" },
    },
    pipeline_states: {
      sessionA: {
        conversation_count: 7,
        last_extraction_time: "2026-08-01T00:00:00Z",
        last_extraction_updated_time: "",
        last_active_time: 1,
        l2_pending_l1_count: 2,
        warmup_threshold: 4,
        l2_last_extraction_time: "",
      },
    },
    l0_conversations_count: 0,
    total_memories_extracted: 12,
    ...overrides,
  } as Checkpoint;
}

/** In-memory StorageAdapter stand-in for the COS/storage mode tests. */
function mockStorage(initial: Record<string, string | null>): StorageAdapter {
  const files = new Map<string, string | null>(Object.entries(initial));
  return {
    readFile: vi.fn(async (key: string) => files.get(key) ?? null),
    writeFile: vi.fn(async (key: string, content: string) => {
      files.set(key, content);
    }),
  } as unknown as StorageAdapter;
}

const CORRUPTED = '{"runner_states":{"sessionA":';

describe("CheckpointManager read failure semantics (#770)", () => {
  let dataDir: string;
  let cpPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tdai-cp-test-"));
    cpPath = join(dataDir, ".metadata", "recall_checkpoint.json");
    mkdirSync(join(dataDir, ".metadata"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("missing checkpoint initializes defaults (first run)", async () => {
    const manager = new CheckpointManager(dataDir);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(0);
    expect(cp.runner_states).toEqual({});
    expect(cp.pipeline_states).toEqual({});
  });

  it("valid checkpoint is parsed and merged with defaults", async () => {
    writeFileSync(cpPath, JSON.stringify(validCheckpoint()));
    const manager = new CheckpointManager(dataDir);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(99);
    expect(cp.total_memories_extracted).toBe(12);
    expect(cp.runner_states.sessionA?.last_captured_timestamp).toBe(1234);
    expect(cp.pipeline_states.sessionA?.conversation_count).toBe(7);
  });

  it("malformed JSON is NOT treated as first run and surfaces an error", async () => {
    writeFileSync(cpPath, CORRUPTED);
    const manager = new CheckpointManager(dataDir);
    await expect(manager.read()).rejects.toThrow(/corrupt checkpoint/);
  });

  it("a mutation after a failed read cannot overwrite the corrupted checkpoint", async () => {
    writeFileSync(cpPath, CORRUPTED);
    const manager = new CheckpointManager(dataDir);
    await expect(manager.setPersonaUpdateRequest("manual")).rejects.toThrow(/corrupt checkpoint/);
    // The corrupted file must remain byte-for-byte intact — never reset to defaults.
    expect(readFileSync(cpPath, "utf8")).toBe(CORRUPTED);
    // A file that never wrote successfully has no backup.
    expect(existsSync(`${cpPath}.bak`)).toBe(false);
  });

  it("recovers from last-known-good backup when primary is truncated", async () => {
    const manager = new CheckpointManager(dataDir);
    // First successful mutation writes primary + backup.
    await manager.setPersonaUpdateRequest("manual");
    expect(existsSync(`${cpPath}.bak`)).toBe(true);

    // Now simulate a truncated write on the primary only.
    writeFileSync(cpPath, CORRUPTED);

    // read() must recover the previously persisted state from the backup.
    const cp = await manager.read();
    expect(cp.request_persona_update).toBe(true);
    expect(cp.runner_states).toBeDefined();
  });

  it("successful write keeps a backup equal to the primary", async () => {
    const manager = new CheckpointManager(dataDir);
    await manager.setPersonaUpdateRequest("manual");
    const primary = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
    const backup = JSON.parse(readFileSync(`${cpPath}.bak`, "utf8")) as Checkpoint;
    expect(backup).toEqual(primary);
    expect(backup.request_persona_update).toBe(true);
  });

  it("writes remain atomic and produce a valid checkpoint", async () => {
    const manager = new CheckpointManager(dataDir);
    await manager.incrementScenesProcessed();
    const cp = JSON.parse(readFileSync(cpPath, "utf8")) as Checkpoint;
    expect(cp.scenes_processed).toBe(1);
  });

  it("storage mode: missing checkpoint initializes defaults", async () => {
    const storage = mockStorage({});
    const manager = new CheckpointManager("", undefined, storage);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(0);
    expect(cp.runner_states).toEqual({});
  });

  it("storage mode: corrupt checkpoint fails closed (no backup fallback)", async () => {
    const storage = mockStorage({ [StoragePaths.checkpoint]: CORRUPTED });
    const manager = new CheckpointManager("", undefined, storage);
    await expect(manager.read()).rejects.toThrow(/corrupt checkpoint/);
  });
});
