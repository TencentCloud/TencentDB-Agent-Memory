import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { countL0JsonlStats } from "./l0-recorder.js";

/**
 * Builds an L0MessageRecord JSON line with the given recordedAt (and optional
 * role/content). Fields mirror the L0MessageRecord shape from l0-recorder.ts.
 */
function line(recordedAt: string, opts: { role?: string; content?: string } = {}): string {
  return JSON.stringify({
    sessionKey: "s1",
    sessionId: "sess1",
    recordedAt,
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: opts.role ?? "user",
    content: opts.content ?? "hello",
    timestamp: Date.now(),
  });
}

/**
 * Writes the given raw string content to <baseDir>/conversations/<filename>.
 * Creates the conversations directory (and baseDir) as needed.
 */
async function writeFile(baseDir: string, filename: string, content: string): Promise<void> {
  const dir = path.join(baseDir, "conversations");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, "utf-8");
}

describe("countL0JsonlStats", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "l0-stats-"));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // ============================
  // Tracer bullet: basic single-file counting
  // ============================
  it("counts one capture and all physical lines from a single file", async () => {
    // Two messages sharing one recordedAt => 1 capture, 2 lines
    const ts = "2026-06-24T10:00:00.000Z";
    await writeFile(baseDir, "2026-06-24.jsonl", `${line(ts)}\n${line(ts)}\n`);

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.captures).toBe(1);
    expect(stats.lines).toBe(2);
  });

  // ============================
  // Multiple captures
  // ============================
  it("counts distinct recordedAt values as separate captures", async () => {
    const ts1 = "2026-06-24T10:00:00.000Z";
    const ts2 = "2026-06-24T11:00:00.000Z";
    const ts3 = "2026-06-24T12:00:00.000Z";
    // 3 different recordedAt => 3 captures, 4 lines
    await writeFile(baseDir, "2026-06-24.jsonl",
      `${line(ts1)}\n${line(ts2)}\n${line(ts2)}\n${line(ts3)}\n`);

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.captures).toBe(3);
    expect(stats.lines).toBe(4);
  });

  // ============================
  // Multi-shard (multiple daily files)
  // ============================
  it("aggregates across multiple daily shard files", async () => {
    const ts1 = "2026-06-23T09:00:00.000Z";
    const ts2 = "2026-06-24T10:00:00.000Z";
    await writeFile(baseDir, "2026-06-23.jsonl", `${line(ts1)}\n${line(ts1)}\n`);
    await writeFile(baseDir, "2026-06-24.jsonl", `${line(ts2)}\n`);

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.captures).toBe(2);
    expect(stats.lines).toBe(3);
  });

  // ============================
  // Invariant: a bad line (missing recordedAt) must not inflate captures
  // ============================
  it("counts a line missing recordedAt toward lines but not captures", async () => {
    const ts = "2026-06-24T10:00:00.000Z";
    const badLine = JSON.stringify({ sessionKey: "s1", role: "user", content: "no-timestamp", id: "x" });
    await writeFile(baseDir, "2026-06-24.jsonl", `${line(ts)}\n${badLine}\n`);

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.lines).toBe(2);
    expect(stats.captures).toBe(1);
  });

  it("counts a line with non-string recordedAt toward lines but not captures", async () => {
    const ts = "2026-06-24T10:00:00.000Z";
    const badLine = JSON.stringify({ sessionKey: "s1", recordedAt: 12345, role: "user", content: "x", id: "y" });
    await writeFile(baseDir, "2026-06-24.jsonl", `${line(ts)}\n${badLine}\n`);

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.lines).toBe(2);
    expect(stats.captures).toBe(1);
  });

  it("counts a malformed (unparseable JSON) line toward lines but not captures", async () => {
    const ts = "2026-06-24T10:00:00.000Z";
    const garbage = "{not valid json";
    await writeFile(baseDir, "2026-06-24.jsonl", `${line(ts)}\n${garbage}\n`);

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.lines).toBe(2);
    expect(stats.captures).toBe(1);
  });

  // ============================
  // Non-shard filename filtering
  // ============================
  it("ignores files not matching the YYYY-MM-DD.jsonl pattern", async () => {
    const ts = "2026-06-24T10:00:00.000Z";
    await writeFile(baseDir, "2026-06-24.jsonl", `${line(ts)}\n`);
    // These should be ignored:
    await writeFile(baseDir, "2026-6-24.jsonl", `${line(ts)}\n`); // non-zero-padded
    await writeFile(baseDir, "notes.txt", `${line(ts)}\n`);
    await writeFile(baseDir, "2026-06-24.jsonl.bak", `${line(ts)}\n`);
    await writeFile(baseDir, "2026-06-24.jsonl", `${line(ts)}\n`); // overwrite legit file

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.lines).toBe(1);
    expect(stats.captures).toBe(1);
  });

  // ============================
  // Blank lines are neither lines nor captures
  // ============================
  it("skips whitespace-only lines entirely", async () => {
    const ts = "2026-06-24T10:00:00.000Z";
    await writeFile(baseDir, "2026-06-24.jsonl",
      `${line(ts)}\n   \n\t\n\n${line(ts)}\n`);

    const stats = await countL0JsonlStats(baseDir);
    expect(stats.lines).toBe(2);
    expect(stats.captures).toBe(1);
  });

  // ============================
  // Missing / empty directory
  // ============================
  it("returns zeros when the conversations directory does not exist", async () => {
    const stats = await countL0JsonlStats(baseDir);
    expect(stats).toEqual({ captures: 0, lines: 0 });
  });

  it("returns zeros when the conversations directory is empty", async () => {
    await fs.mkdir(path.join(baseDir, "conversations"), { recursive: true });
    const stats = await countL0JsonlStats(baseDir);
    expect(stats).toEqual({ captures: 0, lines: 0 });
  });
});
