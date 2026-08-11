/**
 * tz-02 Ф6 — the gates that must NOT have been lifted, plus persona
 * serialization (criteria 5 / A1c / S1b).
 *
 * Each of these is green today, which is exactly why each names its own
 * falsification: remove the thing under test and the assertion goes red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createL2Runner } from "../../utils/pipeline-factory/l2-runner.js";
import { createL3Runner } from "../../utils/pipeline-factory/l3-runner.js";
import { ApplyExecutor } from "../apply-executor.js";
import { VectorStore } from "../../core/store/sqlite.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { Logger } from "../../core/types.js";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz02-gates-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("A1c — the inline writers are unreachable while consolidation is on", () => {
  // Every inline path that writes scenes or persona (profile-sync's rm -rf of
  // scene_blocks, persona-generator, filename-normalizer, scene-extractor) is
  // reached ONLY through these two runners. Gate them and the whole family is
  // out of reach — which is the honest form of the invariant: one writer WHILE
  // CONSOLIDATION IS ENABLED.
  //
  // Falsification: drop the `isConsolidationEnabled` early return in
  // l2-runner.ts:30-32 (or l3-runner.ts:26-29) and `pullProfiles` is called —
  // the store stub below records it, and the assertions go red.
  it("inline L2 and L3 never touch the store or the scene tree", async () => {
    const blocks = path.join(dir, "scene_blocks", "project-a");
    fs.mkdirSync(blocks, { recursive: true });
    fs.writeFileSync(path.join(blocks, "scene-1.md"), "original\n", "utf-8");
    fs.writeFileSync(path.join(dir, "persona.md"), "persona v1\n", "utf-8");
    const inode = fs.statSync(path.join(blocks, "scene-1.md")).ino;

    let pulled = 0;
    const store = {
      pullProfiles: async () => {
        pulled += 1;
        return [];
      },
      isDegraded: () => false,
    };
    const cfg = { consolidation: { enabled: true } } as never;
    const l2 = createL2Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: {},
      vectorStore: store as never,
      logger: silent as never,
    });
    const l3 = createL3Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: {},
      vectorStore: store as never,
      logger: silent as never,
    });

    expect(await l2("session-1", "cursor-1")).toEqual({
      skipped: true,
      latestCursor: "cursor-1",
    });
    expect(await l3()).toBeUndefined();
    expect(pulled).toBe(0);
    expect(fs.readFileSync(path.join(blocks, "scene-1.md"), "utf-8")).toBe(
      "original\n",
    );
    expect(fs.statSync(path.join(blocks, "scene-1.md")).ino).toBe(inode);
    expect(fs.readFileSync(path.join(dir, "persona.md"), "utf-8")).toBe(
      "persona v1\n",
    );
  });
});

describe("S1b — two rewritePersona runs leave one version, not a mix", () => {
  // Falsification: move the mutations out of `withStoreApplyLock`
  // (apply-executor.ts:141) and the two writers interleave — persona.md ends
  // up as neither version, or the second one applies over an unchecked
  // baseline.
  it("the loser is refused on the baseline, the winner is whole", async () => {
    const DIMS = 4;
    const v = new Float32Array(DIMS);
    v[1] = 1;
    const embedding: EmbeddingService = {
      embed: async () => v,
      embedBatch: async (ts: string[]) => ts.map(() => v),
      getDimensions: () => DIMS,
      getProviderInfo: () => ({ provider: "fake", model: "fake" }),
      isReady: () => true,
      startWarmup: () => undefined,
      close: async () => undefined,
    };
    fs.writeFileSync(path.join(dir, "persona.md"), "ORIGINAL\n", "utf-8");
    const store = new VectorStore(path.join(dir, "vectors.db"), DIMS, silent);
    store.init();
    const executor = new ApplyExecutor({
      dataDir: dir,
      logger: silent,
      vectorStore: store,
      embeddingService: embedding,
    });
    const baseline = {
      "persona.md": createHash("sha256")
        .update(fs.readFileSync(path.join(dir, "persona.md")))
        .digest("hex"),
    };
    const write = (body: string) =>
      executor.apply({
        diff: { rewritePersona: body },
        manifest: { baseline },
        context: { presentedRecordIds: [] },
      });

    const [a, b] = await Promise.all([
      write("VERSION-A\n"),
      write("VERSION-B\n"),
    ]);
    store.close();

    const applied = [a, b].filter((r) => r.status === "applied");
    expect(applied.length).toBe(1);
    // Whole, not a blend: the file equals exactly one of the two candidates.
    const onDisk = fs.readFileSync(path.join(dir, "persona.md"), "utf-8");
    expect(["VERSION-A\n", "VERSION-B\n"]).toContain(onDisk);
    // ...and the loser was refused on the SHIFTED BASELINE, not on a timeout.
    const refused = [a, b].find((r) => r.status !== "applied");
    expect(refused?.error ?? "").toMatch(/manifest drift/i);
  });
});
