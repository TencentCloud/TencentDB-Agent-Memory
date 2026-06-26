import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readMemoryRecords } from "../record/l1-reader.js";
import { executeMemoryWrite } from "./memory-write.js";

describe("executeMemoryWrite", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("stores an explicit memory through the L1 writer", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "tdai-memory-write-"));
    tempDirs.push(baseDir);

    const result = await executeMemoryWrite({
      baseDir,
      sessionKey: "subagent-alpha",
      sessionId: "thread-1",
      content: "User prefers concise TypeScript examples with focused tests.",
      type: "instruction",
      sceneName: "manual subagent note",
      priority: 88,
    });

    expect(result.record.content).toBe("User prefers concise TypeScript examples with focused tests.");
    expect(result.record.type).toBe("instruction");
    expect(result.record.priority).toBe(88);
    expect(result.record.scene_name).toBe("manual subagent note");
    expect(result.record.sessionKey).toBe("subagent-alpha");
    expect(result.record.sessionId).toBe("thread-1");
    expect(result.text).toContain(result.record.id);

    const records = await readMemoryRecords("subagent-alpha", baseDir);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(result.record.id);
  });

  it("rejects empty content and invalid memory types", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "tdai-memory-write-invalid-"));
    tempDirs.push(baseDir);

    await expect(executeMemoryWrite({
      baseDir,
      sessionKey: "subagent-alpha",
      content: "   ",
    })).rejects.toThrow(/content/i);

    await expect(executeMemoryWrite({
      baseDir,
      sessionKey: "subagent-alpha",
      content: "Remember this explicit note.",
      type: "temporary",
    })).rejects.toThrow(/type/i);
  });
});
