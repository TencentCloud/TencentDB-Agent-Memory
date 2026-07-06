import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config.js";
import { performAutoRecall } from "./auto-recall.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("performAutoRecall tool-only mode", () => {
  it("does not search or prepend dynamic memories by default", async () => {
    const pluginDataDir = await mkdtemp(join(tmpdir(), "tdai-recall-"));
    tempDirs.push(pluginDataDir);
    const cfg = parseConfig({});
    const searchL1Fts = vi.fn(async () => []);
    const vectorStore = {
      isFtsAvailable: () => true,
      searchL1Fts,
      getCapabilities: () => ({ nativeHybridSearch: false }),
    } as any;

    const result = await performAutoRecall({
      userText: "帮我回忆项目规划",
      actorId: "user",
      sessionKey: "agent:test:session",
      cfg,
      pluginDataDir,
      vectorStore,
    });

    expect(searchL1Fts).not.toHaveBeenCalled();
    expect(result?.prependContext).toBeUndefined();
    expect(result?.appendSystemContext).toContain("<session-context");
    expect(result?.appendSystemContext).toContain("tdai_memory_search");
  });
});
