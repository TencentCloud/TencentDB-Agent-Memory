import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import type { LLMRunner } from "../types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { IMemoryStore, L1SearchResult } from "../store/types.js";
import { performAutoRecall } from "./auto-recall.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function memory(recordId: string, content: string): L1SearchResult {
  return {
    record_id: recordId,
    content,
    type: "episodic",
    priority: 1,
    scene_name: "migration",
    score: 0.9,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "session-1",
    session_id: "session-1",
    metadata_json: "{}",
  };
}

const retrieved = [
  memory("0f78d1c8", "The previous migration was completed."),
  memory("8b2aa7d4", "Current blocker: the target column type is undecided."),
  memory("62c031eb", "Next action: confirm the field mapping with the data owner."),
];

async function runRecall(opts: {
  selectorEnabled: boolean;
  runner: LLMRunner;
}) {
  const pluginDataDir = await mkdtemp(path.join(tmpdir(), "tdai-recall-selector-"));
  tempDirs.push(pluginDataDir);

  const searchL1Hybrid = vi.fn().mockResolvedValue(retrieved);
  const vectorStore = {
    getCapabilities: () => ({
      vectorSearch: true,
      ftsSearch: true,
      nativeHybridSearch: true,
      sparseVectors: true,
    }),
    searchL1Hybrid,
  } as unknown as IMemoryStore;

  const cfg = parseConfig({
    recall: {
      strategy: "hybrid",
      maxResults: 2,
      timeoutMs: 1000,
      taskSelector: {
        enabled: opts.selectorEnabled,
        candidateMultiplier: 2,
        timeoutMs: 500,
      },
    },
  });

  const result = await performAutoRecall({
    userText: "What should we do next on the migration?",
    actorId: "default_user",
    sessionKey: "session-1",
    cfg,
    pluginDataDir,
    vectorStore,
    embeddingService: {} as EmbeddingService,
    taskSelectorRunner: opts.runner,
  });

  return { result, searchL1Hybrid };
}

describe("auto-recall task-aware selector integration", () => {
  it("selects task-progress memories from an expanded retrieval pool", async () => {
    const runner: LLMRunner = {
      run: vi.fn().mockResolvedValue('{"selected_memory_ids":["8b2aa7d4","62c031eb"]}'),
    };

    const { result, searchL1Hybrid } = await runRecall({ selectorEnabled: true, runner });

    expect(searchL1Hybrid).toHaveBeenCalledWith(expect.objectContaining({ topK: 4 }));
    expect(runner.run).toHaveBeenCalledOnce();
    expect(result?.prependContext).toContain("Current blocker");
    expect(result?.prependContext).toContain("Next action");
    expect(result?.prependContext).not.toContain("previous migration was completed");
  });

  it("preserves the original Top-K and skips the LLM when disabled", async () => {
    const runner: LLMRunner = { run: vi.fn() };

    const { result, searchL1Hybrid } = await runRecall({ selectorEnabled: false, runner });

    expect(searchL1Hybrid).toHaveBeenCalledWith(expect.objectContaining({ topK: 2 }));
    expect(runner.run).not.toHaveBeenCalled();
    expect(result?.prependContext).toContain("previous migration was completed");
    expect(result?.prependContext).toContain("Current blocker");
    expect(result?.prependContext).not.toContain("Next action");
  });

  it("fails open to the original Top-K when selector output is invalid", async () => {
    const runner: LLMRunner = { run: vi.fn().mockResolvedValue("not-json") };

    const { result } = await runRecall({ selectorEnabled: true, runner });

    expect(result?.prependContext).toContain("previous migration was completed");
    expect(result?.prependContext).toContain("Current blocker");
    expect(result?.prependContext).not.toContain("Next action");
  });

  it("fails open to the original Top-K when the selector runner rejects", async () => {
    const runner: LLMRunner = { run: vi.fn().mockRejectedValue(new Error("model timeout")) };

    const { result } = await runRecall({ selectorEnabled: true, runner });

    expect(result?.prependContext).toContain("previous migration was completed");
    expect(result?.prependContext).toContain("Current blocker");
  });
});
