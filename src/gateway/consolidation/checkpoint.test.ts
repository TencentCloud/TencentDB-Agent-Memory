/**
 * P6 — consolidation checkpoint unit tests.
 *
 * Isolated scratch dir; never touches the real memory tree. Covers:
 * write/read roundtrip, separation from recall_checkpoint.json, corrupt-file
 * recovery, locked concurrent updates, atomic writes (no .tmp leftovers).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConsolidationCheckpoint, type ConsolidationCheckpointData } from "./checkpoint.js";

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cp-"));
}

describe("ConsolidationCheckpoint (P6)", () => {
  let tmp: string;
  let dataDir: string;

  beforeEach(() => {
    tmp = scratchDir();
    dataDir = path.join(tmp, "tdai");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fresh store yields defaults (no run yet)", async () => {
    const cp = new ConsolidationCheckpoint(dataDir);
    const data = await cp.read();
    expect(data.lastRunAt).toBe("");
    expect(data.l0Cursor).toBe("");
    expect(data.l0Count).toBe(0);
    expect(data.roles).toEqual({});
  });

  it("write/read roundtrip persists time + cursor + count + role progress", async () => {
    const cp = new ConsolidationCheckpoint(dataDir);
    const snapshot: ConsolidationCheckpointData = {
      lastRunAt: "2026-08-02T03:00:00.000Z",
      l0Cursor: "2026-08-02T02:59:59.000Z",
      l0Count: 1234,
      roles: {
        "memory-keeper": {
          lastRunAt: "2026-08-02T03:00:00.000Z",
          recordsProcessed: 5,
          overLimitBlocks: 2,
          merges: 1,
          rewrites: 1,
          errors: 0,
        },
      },
    };
    await cp.write(snapshot);

    const read = await new ConsolidationCheckpoint(dataDir).read();
    expect(read).toEqual(snapshot);
    expect(fs.existsSync(cp.file)).toBe(true);
  });

  it("lives in .metadata/consolidation_checkpoint.json — NOT recall_checkpoint.json", async () => {
    const cp = new ConsolidationCheckpoint(dataDir);
    expect(path.basename(cp.file)).toBe("consolidation_checkpoint.json");
    // CheckpointManager's recall checkpoint is a different file.
    expect(cp.file).toContain(path.join(".metadata", "consolidation_checkpoint.json"));
    expect(cp.file).not.toContain("recall_checkpoint");
  });

  it("corrupt or missing file recovers to defaults", async () => {
    const cp = new ConsolidationCheckpoint(dataDir);
    await cp.write({ lastRunAt: "2026-08-02T00:00:00Z", l0Cursor: "", l0Count: 9, roles: {} });
    fs.writeFileSync(cp.file, "{ not json", "utf-8");
    const read = await cp.read();
    expect(read.lastRunAt).toBe("");
    expect(read.l0Count).toBe(0);
  });

  it("update() is locked — concurrent mutations serialize without loss", async () => {
    const cp = new ConsolidationCheckpoint(dataDir);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        cp.update((d) => {
          d.l0Count += 1;
          d.roles[`r${i}`] = {
            lastRunAt: "2026-08-02T00:00:00Z",
            recordsProcessed: i,
            overLimitBlocks: 0,
            merges: 0,
            rewrites: 0,
            errors: 0,
          };
        }),
      ),
    );
    const read = await cp.read();
    expect(read.l0Count).toBe(10);
    expect(Object.keys(read.roles).length).toBe(10);
  });

  it("writes are atomic — no .tmp leftovers after a write", async () => {
    const cp = new ConsolidationCheckpoint(dataDir);
    await cp.write({ lastRunAt: "2026-08-02T00:00:00Z", l0Cursor: "", l0Count: 1, roles: {} });
    const dir = path.dirname(cp.file);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes("consolidation_checkpoint.json.tmp"));
    expect(leftovers).toEqual([]);
  });
});
