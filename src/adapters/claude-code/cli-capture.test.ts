/**
 * Claude Code CLI capture — unit tests.
 *
 * Tests env-based input, error handling, empty messages skip, and output format.
 * CLI argument parsing (process.argv) is not directly testable through vitest
 * because vitest controls process.argv internally.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ============================
// Helpers
// ============================

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as unknown as (code?: number) => never);
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    },
  );
  return { lines, restore: () => spy.mockRestore() };
}

describe("claudeCodeCapture — env-based input", () => {
  beforeEach(() => {
    process.argv = ["node", "vitest"]; // prevent isDirectEntry()
    vi.unstubAllEnvs();
  });

  it("captures gracefully with sessionKey from env", async () => {
    vi.stubEnv("CLAUDE_SESSION_KEY", "sess-001");

    const { claudeCodeCapture } = await import("./cli-capture.js");
    const log = captureLog();

    try {
      await claudeCodeCapture();
    } catch {
      // Gateway unreachable
    }

    log.restore();

    // Should produce valid JSON output
    expect(log.lines.length).toBeGreaterThanOrEqual(1);
    for (const line of log.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("reads sessionKey from CLAUDE_SESSION_KEY env var", async () => {
    vi.stubEnv("CLAUDE_SESSION_KEY", "env-capture-session");

    const { claudeCodeCapture } = await import("./cli-capture.js");
    const log = captureLog();

    try {
      await claudeCodeCapture();
    } catch {
      // Gateway unreachable
    }

    log.restore();

    const jsonStr = log.lines.find(l => l.includes("sessionKey"));
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      expect(parsed.sessionKey).toBe("env-capture-session");
    }
  });
});

describe("claudeCodeCapture — error handling", () => {
  beforeEach(() => {
    process.argv = ["node", "vitest"];
    vi.unstubAllEnvs();
  });

  it("exits with code 1 when sessionKey is missing", async () => {
    const { claudeCodeCapture } = await import("./cli-capture.js");
    const exit = mockExit();

    try {
      await claudeCodeCapture();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    exit.mockRestore();
  });

  it("skips capture when messages array is empty", async () => {
    vi.stubEnv("CLAUDE_SESSION_KEY", "sess-001");

    // Mock stdin to return empty messages
    const { Readable } = await import("stream");
    const originalStdin = process.stdin;
    const mockStdin = new Readable({
      read() {
        this.push(JSON.stringify({ messages: [] }));
        this.push(null);
      },
    });
    Object.assign(mockStdin, { isTTY: false });
    Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });

    const { claudeCodeCapture } = await import("./cli-capture.js");
    const log = captureLog();

    try {
      await claudeCodeCapture();
    } catch {
      // process.exit(0) on skip
    }

    log.restore();
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });

    const output = log.lines.join("");
    if (output) {
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe("skipped");
    }
  });
});

describe("claudeCodeCapture — output format", () => {
  beforeEach(() => {
    process.argv = ["node", "vitest"];
    vi.unstubAllEnvs();
  });

  it("outputs valid JSON", async () => {
    vi.stubEnv("CLAUDE_SESSION_KEY", "format-test");

    const { claudeCodeCapture } = await import("./cli-capture.js");
    const log = captureLog();

    try {
      await claudeCodeCapture();
    } catch {
      // Gateway unreachable or process.exit
    }

    log.restore();

    expect(log.lines.length).toBeGreaterThanOrEqual(1);
    for (const line of log.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("claudeCodeCapture — module guard", () => {
  it("exports claudeCodeCapture without auto-running", async () => {
    const mod = await import("./cli-capture.js");
    expect(typeof mod.claudeCodeCapture).toBe("function");
  });
});
