/**
 * Tests for memory-tencentdb adapter self-healing and degraded behavior.
 *
 * Mirrors the Hermes test_memory_tencentdb_recovery.py scope for Claude Code:
 * request-path failures must not break the host agent. Hooks degrade to
 * empty recall context or skipped capture output, and successful capture
 * clears the prompt cache.
 */

import { Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeMemoryAdapter } from "../adapter.js";
import { runCaptureHook, runRecallHook } from "../../../../src/adapters/adapter-sdk/hook-runner.js";
import type { PromptCache } from "../../../../src/adapters/adapter-sdk/index.js";

class MemoryPromptCache implements PromptCache {
  readonly values = new Map<string, string>();
  cleanupCalls = 0;
  deleteCalls: string[] = [];

  get(sessionKey: string): string | null {
    return this.values.get(sessionKey) ?? null;
  }

  set(sessionKey: string, prompt: string): void {
    this.values.set(sessionKey, prompt);
  }

  delete(sessionKey: string): void {
    this.deleteCalls.push(sessionKey);
    this.values.delete(sessionKey);
  }

  cleanup(): void {
    this.cleanupCalls += 1;
  }
}

function stdinFrom(value: unknown) {
  return Readable.from([JSON.stringify(value)]);
}

function captureStdout() {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += Buffer.from(chunk).toString("utf-8");
      callback();
    },
  });
  return { stdout, read: () => JSON.parse(output) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MemoryTencentdbRecoveryTest", () => {
  it("recall hook returns empty context when Gateway is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const cache = new MemoryPromptCache();
    const io = captureStdout();

    await runRecallHook(claudeCodeMemoryAdapter, {
      stdin: stdinFrom({ session_id: "cc-session", prompt: "remember my name" }),
      stdout: io.stdout,
      cache,
      logger: { warn: vi.fn() },
    });

    expect(io.read()).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "",
      },
    });
    expect(cache.cleanupCalls).toBe(1);
    expect(cache.get("cc-session")).toBe("remember my name");
  });

  it("recall hook recovers on the request path when Gateway responds again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ context: "User prefers TypeScript", memory_count: 1 }),
    }));
    const cache = new MemoryPromptCache();
    const io = captureStdout();

    await runRecallHook(claudeCodeMemoryAdapter, {
      stdin: stdinFrom({ session_id: "cc-session", prompt: "what do I prefer?" }),
      stdout: io.stdout,
      cache,
    });

    expect(io.read().hookSpecificOutput.additionalContext).toBe("User prefers TypeScript");
    expect(cache.get("cc-session")).toBe("what do I prefer?");
  });

  it("capture hook degrades without blocking Claude Code when Gateway capture fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Gateway unavailable" }),
    }));
    const cache = new MemoryPromptCache();
    cache.set("cc-session", "My name is Alex");
    const io = captureStdout();

    await runCaptureHook(claudeCodeMemoryAdapter, {
      stdin: stdinFrom({ session_id: "cc-session", last_assistant_message: "Got it" }),
      stdout: io.stdout,
      cache,
      logger: { warn: vi.fn() },
    });

    expect(io.read()).toEqual({ continue: true });
    expect(cache.get("cc-session")).toBe("My name is Alex");
    expect(cache.deleteCalls).toEqual([]);
  });

  it("capture hook deletes prompt cache after successful capture", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ l0_recorded: 1, scheduler_notified: true }),
    }));
    const cache = new MemoryPromptCache();
    cache.set("cc-session", "My name is Alex");
    const io = captureStdout();

    await runCaptureHook(claudeCodeMemoryAdapter, {
      stdin: stdinFrom({ session_id: "cc-session", last_assistant_message: "Got it" }),
      stdout: io.stdout,
      cache,
    });

    expect(io.read()).toEqual({ continue: true });
    expect(cache.get("cc-session")).toBeNull();
    expect(cache.deleteCalls).toEqual(["cc-session"]);
  });

  it("capture hook can recover user and assistant text from Claude transcript", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ l0_recorded: 1, scheduler_notified: true }),
    }));
    const tmp = mkdtempSync(join(tmpdir(), "tdai-cc-transcript-"));
    const transcriptPath = join(tmp, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ message: { role: "user", content: "My name is Alex" } }),
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Got it" }] } }),
      ].join("\n"),
    );
    const cache = new MemoryPromptCache();
    const io = captureStdout();

    try {
      await runCaptureHook(claudeCodeMemoryAdapter, {
        stdin: stdinFrom({ session_id: "cc-session", transcript_path: transcriptPath }),
        stdout: io.stdout,
        cache,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(io.read()).toEqual({ continue: true });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/capture"),
      expect.objectContaining({
        body: JSON.stringify({
          user_content: "My name is Alex",
          assistant_content: "Got it",
          session_key: "cc-session",
        }),
      }),
    );
  });
});
