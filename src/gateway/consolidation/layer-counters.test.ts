import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  countScenes,
  recomputeCounters,
  createCounterObserver,
} from "./layer-counters.js";
import { ConsolidationCheckpoint } from "./checkpoint.js";
import type { MemoryMutation } from "../../core/record/commit-port.js";

let dataDir: string;
const store = {
  rows: 0,
  countL1(): number {
    return this.rows;
  },
};

const mutation: MemoryMutation = {
  carrier: "l1",
  kind: "delete",
  affected: 1,
  source: "test",
  at: "2026-08-11T00:00:00.000Z",
};

function writeBlock(rel: string): void {
  const p = path.join(dataDir, "scene_blocks", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "# block", "utf-8");
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "counters-"));
  store.rows = 0;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("layer counters", () => {
  it("counts blocks in slug directories and legacy flat blocks", async () => {
    writeBlock("proj-a1b2c3d4/one.md");
    writeBlock("proj-a1b2c3d4/two.md");
    writeBlock("_global/three.md");
    writeBlock("legacy.md");
    writeBlock("proj-a1b2c3d4/notes.txt");
    expect(await countScenes(dataDir)).toBe(4);
  });

  it("counts zero when there are no scenes at all", async () => {
    expect(await countScenes(dataDir)).toBe(0);
  });

  it("stores both counters in the checkpoint", async () => {
    store.rows = 7;
    writeBlock("_global/a.md");
    await recomputeCounters(dataDir, store);
    const cp = await new ConsolidationCheckpoint(dataDir).read();
    expect(cp.l1Count).toBe(7);
    expect(cp.sceneCount).toBe(1);
  });

  it("recomputes rather than accumulates — a repeat is a no-op", async () => {
    store.rows = 5;
    const observer = createCounterObserver(dataDir, store);
    await observer.onCommitted(mutation);
    await observer.onCommitted(mutation);
    const cp = await new ConsolidationCheckpoint(dataDir).read();
    expect(cp.l1Count).toBe(5);
  });

  it("follows the store down — the counter can shrink", async () => {
    store.rows = 9;
    await recomputeCounters(dataDir, store);
    store.rows = 4;
    await recomputeCounters(dataDir, store);
    const cp = await new ConsolidationCheckpoint(dataDir).read();
    expect(cp.l1Count).toBe(4);
  });

  it("recomputes BOTH carriers even when one carrier is announced", async () => {
    store.rows = 2;
    writeBlock("_global/a.md");
    await createCounterObserver(dataDir, store).onCommitted(mutation); // carrier: l1
    const cp = await new ConsolidationCheckpoint(dataDir).read();
    expect(cp.sceneCount).toBe(1);
  });

  it("without a store keeps l1Count and still counts scenes (degraded gateway)", async () => {
    store.rows = 8;
    await recomputeCounters(dataDir, store);
    writeBlock("_global/a.md");
    await recomputeCounters(dataDir, undefined);
    const cp = await new ConsolidationCheckpoint(dataDir).read();
    expect(cp.l1Count).toBe(8); // not overwritten with a lie
    expect(cp.sceneCount).toBe(1);
  });

  it("takes the store from a supplier, so a late store still counts", async () => {
    let live: typeof store | undefined = undefined;
    const observer = createCounterObserver(dataDir, () => live);
    await observer.onCommitted(mutation);
    expect((await new ConsolidationCheckpoint(dataDir).read()).l1Count).toBe(
      undefined,
    );
    live = store;
    store.rows = 6;
    await observer.onCommitted(mutation);
    expect((await new ConsolidationCheckpoint(dataDir).read()).l1Count).toBe(6);
  });

  it("leaves the cursor fields of tz-03a untouched", async () => {
    const cp = new ConsolidationCheckpoint(dataDir);
    await cp.update((d) => {
      d.l0Cursor = "2026-08-01T00:00:00.000Z";
      d.l0CursorId = "r1";
      d.l0Count = 3;
    });
    store.rows = 1;
    await recomputeCounters(dataDir, store);
    const after = await cp.read();
    expect(after.l0Cursor).toBe("2026-08-01T00:00:00.000Z");
    expect(after.l0CursorId).toBe("r1");
    expect(after.l0Count).toBe(3);
  });
});
