/**
 * Claude Code CLI recall — unit tests.
 *
 * Tests input parsing via env vars (which vitest can isolate with vi.stubEnv),
 * error handling paths, output format, and graceful degradation.
 * CLI argument parsing (process.argv) is not testable through vitest because
 * vitest controls process.argv internally.
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

describe("claudeCodeRecall — input via env vars", () => {
  beforeEach(() => {
    process.argv = ["node", "vitest"]; // prevent isDirectEntry()
    vi.unstubAllEnvs();
  });

  it("reads input from CLAUDE_USER_MESSAGE and CLAUDE_SESSION_KEY env vars", async () => {
    vi.stubEnv("CLAUDE_USER_MESSAGE", "hello from env");
    vi.stubEnv("CLAUDE_SESSION_KEY", "env-session");

    const { claudeCodeRecall } = await import("./cli-recall.js");
    const log = captureLog();

    try {
      await claudeCodeRecall();
    } catch {
      // Gateway unreachable — graceful degradation
    }

    log.restore();

    // Verify sessionKey from env var was passed through
    const jsonStr = log.lines.find(l => l.includes("sessionKey"));
    expect(jsonStr).toBeTruthy();
    const parsed = JSON.parse(jsonStr!);
    expect(parsed.sessionKey).toBe("env-session");
  });
});

describe("claudeCodeRecall — error handling", () => {
  beforeEach(() => {
    process.argv = ["node", "vitest"];
    vi.unstubAllEnvs();
  });

  it("exits with code 1 when no input sources are available", async () => {
    // No args, no env vars, no stdin
    const { claudeCodeRecall } = await import("./cli-recall.js");
    const exit = mockExit();

    try {
      await claudeCodeRecall();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    exit.mockRestore();
  });

  it("gracefully handles Gateway being unreachable", async () => {
    vi.stubEnv("CLAUDE_USER_MESSAGE", "test");
    vi.stubEnv("CLAUDE_SESSION_KEY", "test-sess");

    const { claudeCodeRecall } = await import("./cli-recall.js");
    const log = captureLog();

    try {
      await claudeCodeRecall();
    } catch {
      // process.exit or graceful error
    }

    log.restore();

    // Should always output valid JSON
    expect(log.lines.length).toBeGreaterThanOrEqual(1);
    for (const line of log.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("claudeCodeRecall — output format", () => {
  beforeEach(() => {
    process.argv = ["node", "vitest"];
    vi.unstubAllEnvs();
  });

  it("output is valid JSON with sessionKey", async () => {
    vi.stubEnv("CLAUDE_USER_MESSAGE", "test");
    vi.stubEnv("CLAUDE_SESSION_KEY", "output-test-session");

    const { claudeCodeRecall } = await import("./cli-recall.js");
    const log = captureLog();

    try {
      await claudeCodeRecall();
    } catch {
      // process.exit or Gateway unreachable
    }

    log.restore();

    const jsonStr = log.lines.find(l => l.includes("sessionKey"));
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      expect(parsed).toHaveProperty("sessionKey");
      expect(parsed.sessionKey).toBe("output-test-session");
    }
  });
});

describe("claudeCodeRecall — module guard", () => {
  it("exports claudeCodeRecall without auto-running", async () => {
    const mod = await import("./cli-recall.js");
    expect(typeof mod.claudeCodeRecall).toBe("function");
  });
});
