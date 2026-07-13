/**
 * Tests for memory-tencentdb adapter self-healing and degraded behavior.
 *
 * Mirrors the Hermes test_memory_tencentdb_recovery.py scope for Codex:
 * request-path failures must not break the host agent. Hooks degrade to
 * empty recall context or skipped capture output, and successful capture
 * clears the prompt cache.
 */

import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi, afterEach } from "vitest";
import { codexMemoryAdapter } from "../adapter.js";
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

    await runRecallHook(codexMemoryAdapter, {
      stdin: stdinFrom({ session_id: "codex-session", prompt: "remember my name" }),
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
    expect(cache.get("codex-session")).toBe("remember my name");
  });

  it("recall hook recovers on the request path when Gateway responds again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ context: "User prefers TypeScript", memory_count: 1 }),
    }));
    const cache = new MemoryPromptCache();
    const io = captureStdout();

    await runRecallHook(codexMemoryAdapter, {
      stdin: stdinFrom({ session_id: "codex-session", prompt: "what do I prefer?" }),
      stdout: io.stdout,
      cache,
    });

    expect(io.read().hookSpecificOutput.additionalContext).toBe("User prefers TypeScript");
    expect(cache.get("codex-session")).toBe("what do I prefer?");
  });

  it("capture hook degrades without blocking Codex when Gateway capture fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Gateway unavailable" }),
    }));
    const cache = new MemoryPromptCache();
    cache.set("codex-session", "My name is Alex");
    const io = captureStdout();

    await runCaptureHook(codexMemoryAdapter, {
      stdin: stdinFrom({ session_id: "codex-session", last_assistant_message: "Got it" }),
      stdout: io.stdout,
      cache,
      logger: { warn: vi.fn() },
    });

    expect(io.read()).toEqual({ continue: true });
    expect(cache.get("codex-session")).toBe("My name is Alex");
    expect(cache.deleteCalls).toEqual([]);
  });

  it("capture hook deletes prompt cache after successful capture", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ l0_recorded: 1, scheduler_notified: true }),
    }));
    const cache = new MemoryPromptCache();
    cache.set("codex-session", "My name is Alex");
    const io = captureStdout();

    await runCaptureHook(codexMemoryAdapter, {
      stdin: stdinFrom({ session_id: "codex-session", last_assistant_message: "Got it" }),
      stdout: io.stdout,
      cache,
    });

    expect(io.read()).toEqual({ continue: true });
    expect(cache.get("codex-session")).toBeNull();
    expect(cache.deleteCalls).toEqual(["codex-session"]);
  });
});
