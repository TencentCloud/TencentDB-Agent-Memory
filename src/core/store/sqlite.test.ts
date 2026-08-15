import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "./sqlite.js";

async function tmpDbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-test-"));
  return path.join(dir, "test.db");
}

describe("VectorStore.countL0CaptureRounds", () => {
  it("counts distinct (session_key, recorded_at) capture rounds, not per-message rows", async () => {
    const dbPath = await tmpDbPath();
    // dimensions=0 → metadata-only store (no vec table), so upsertL0(undefined)
    // writes l0_conversations rows without needing an embedding provider.
    const store = new VectorStore(dbPath, 0);
    store.init();
    // Bail clearly if the test env can't load sqlite-vec (native ext missing).
    expect(store.isDegraded()).toBe(false);

    // Round A: two messages share a recorded_at (one capture batch).
    const roundA = "2026-07-20T10:00:00.000Z";
    store.upsertL0(
      { id: "m1", sessionKey: "s1", sessionId: "x", role: "user", messageText: "hi", recordedAt: roundA, timestamp: 1 },
      undefined,
    );
    store.upsertL0(
      { id: "m2", sessionKey: "s1", sessionId: "x", role: "assistant", messageText: "hello", recordedAt: roundA, timestamp: 1 },
      undefined,
    );
    // Round B: same session, different recorded_at.
    store.upsertL0(
      { id: "m3", sessionKey: "s1", sessionId: "x", role: "user", messageText: "again", recordedAt: "2026-07-20T11:00:00.000Z", timestamp: 2 },
      undefined,
    );

    expect(store.countL0()).toBe(3); // per-message COUNT(*)
    expect(store.countL0CaptureRounds()).toBe(2); // distinct capture batches
  });

  it("returns 0 on an empty store without error", async () => {
    const dbPath = await tmpDbPath();
    const store = new VectorStore(dbPath, 0);
    store.init();
    expect(store.isDegraded()).toBe(false);

    expect(store.countL0CaptureRounds()).toBe(0);
  });
});
