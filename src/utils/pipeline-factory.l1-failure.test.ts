/**
 * Regression tests for the L1 cursor on extraction failure.
 *
 * When the L1 LLM call failed (or answered with something that cannot be
 * parsed), the runner used to advance the L1 cursor anyway. The cursor is the
 * only filter for the next L0 read, so the affected batch was skipped forever
 * — a transient upstream failure turned into silent data loss.
 *
 * These tests pin the runner contract:
 *   - a failed extraction must NOT advance the L1 cursor (the batch is retried);
 *   - a valid but empty extraction MUST advance the cursor (the cursor cannot
 *     stall forever, otherwise the same batch would be re-read on every run);
 *   - a successful extraction advances the cursor and persists the memories.
 *
 * Related issues: #1395, #1523, #1618 (same defect on the MemoryCore branch).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import type { LLMRunner, Logger } from "../core/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { createL1Runner, L1ExtractionError } from "./pipeline-factory.js";

const SESSION_KEY = "session-1";

/** ISO timestamps used as L0 `recordedAt` values (the cursor unit). */
const T1 = "2026-10-29T00:00:01.000Z";
const T2 = "2026-10-29T00:00:02.000Z";
const T1_MS = Date.parse(T1);
const T2_MS = Date.parse(T2);

interface CapturingLogger extends Logger {
  errors: string[];
  warnings: string[];
}

function createLogger(): CapturingLogger {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string) => { warnings.push(message); },
    error: (message: string) => { errors.push(message); },
  };
}

/** Append one L0 conversation message to the daily JSONL shard. */
async function writeL0Message(opts: {
  baseDir: string;
  sessionId: string;
  id: string;
  content: string;
  recordedAt: string;
  timestamp: number;
}): Promise<void> {
  const dir = path.join(opts.baseDir, "conversations");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "2026-10-29.jsonl");
  const line = JSON.stringify({
    sessionKey: SESSION_KEY,
    sessionId: opts.sessionId,
    recordedAt: opts.recordedAt,
    id: opts.id,
    role: "user",
    content: opts.content,
    timestamp: opts.timestamp,
  });
  await fs.appendFile(file, `${line}\n`, "utf-8");
}

/** Build an LLM runner that always returns the same text. */
function llmReturning(text: string): LLMRunner {
  return {
    async run() {
      return text;
    },
  };
}

/** Build an LLM runner that fails with the given error. */
function llmFailing(message: string): LLMRunner {
  return {
    async run() {
      throw new Error(message);
    },
  };
}

/** A well-formed extraction response with one memory. */
const EXTRACTION_RESPONSE = JSON.stringify([
  {
    scene_name: "introduction",
    message_ids: ["m1"],
    memories: [
      {
        content: "The user's favourite language is TypeScript.",
        type: "persona",
        priority: 60,
        source_message_ids: ["m1"],
        metadata: {},
      },
    ],
  },
]);

