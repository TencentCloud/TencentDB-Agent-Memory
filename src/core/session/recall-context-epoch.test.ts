import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RecallContextEpoch,
  type StableRecallSnapshot,
} from "./recall-context-epoch.js";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class GatedRecallContextEpoch extends RecallContextEpoch {
  readonly started: number[] = [];
  readonly gates = new Map<number, ReturnType<typeof deferred>>();

  protected override async loadSnapshot(epoch: number): Promise<StableRecallSnapshot> {
    this.started.push(epoch);
    const gate = deferred();
    this.gates.set(epoch, gate);
    await gate.promise;
    return { text: `snapshot-${epoch}`, hash: `hash-${epoch}`, persona: `persona-${epoch}` };
  }
}

describe("recall context epochs", () => {
  it("keeps snapshot bytes frozen until an explicit epoch transition", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-recall-epoch-"));
    await fs.mkdir(path.join(dataDir, ".metadata"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "persona.md"), "persona v1");
    await fs.writeFile(
      path.join(dataDir, ".metadata", "scene_index.json"),
      JSON.stringify([{ filename: "one.md", summary: "scene v1", heat: 1, created: "", updated: "" }]),
    );

    try {
      const context = new RecallContextEpoch(dataDir);
      const first = await context.resolve();

      await fs.writeFile(path.join(dataDir, "persona.md"), "persona v2");
      const sameEpoch = await context.resolve();

      expect(sameEpoch.epoch).toBe(1);
      expect(sameEpoch.snapshot).toBe(first.snapshot);
      expect(sameEpoch.snapshot.text).toContain("persona v1");
      expect(sameEpoch.snapshot.text).not.toContain("persona v2");

      context.publishStableContextChange("persona");
      const second = await context.resolve();

      expect(second.epoch).toBe(2);
      expect(second.snapshot.hash).not.toBe(first.snapshot.hash);
      expect(second.snapshot.text).toContain("persona v2");
      expect(second.snapshot.text).toContain("scene v1");
    } finally {
      await fs.rm(dataDir, { recursive: true });
    }
  });

  it("shares one snapshot build across concurrent turns in an epoch", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-recall-concurrent-"));
    try {
      const context = new RecallContextEpoch(dataDir);
      const bindings = await Promise.all(Array.from({ length: 8 }, () => context.resolve()));

      expect(new Set(bindings.map((binding) => binding.snapshot)).size).toBe(1);
      expect(new Set(bindings.map((binding) => binding.epoch))).toEqual(new Set([1]));
    } finally {
      await fs.rm(dataDir, { recursive: true });
    }
  });

  it("discards an in-flight snapshot when publication advances the epoch", async () => {
    const context = new GatedRecallContextEpoch("unused");
    const first = context.resolve();
    const second = context.resolve();
    await vi.waitFor(() => expect(context.started).toEqual([1]));

    context.publishStableContextChange("persona");
    const third = context.resolve();
    await vi.waitFor(() => expect(context.started).toEqual([1, 2]));

    context.gates.get(1)!.release();
    await Promise.resolve();
    context.gates.get(2)!.release();

    const bindings = await Promise.all([first, second, third]);
    expect(bindings.map(({ epoch, snapshot }) => [epoch, snapshot.hash])).toEqual([
      [2, "hash-2"],
      [2, "hash-2"],
      [2, "hash-2"],
    ]);
    expect(context.started).toEqual([1, 2]);
  });
});
