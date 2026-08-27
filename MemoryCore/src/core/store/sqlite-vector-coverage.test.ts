import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VectorStore } from "./sqlite.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SQLite vector coverage and replay", () => {
  it("retains L0 source rows across failed embedding, restart, and idempotent backfill", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-vector-coverage-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "vectors.db");
    let store = new VectorStore(dbPath, 3);
    await store.init({ provider: "openai", model: "bge-m3" });
    await store.upsertL0({
      id: "l0-durable",
      sessionKey: "session",
      sessionId: "session",
      role: "user",
      messageText: "香港 🧬 code",
      recordedAt: new Date(0).toISOString(),
      timestamp: 0,
    });
    expect(store.getVectorCoverage()).toEqual({
      l0: { sourceRows: 1, vectorRows: 0, coverage: 0 },
      l1: { sourceRows: 0, vectorRows: 0, coverage: 1 },
    });
    store.close();

    store = new VectorStore(dbPath, 3);
    await store.init({ provider: "openai", model: "bge-m3" });
    expect(store.getVectorCoverage().l0).toEqual({ sourceRows: 1, vectorRows: 0, coverage: 0 });

    const vector = new Float32Array([1, 0, 0]);
    await store.updateL0Embedding("l0-durable", vector);
    await store.updateL0Embedding("l0-durable", vector);
    expect(store.getVectorCoverage().l0).toEqual({ sourceRows: 1, vectorRows: 1, coverage: 1 });
    expect(await store.countL0()).toBe(1);
    store.close();
  });
});
