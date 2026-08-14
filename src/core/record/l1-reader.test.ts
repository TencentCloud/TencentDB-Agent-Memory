import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { countL1JsonlLines, countL1JsonlLinesSince } from "./l1-reader.js";

/**
 * Helper: build a temp baseDir with a `records/` subdirectory and write the
 * given files into it. Returns the baseDir path. Caller is responsible for
 * cleanup via `afterEach`.
 */
async function makeBaseDir(files: Record<string, string>): Promise<string> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-reader-test-"));
  const recordsDir = path.join(baseDir, "records");
  await fs.mkdir(recordsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(recordsDir, name), content, "utf-8");
  }
  return baseDir;
}

/** Minimal valid record line with a given updatedAt. */
function line(updatedAt: string, extra: string = ""): string {
  return JSON.stringify({
    id: "r1",
    content: "c",
    type: "persona",
    priority: 50,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    sessionKey: "sk",
    sessionId: "sid",
    ...JSON.parse(extra || "{}"),
  });
}

describe("countL1JsonlLines", () => {
  let baseDirs: string[] = [];
  beforeEach(() => {
    baseDirs = [];
  });
  afterEach(async () => {
    await Promise.all(baseDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("counts total lines across multiple shard files", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl": line("2026-01-01T10:00:00.000Z") + "\n" + line("2026-01-01T11:00:00.000Z") + "\n",
      "2026-01-02.jsonl": line("2026-01-02T09:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLines(dir)).toBe(3);
  });

  it("skips empty/whitespace-only lines", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl": line("2026-01-01T10:00:00.000Z") + "\n\n   \n" + line("2026-01-01T11:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLines(dir)).toBe(2);
  });

  it("ignores non-shard files (.json, backups, temp)", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl": line("2026-01-01T10:00:00.000Z") + "\n",
      "2026-01-01.json": line("2026-01-01T10:00:00.000Z") + "\n",
      "2026-01-01.jsonl.bak": line("2026-01-01T10:00:00.000Z") + "\n",
      "2026-01-01.jsonl.tmp": line("2026-01-01T10:00:00.000Z") + "\n",
      "notes.txt": "irrelevant\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLines(dir)).toBe(1);
  });

  it("returns 0 when records/ directory does not exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-reader-test-"));
    baseDirs.push(dir);
    // no records/ subdir created
    expect(await countL1JsonlLines(dir)).toBe(0);
  });

  it("returns 0 for empty records/ directory", async () => {
    const dir = await makeBaseDir({});
    baseDirs.push(dir);
    expect(await countL1JsonlLines(dir)).toBe(0);
  });

  it("skips malformed JSON lines (only parseable lines are counted)", async () => {
    // countL1JsonlLines counts non-empty parseable lines; malformed JSON lines
    // are skipped (not counted), per spec "parse each line".
    const dir = await makeBaseDir({
      "2026-01-01.jsonl":
        line("2026-01-01T10:00:00.000Z") + "\n" + "{not valid json}\n" + line("2026-01-01T11:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    // 2 parseable lines, 1 malformed skipped
    expect(await countL1JsonlLines(dir)).toBe(2);
  });
});

describe("countL1JsonlLinesSince", () => {
  let baseDirs: string[] = [];
  beforeEach(() => {
    baseDirs = [];
  });
  afterEach(async () => {
    await Promise.all(baseDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("counts only lines with updatedAt > sinceIso", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl":
        line("2026-01-01T10:00:00.000Z") +
        "\n" +
        line("2026-01-01T11:00:00.000Z") +
        "\n" +
        line("2026-01-02T09:00:00.000Z") +
        "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T11:00:00.000Z")).toBe(1);
  });

  it("returns all lines when sinceIso is empty string", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl": line("2026-01-01T10:00:00.000Z") + "\n" + line("2026-01-02T09:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "")).toBe(2);
  });

  it("equal updatedAt is not counted (strict >)", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl": line("2026-01-01T10:00:00.000Z") + "\n" + line("2026-01-01T10:00:00.001Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T10:00:00.000Z")).toBe(1);
  });

  it("skips lines with missing updatedAt field", async () => {
    const noUpdatedAt = JSON.stringify({
      id: "r1",
      content: "c",
      type: "persona",
      priority: 50,
      scene_name: "s",
      source_message_ids: [],
      metadata: {},
      timestamps: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "sk",
      sessionId: "sid",
    });
    const dir = await makeBaseDir({
      "2026-01-01.jsonl":
        noUpdatedAt + "\n" + line("2026-06-01T10:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T00:00:00.000Z")).toBe(1);
  });

  it("skips lines with malformed/non-string updatedAt", async () => {
    const numUpdatedAt = JSON.stringify({
      id: "r1",
      content: "c",
      type: "persona",
      priority: 50,
      scene_name: "s",
      source_message_ids: [],
      metadata: {},
      timestamps: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: 12345,
      sessionKey: "sk",
      sessionId: "sid",
    });
    const dir = await makeBaseDir({
      "2026-01-01.jsonl":
        numUpdatedAt + "\n" + line("2026-06-01T10:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T00:00:00.000Z")).toBe(1);
  });

  it("skips lines with malformed-string updatedAt (e.g. zzz / not-a-time)", async () => {
    // updatedAt is a string but not a parseable ISO timestamp — must be
    // skipped (not silently compared as a string).
    const dir = await makeBaseDir({
      "2026-01-01.jsonl":
        line("zzz") + "\n" + line("not-a-time") + "\n" + line("2026-06-01T10:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    // Only the one valid ISO line is > cutoff; the two malformed-string lines are skipped.
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T00:00:00.000Z")).toBe(1);
  });

  it("skips malformed JSON lines entirely", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl":
        "{broken\n" + line("2026-06-01T10:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T00:00:00.000Z")).toBe(1);
  });

  it("returns 0 when records/ directory does not exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-reader-test-"));
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T00:00:00.000Z")).toBe(0);
  });

  it("counts across multiple shard files", async () => {
    const dir = await makeBaseDir({
      "2026-01-01.jsonl": line("2026-05-01T10:00:00.000Z") + "\n",
      "2026-06-01.jsonl": line("2026-06-01T10:00:00.000Z") + "\n" + line("2026-06-02T10:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-06-01T00:00:00.000Z")).toBe(2);
  });

  it("ignores non-shard files", async () => {
    const dir = await makeBaseDir({
      "2026-06-01.jsonl": line("2026-06-01T10:00:00.000Z") + "\n",
      "2026-06-01.json": line("2026-06-01T10:00:00.000Z") + "\n",
      "2026-06-01.jsonl.bak": line("2026-06-01T10:00:00.000Z") + "\n",
    });
    baseDirs.push(dir);
    expect(await countL1JsonlLinesSince(dir, "2026-01-01T00:00:00.000Z")).toBe(1);
  });
});
