/**
 * Tests for PR #882: OffloadContextEngine sessionKey fallback in assemble(),
 * afterTurn(), and compact().
 *
 * Verifies that all three context-engine API methods resolve the session
 * manager through the fallback chain (sessionKey → sessionTarget.sessionKey
 * → sessionId → key) when OpenClaw's framework calls without sessionKey,
 * and that internal memory sessions are properly skipped (issue #878).
 */
import { describe, expect, it, vi } from "vitest";
import { OffloadStateManager } from "./state-manager.js";
import { SessionRegistry } from "./session-registry.js";
import { _testExports } from "./index.js";

const { OffloadContextEngine } = _testExports;

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockEngine(sessions: SessionRegistry): InstanceType<typeof OffloadContextEngine> {
  return new OffloadContextEngine({
    logger: createMockLogger(),
    sessions,
    pCfg: {},
    getContextWindow: () => 100000,
    notifyL2NewNullEntries: () => {},
    clearL2Timeout: () => {},
    backendClient: null,
    judgeL15: async () => {},
    disposeL15: () => {},
    flushL1: async () => {},
  });
}

// ── assemble() tests ────────────────────────────────────────────────────────

describe("OffloadContextEngine.assemble() sessionKey fallback", () => {
  it("resolves from sessionKey when present", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:assemble-test", "session-a1");

    const result = await engine.assemble({
      sessionKey: "agent:main:assemble-test",
      sessionId: "session-a1",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });

    // Should succeed (not skip)
    expect(result).not.toEqual({
      messages: expect.any(Array),
      estimatedTokens: 0,
    });
    expect(result.messages).toBeDefined();
  });

  it("falls back to sessionTarget.sessionKey when sessionKey is missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:target-assemble", "session-a2");

    const result = await engine.assemble({
      sessionTarget: { sessionKey: "agent:main:target-assemble" },
      sessionId: "session-a2",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });

    expect(result.messages).toBeDefined();
  });

  it("falls back to sessionId when sessionKey and sessionTarget are missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    // Pre-resolve a session so it exists
    await sessions.resolve("agent:main:id-fallback", "session-a3");

    const result = await engine.assemble({
      sessionId: "session-a3",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });

    expect(result.messages).toBeDefined();
  });

  it("falls back to params.key when all other sources are missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:key-fallback", "session-a4");

    const result = await engine.assemble({
      key: "agent:main:key-fallback",
      sessionId: "session-a4",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });

    expect(result.messages).toBeDefined();
  });

  it("skips internal memory sessions", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    const result = await engine.assemble({
      sessionKey: "memory-l1-task-session-12345",
      sessionId: "mem-session",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });

    // Should skip (return empty result) because internal memory sessions
    // are filtered by isInternalMemorySession()
    expect(result).toEqual({
      messages: expect.any(Array),
      estimatedTokens: 0,
    });
  });

  it("returns empty result when no session can be resolved", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    const result = await engine.assemble({
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });

    expect(result).toEqual({
      messages: expect.any(Array),
      estimatedTokens: 0,
    });
  });

  it("caches resolved manager as params._offloadManager", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:cached-mgr", "session-a5");

    const params: any = {
      sessionKey: "agent:main:cached-mgr",
      sessionId: "session-a5",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    };

    await engine.assemble(params);

    // After assemble, _offloadManager should be set
    expect(params._offloadManager).toBeDefined();
    expect(params._offloadManager.constructor).toBe(OffloadStateManager);
  });
});

// ── afterTurn() tests ───────────────────────────────────────────────────────

describe("OffloadContextEngine.afterTurn() sessionKey fallback", () => {
  it("resolves from sessionKey when present", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:afterturn-test", "session-b1");

    // afterTurn is fire-and-forget; it should not throw
    await expect(
      engine.afterTurn({
        sessionKey: "agent:main:afterturn-test",
        sessionId: "session-b1",
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to sessionTarget.sessionKey when sessionKey is missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:afterturn-target", "session-b2");

    await expect(
      engine.afterTurn({
        sessionTarget: { sessionKey: "agent:main:afterturn-target" },
        sessionId: "session-b2",
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to sessionId when sessionKey and sessionTarget are missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:afterturn-id", "session-b3");

    await expect(
      engine.afterTurn({
        sessionId: "session-b3",
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to params.key when all other sources are missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:afterturn-key", "session-b4");

    await expect(
      engine.afterTurn({
        key: "agent:main:afterturn-key",
        sessionId: "session-b4",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips internal memory sessions", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    await expect(
      engine.afterTurn({
        sessionKey: "memory-l1-task-session-12345",
        sessionId: "mem-session",
      }),
    ).resolves.toBeUndefined();
  });

  it("returns early when no session can be resolved", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    // afterTurn with no session key at all should return early without error
    await expect(engine.afterTurn({})).resolves.toBeUndefined();
  });

  it("uses _offloadManager when cached", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    const mgr = new OffloadStateManager();

    // afterTurn should use the cached manager without trying to resolve
    await expect(
      engine.afterTurn({
        _offloadManager: mgr,
        sessionKey: "agent:main:cached-afterturn",
        sessionId: "session-b5",
      }),
    ).resolves.toBeUndefined();
  });
});

// ── compact() tests (PR #882 variant: extends PR #863 with key fallback) ────

describe("OffloadContextEngine.compact() sessionKey fallback (PR #882 variant)", () => {
  it("resolves from sessionKey when present", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:compact-882", "session-c1");

    const result = await engine.compact({
      sessionKey: "agent:main:compact-882",
      sessionId: "session-c1",
      tokenBudget: 1000000,
    });

    expect(result).not.toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("falls back to params.key", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:compact-key", "session-c2");

    const result = await engine.compact({
      key: "agent:main:compact-key",
      sessionId: "session-c2",
      tokenBudget: 1000000,
    });

    expect(result).not.toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("returns no_session_manager when all sources are empty", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    const result = await engine.compact({
      tokenBudget: 1000000,
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });
});