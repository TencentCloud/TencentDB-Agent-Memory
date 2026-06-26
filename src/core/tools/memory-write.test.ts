import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeMemoryWrite } from "./memory-write.js";

const tempDirs: string[] = [];

describe("executeMemoryWrite", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("stores an explicit memory in the L1 JSONL schema", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-memory-write-"));
    tempDirs.push(dataDir);

    const result = await executeMemoryWrite({
      dataDir,
      params: {
        content: "User prefers concise status updates.",
        type: "instruction",
        sceneName: "collaboration",
        sessionKey: "subagent-session",
      },
    });

    expect(result.record.content).toBe("User prefers concise status updates.");
    expect(result.record.type).toBe("instruction");
    expect(result.record.scene_name).toBe("collaboration");
    expect(result.record.sessionKey).toBe("subagent-session");
    expect(result.record.source_message_ids[0]).toMatch(/^manual:m_/);
    expect(result.text).toContain(result.record.id);

    const files = await fs.readdir(path.join(dataDir, "records"));
    expect(files).toHaveLength(1);
    const lines = (await fs.readFile(path.join(dataDir, "records", files[0]!), "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe(result.record.id);
  });

  it("rejects empty content", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-memory-write-"));
    tempDirs.push(dataDir);

    await expect(executeMemoryWrite({ dataDir, params: { content: "   " } })).rejects.toThrow("content is required");
  });

  it("rejects invalid memory types", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-memory-write-"));
    tempDirs.push(dataDir);

    await expect(
      executeMemoryWrite({ dataDir, params: { content: "Remember this.", type: "temporary" } }),
    ).rejects.toThrow("Invalid memory type");
  });
});
