import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import { performAutoRecall } from "./auto-recall.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("performAutoRecall", () => {
  it("reports the effective keyword strategy when hybrid falls back without embeddings", async () => {
    const dataDir = await makeTempDir("auto-recall-");
    await fs.writeFile(path.join(dataDir, "persona.md"), "Prefers concise technical answers.", "utf-8");
    const cfg = parseConfig({
      recall: { strategy: "hybrid" },
    });

    const result = await performAutoRecall({
      userText: "What do you remember about my response style?",
      actorId: "user-1",
      sessionKey: "agent:main:user-1",
      cfg,
      pluginDataDir: dataDir,
    });

    expect(result?.appendSystemContext).toContain("Prefers concise technical answers.");
    expect(result?.recallStrategy).toBe("keyword");
  });
});
