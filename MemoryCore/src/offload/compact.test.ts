/**
 * Tests for PR #863: OffloadContextEngine.compact() sessionKey fallback.
 *
 * Verifies that compact() resolves the session manager through the fallback
 * chain (sessionKey → sessionTarget.sessionKey → sessionId) when OpenClaw's
 * framework calls it without a sessionKey (issue #862).
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OffloadContextEngine.compact() sessionKey fallback", () => {
  it("resolves session manager from sessionKey when present", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    // Pre-resolve a session so it exists in the registry
    const ctx = await sessions.resolve("agent:main:test-session-1", "session-1");
    expect(ctx.manager).toBeDefined();

    const result = await engine.compact({
      sessionKey: "agent:main:test-session-1",
      sessionId: "session-1",
      tokenBudget: 1000000,
    });

    // compact should succeed because the manager is found
    expect(result).not.toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("falls back to sessionTarget.sessionKey when sessionKey is missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    // Pre-resolve a session via sessionTarget.sessionKey
    const ctx = await sessions.resolve("agent:main:target-session", "session-2");
    expect(ctx.manager).toBeDefined();

    const result = await engine.compact({
      sessionTarget: { sessionKey: "agent:main:target-session" },
      sessionId: "session-2",
      tokenBudget: 1000000,
    });

    // compact should resolve from sessionTarget.sessionKey
    expect(result).not.toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("falls back to sessionId when both sessionKey and sessionTarget are missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    // Pre-resolve a session
    const ctx = await sessions.resolve("agent:main:id-fallback-session", "session-3");
    expect(ctx.manager).toBeDefined();

    const result = await engine.compact({
      sessionId: "session-3",
      tokenBudget: 1000000,
    });

    // compact should resolve from sessionId
    expect(result).not.toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("returns no_session_manager when all sessionKey sources are missing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    const result = await engine.compact({
      tokenBudget: 1000000,
      // No sessionKey, sessionTarget, or sessionId
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("returns no_session_manager when sessionKey is null", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    const result = await engine.compact({
      sessionKey: null,
      tokenBudget: 1000000,
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("uses params._offloadManager when available (bypasses session resolution)", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    // Create a fake manager
    const fakeManager = {} as OffloadStateManager;

    const result = await engine.compact({
      sessionKey: "agent:main:pre-cached",
      sessionId: "session-4",
      _offloadManager: fakeManager,
      tokenBudget: 1000000,
    });

    // compact should use the pre-cached manager, not try to resolve from sessions
    // The result should not be no_session_manager
    expect(result).not.toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("skips internal memory sessions via resolveIfAllowed", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    // Internal memory sessions should be skipped by resolveIfAllowed
    const result = await engine.compact({
      sessionKey: "memory-l1-task-session-12345",
      sessionId: "mem-session-1",
      tokenBudget: 1000000,
    });

    // resolveIfAllowed returns null for memory sessions,
    // so compact should not find a manager
    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "no_session_manager",
    });
  });

  it("does not throw when session key is valid but sessionId is unknown", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);

    // Pre-resolve the session
    await sessions.resolve("agent:main:valid-key", "valid-session");

    // Call with a non-matching sessionId - resolveIfAllowed should still
    // return the existing session because it resolves by sessionKey
    const result = await engine.compact({
      sessionKey: "agent:main:valid-key",
      sessionId: "unknown-session-id",
      tokenBudget: 1000000,
    });

    // Should not throw; should try to resolve
    expect(result).toBeDefined();
  });
});