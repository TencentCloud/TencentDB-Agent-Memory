import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SceneExtractor } from "./scene-extractor.js";
import type { LLMRunParams, LLMRunner } from "../types.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SceneExtractor", () => {
  it("lets an injected LLM runner use its configured timeout", async () => {
    const dataDir = await makeTempDir("scene-extractor-");
    const calls: LLMRunParams[] = [];
    const runner: LLMRunner = {
      async run(params) {
        calls.push(params);
        return "";
      },
    };

    const extractor = new SceneExtractor({
      dataDir,
      config: {},
      llmRunner: runner,
    });

    const result = await extractor.extract([
      {
        id: "memory-1",
        content: "User prefers quiet keyboards for late-night coding.",
        created_at: "2026-06-29T00:00:00.000Z",
      },
    ]);

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBeUndefined();
  });
});