describe("createL1Runner — L1 cursor on extraction failure", () => {
  let baseDir: string;
  let logger: CapturingLogger;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-failure-"));
    logger = createLogger();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  function createRunner(llmRunner: LLMRunner) {
    return createL1Runner({
      pluginDataDir: baseDir,
      cfg: parseConfig({ extraction: { enableDedup: false } }),
      openclawConfig: {},
      vectorStore: undefined,
      embeddingService: undefined,
      logger,
      llmRunner,
    });
  }

  async function readCursor(): Promise<number> {
    const cp = await new CheckpointManager(baseDir).read();
    return cp.runner_states[SESSION_KEY]?.last_l1_cursor ?? 0;
  }

  async function readStoredMemories(): Promise<string[]> {
    const dir = path.join(baseDir, "records");
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const lines: string[] = [];
    for (const name of entries) {
      const raw = await fs.readFile(path.join(dir, name), "utf-8");
      for (const line of raw.split("\n")) {
        if (line.trim()) lines.push(line);
      }
    }
    return lines;
  }

  it("keeps the L1 cursor when the LLM call fails", async () => {
    await writeL0Message({
      baseDir,
      sessionId: "g1",
      id: "m1",
      content: "Hi, I mostly write TypeScript these days.",
      recordedAt: T1,
      timestamp: T1_MS,
    });

    const runner = createRunner(llmFailing("upstream 503 Service Unavailable"));

    await expect(runner({ sessionKey: SESSION_KEY })).rejects.toBeInstanceOf(L1ExtractionError);
    expect(await readCursor()).toBe(0);
    // The failure must be visible, not a silent "0 extracted" run.
    expect(logger.errors.some((m) => m.includes("L1 failed"))).toBe(true);
  });

  it("keeps the L1 cursor when the LLM response cannot be parsed", async () => {
    await writeL0Message({
      baseDir,
      sessionId: "g1",
      id: "m1",
      content: "Hi, I mostly write TypeScript these days.",
      recordedAt: T1,
      timestamp: T1_MS,
    });

    // Prose instead of the expected JSON array — a truncated or garbled answer.
    const runner = createRunner(llmReturning("I'm sorry, I cannot extract memories from this."));

    await expect(runner({ sessionKey: SESSION_KEY })).rejects.toBeInstanceOf(L1ExtractionError);
    expect(await readCursor()).toBe(0);
  });

  it("re-processes the failed batch on the next run instead of dropping it", async () => {
    await writeL0Message({
      baseDir,
      sessionId: "g1",
      id: "m1",
      content: "Hi, I mostly write TypeScript these days.",
      recordedAt: T1,
      timestamp: T1_MS,
    });

    const failing = createRunner(llmFailing("upstream 503 Service Unavailable"));
    await expect(failing({ sessionKey: SESSION_KEY })).rejects.toBeInstanceOf(L1ExtractionError);
    expect(await readCursor()).toBe(0);

    // The upstream recovers — the very same batch must be extracted now.
    const recovered = createRunner(llmReturning(EXTRACTION_RESPONSE));
    await expect(recovered({ sessionKey: SESSION_KEY })).resolves.toEqual({ processedCount: 1 });

    expect(await readCursor()).toBe(T1_MS);
    const stored = await readStoredMemories();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("TypeScript");
  });

  it("advances the L1 cursor for a valid but empty extraction", async () => {
    await writeL0Message({
      baseDir,
      sessionId: "g1",
      id: "m1",
      content: "Hi, I mostly write TypeScript these days.",
      recordedAt: T1,
      timestamp: T1_MS,
    });

    // A valid response with nothing worth remembering must still move the
    // cursor, otherwise the same batch would be re-read on every single run.
    const runner = createRunner(llmReturning("[]"));

    await expect(runner({ sessionKey: SESSION_KEY })).resolves.toEqual({ processedCount: 1 });
    expect(await readCursor()).toBe(T1_MS);
  });

  it("advances the L1 cursor and persists the memories on success", async () => {
    await writeL0Message({
      baseDir,
      sessionId: "g1",
      id: "m1",
      content: "Hi, I mostly write TypeScript these days.",
      recordedAt: T1,
      timestamp: T1_MS,
    });

    const runner = createRunner(llmReturning(EXTRACTION_RESPONSE));

    await expect(runner({ sessionKey: SESSION_KEY })).resolves.toEqual({ processedCount: 1 });
    expect(await readCursor()).toBe(T1_MS);
    expect(await readStoredMemories()).toHaveLength(1);
  });

  it("advances the cursor only over the groups that were extracted", async () => {
    await writeL0Message({
      baseDir,
      sessionId: "g1",
      id: "m1",
      content: "Hi, I mostly write TypeScript these days.",
      recordedAt: T1,
      timestamp: T1_MS,
    });
    await writeL0Message({
      baseDir,
      sessionId: "g2",
      id: "m2",
      content: "I also enjoy reading about databases in the evening.",
      recordedAt: T2,
      timestamp: T2_MS,
    });

    // First group succeeds, second group fails.
    let call = 0;
    const runner = createRunner({
      async run() {
        call += 1;
        if (call === 1) return EXTRACTION_RESPONSE;
        throw new Error("upstream 503 Service Unavailable");
      },
    });

    await expect(runner({ sessionKey: SESSION_KEY })).rejects.toBeInstanceOf(L1ExtractionError);

    // The cursor stops right after the extracted group — the failed group is
    // still pending and will be retried.
    expect(await readCursor()).toBe(T1_MS);
  });
});
