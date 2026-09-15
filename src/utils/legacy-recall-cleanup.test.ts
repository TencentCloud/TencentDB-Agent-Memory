import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanSessionFile,
  cleanSessionJsonlLine,
  cleanUserContent,
  findSessionFiles,
  isSessionFile,
  runLegacyRecallCleanup,
  stripRelevantMemories,
} from "./legacy-recall-cleanup.js";

const BLOCK = "<relevant-memories>\nremembered fact\n</relevant-memories>";

function userLine(content: unknown, role = "user"): string {
  return JSON.stringify({ type: "message", message: { role, content } });
}

describe("legacy recall cleanup", () => {
  it("strips injected blocks from plain text", () => {
    expect(stripRelevantMemories(`${BLOCK}\nHello world`)).toBe("Hello world");
    expect(stripRelevantMemories("plain text")).toBe("plain text");
    expect(stripRelevantMemories("<relevant-memories>unclosed")).toBe("<relevant-memories>unclosed");
  });

  it("cleans string user content", () => {
    const result = cleanUserContent(`${BLOCK}\nHello`);
    expect(result.changed).toBe(true);
    expect(result.blocksRemoved).toBe(1);
    expect(result.content).toBe("Hello");
  });

  it("cleans text parts while keeping non-text parts untouched", () => {
    const result = cleanUserContent([
      { type: "text", text: `${BLOCK}\nHello` },
      { type: "image", image: "data:image/png;base64,abc" },
      { type: "text", text: "keep" },
    ]);
    expect(result.changed).toBe(true);
    expect(result.blocksRemoved).toBe(1);
    expect(result.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "image", image: "data:image/png;base64,abc" },
      { type: "text", text: "keep" },
    ]);
  });

  it("cleans a JSONL user message line", () => {
    const result = cleanSessionJsonlLine(userLine(`${BLOCK}\nHello`));
    expect(result.changed).toBe(true);
    expect(result.blocksRemoved).toBe(1);
    expect(JSON.parse(result.line).message.content).toBe("Hello");
  });

  it("ignores non-user message roles", () => {
    const result = cleanSessionJsonlLine(userLine(`${BLOCK}\nHello`, "assistant"));
    expect(result.changed).toBe(false);
    expect(result.blocksRemoved).toBe(0);
  });

  it("leaves malformed JSONL lines untouched", () => {
    const result = cleanSessionJsonlLine(`{not json <relevant-memories>`);
    expect(result.malformed).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("recognizes only session JSONL files", () => {
    const root = path.join("C:", "openclaw");
    expect(isSessionFile(path.join(root, "agents", "main", "sessions", "abc.jsonl"))).toBe(true);
    expect(isSessionFile(path.join(root, "agents", "main", "sessions", "abc.trajectory.jsonl"))).toBe(false);
    expect(isSessionFile(path.join(root, "memory-tdai", "conversations", "2026-01-01.jsonl"))).toBe(false);
  });

  it("finds session files and skips trajectories and conversation logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tdai-sessions-"));
    try {
      const sessionDir = path.join(root, "agents", "main", "sessions");
      const convDir = path.join(root, "memory-tdai", "conversations");
      await mkdir(sessionDir, { recursive: true });
      await mkdir(convDir, { recursive: true });
      await writeFile(path.join(sessionDir, "abc.jsonl"), "{}", "utf8");
      await writeFile(path.join(sessionDir, "abc.trajectory.jsonl"), "{}", "utf8");
      await writeFile(path.join(sessionDir, ".hidden.jsonl"), "{}", "utf8");
      await writeFile(path.join(convDir, "2026-01-01.jsonl"), "{}", "utf8");

      const found = await findSessionFiles(root);
      expect(found).toEqual([path.join(sessionDir, "abc.jsonl")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dry-run reports without rewriting, then applies on a real run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tdai-clean-"));
    const file = path.join(root, "agents", "main", "sessions", "abc.jsonl");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const original = `${userLine(`${BLOCK}\nHello`)}\n${userLine("plain")}\n`;
      await writeFile(file, original, "utf8");

      const dry = await cleanSessionFile(file, true);
      expect(dry.changed).toBe(true);
      expect(dry.blocksRemoved).toBe(1);
      expect(await readFile(file, "utf8")).toBe(original);

      const real = await cleanSessionFile(file, false);
      expect(real.changed).toBe(true);
      expect(real.bytesRemoved).toBeGreaterThan(0);
      const cleaned = await readFile(file, "utf8");
      expect(cleaned).not.toContain("<relevant-memories>");
      expect(cleaned).toContain("Hello");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves CRLF line endings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tdai-crlf-"));
    const file = path.join(root, "agents", "main", "sessions", "abc.jsonl");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${userLine(`${BLOCK}\nHello`)}\r\n`, "utf8");
      await cleanSessionFile(file, false);
      const cleaned = await readFile(file, "utf8");
      expect(cleaned.endsWith("\r\n")).toBe(true);
      expect(cleaned).not.toContain("<relevant-memories>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs across the state dir with a summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tdai-run-"));
    const file = path.join(root, "agents", "main", "sessions", "abc.jsonl");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${userLine(`${BLOCK}\nHello`)}\n`, "utf8");

      const summary = await runLegacyRecallCleanup({ stateDir: root, dryRun: false });
      expect(summary.filesScanned).toBe(1);
      expect(summary.filesChanged).toBe(1);
      expect(summary.blocksRemoved).toBe(1);
      expect(summary.changedFiles).toEqual([file]);
      expect(await readFile(file, "utf8")).not.toContain("<relevant-memories>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});