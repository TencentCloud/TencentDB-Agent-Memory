import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestExplicitMemory } from "./explicit-memory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ingestExplicitMemory", () => {
  it("stores Hermes memory target as an instruction L1 record", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "tdai-explicit-memory-"));
    tempDirs.push(baseDir);

    const embed = vi.fn(async () => new Float32Array([0.5, 0.25]));
    const upsertL1 = vi.fn(async () => true);

    const record = await ingestExplicitMemory({
      action: "add",
      target: "memory",
      content: "Remember that the user wants retry probe summaries.",
      baseDir,
      sessionKey: "session-key",
      sessionId: "session-id",
      vectorStore: { upsertL1 } as any,
      embeddingService: { embed } as any,
    });

    expect(record?.type).toBe("instruction");
    expect(record?.scene_name).toBe("hermes_explicit_memory");
    expect(upsertL1).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith("Remember that the user wants retry probe summaries.");

    const [shardName] = await readdir(path.join(baseDir, "records"));
    const shard = path.join(baseDir, "records", shardName);
    const saved = await readFile(shard, "utf-8");
    expect(saved).toContain("Remember that the user wants retry probe summaries.");
  });

  it("maps Hermes user target to a persona record", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "tdai-explicit-user-"));
    tempDirs.push(baseDir);

    const upsertL1 = vi.fn(async () => true);

    const record = await ingestExplicitMemory({
      action: "add",
      target: "user",
      content: "The user prefers concise answers.",
      baseDir,
      sessionKey: "session-key",
      vectorStore: { upsertL1 } as any,
    });

    expect(record?.type).toBe("persona");
    expect(record?.scene_name).toBe("hermes_user_profile");
  });

  it("rejects explicit memory writes when no search index is available", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "tdai-explicit-no-index-"));
    tempDirs.push(baseDir);

    const record = await ingestExplicitMemory({
      action: "add",
      target: "memory",
      content: "This marker must not be reported as stored without an index.",
      baseDir,
      sessionKey: "session-key",
    });

    expect(record).toBeNull();
  });

  it("rejects explicit memory writes when vector indexing fails", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "tdai-explicit-index-fail-"));
    tempDirs.push(baseDir);

    const upsertL1 = vi.fn(async () => false);

    const record = await ingestExplicitMemory({
      action: "add",
      target: "memory",
      content: "This marker must not be reported as stored after upsert failure.",
      baseDir,
      sessionKey: "session-key",
      vectorStore: { upsertL1 } as any,
    });

    expect(upsertL1).toHaveBeenCalledOnce();
    expect(record).toBeNull();
  });
});
