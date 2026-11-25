import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractSource } from "./index.js";
import { normalizeLlmConfig, type LlmClient } from "./llm.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractSource candidate paths", () => {
  it("warns and keeps the last block when distinct FILE paths canonicalize to the same page", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "wiki-ingest-paths-"));
    tempDirs.push(projectPath);
    const sourcePath = join(projectPath, "source.md");
    writeFileSync(sourcePath, "synthetic source", "utf-8");

    const llm: LlmClient = {
      config: normalizeLlmConfig({}),
      chat: vi.fn().mockResolvedValue([
        '<<<FILE path="wiki/sources/redis.md">>>',
        "---",
        "type: entity",
        "title: Redis",
        "---",
        "first",
        "<<<END>>>",
        '<<<FILE path="wiki/concepts/redis.md">>>',
        "---",
        "type: entity",
        "title: Redis",
        "---",
        "second",
        "<<<END>>>",
      ].join("\n")),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const candidates = await extractSource(
      projectPath,
      sourcePath,
      {},
      [],
      { llm, mode: "single-stage" },
    );

    expect(candidates.size).toBe(1);
    expect(candidates.get("wiki/entities/redis.md")).toContain("second");
    expect(candidates.get("wiki/entities/redis.md")).not.toContain("first");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '"wiki/sources/redis.md" -> "wiki/concepts/redis.md" => "wiki/entities/redis.md"',
      ),
    );
  });
});
