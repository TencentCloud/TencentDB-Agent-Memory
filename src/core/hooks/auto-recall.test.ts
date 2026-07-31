import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import { RecallContextEpoch } from "../session/recall-context-epoch.js";
import { performAutoRecall } from "./auto-recall.js";

function ftsResult(content: string): L1FtsResult {
  return {
    record_id: content,
    content,
    type: "fact",
    priority: 1,
    scene_name: "",
    score: 0.9,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "session",
    session_id: "session",
    metadata_json: "{}",
  };
}

describe("auto recall prompt layout", () => {
  it("keeps stable system context identical across different L1 recalls", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-auto-recall-"));
    await fs.writeFile(path.join(dataDir, "persona.md"), "The user prefers concise answers.");

    let recalledContent = "The user is working on issue 120.";
    const store = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => [ftsResult(recalledContent)],
    } as unknown as IMemoryStore;
    const cfg = parseConfig({ recall: { strategy: "keyword" } });
    const { snapshot } = await new RecallContextEpoch(dataDir).resolve();

    try {
      const first = await performAutoRecall({
        userText: "prompt cache",
        actorId: "user",
        sessionKey: "session",
        cfg,
        pluginDataDir: dataDir,
        vectorStore: store,
        stableSnapshot: snapshot,
      });
      recalledContent = "The user is measuring a different optimization.";
      const second = await performAutoRecall({
        userText: "prompt cache",
        actorId: "user",
        sessionKey: "session",
        cfg,
        pluginDataDir: dataDir,
        vectorStore: store,
        stableSnapshot: snapshot,
      });

      expect(first.appendSystemContext).toBe(second.appendSystemContext);
      expect(first.appendSystemContext).toContain("<user-persona>");
      expect(first.appendSystemContext).toContain("<memory-tools-guide>");
      expect(first.appendSystemContext).not.toContain("<relevant-memories>");
      expect(first.prependContext).toContain("issue 120");
      expect(second.prependContext).toContain("different optimization");
    } finally {
      await fs.rm(dataDir, { recursive: true });
    }
  });

  it("keeps automatic recall fresh across a six-turn snapshot epoch", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-auto-recall-delta-"));
    await fs.writeFile(path.join(dataDir, "persona.md"), "Stable profile");

    let turn = 0;
    const store = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => [ftsResult(`fresh memory ${turn}`)],
    } as unknown as IMemoryStore;
    const cfg = parseConfig({ recall: { strategy: "keyword" } });

    try {
      const binding = await new RecallContextEpoch(dataDir).resolve();
      const stableContexts = new Set<string>();
      const deltas = new Set<string>();

      for (turn = 1; turn <= 6; turn += 1) {
        const result = await performAutoRecall({
          userText: `question ${turn}`,
          actorId: "user",
          sessionKey: "session",
          cfg,
          pluginDataDir: dataDir,
          vectorStore: store,
          stableSnapshot: binding.snapshot,
        });
        stableContexts.add(result.appendSystemContext ?? "");
        deltas.add(result.prependContext ?? "");
      }

      expect(stableContexts.size).toBe(1);
      expect(deltas.size).toBe(6);
    } finally {
      await fs.rm(dataDir, { recursive: true });
    }
  });

  it("preserves multiline memories in the structured recall result", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-auto-recall-multiline-"));
    const content = "protocol answer\nbackground line one\nbackground line two";
    const store = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => [ftsResult(content)],
    } as unknown as IMemoryStore;
    const cfg = parseConfig({ recall: { strategy: "keyword" } });

    try {
      const { snapshot } = await new RecallContextEpoch(dataDir).resolve();
      const result = await performAutoRecall({
        userText: "protocol",
        actorId: "user",
        sessionKey: "session",
        cfg,
        pluginDataDir: dataDir,
        vectorStore: store,
        stableSnapshot: snapshot,
      });

      expect(result.recalledL1Memories).toEqual([{ content, score: 0, type: "fact" }]);
    } finally {
      await fs.rm(dataDir, { recursive: true });
    }
  });

  it("keeps the stable snapshot when the per-turn delta times out", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-auto-recall-timeout-"));
    await fs.writeFile(path.join(dataDir, "persona.md"), "Stable during timeout");
    const cfg = parseConfig({ recall: { strategy: "keyword", timeoutMs: 1 } });
    const store = {
      isFtsAvailable: () => true,
      searchL1Fts: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [ftsResult("late memory")];
      },
    } as unknown as IMemoryStore;

    try {
      const { snapshot } = await new RecallContextEpoch(dataDir).resolve();
      const result = await performAutoRecall({
        userText: "slow query",
        actorId: "user",
        sessionKey: "session",
        cfg,
        pluginDataDir: dataDir,
        vectorStore: store,
        stableSnapshot: snapshot,
      });

      expect(result.appendSystemContext).toBe(snapshot.text);
      expect(result.prependContext).toBeUndefined();
      expect(result.recallStrategy).toBe("timed-out");
    } finally {
      await fs.rm(dataDir, { recursive: true });
    }
  });
});
