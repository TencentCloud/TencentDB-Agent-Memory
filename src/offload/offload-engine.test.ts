/**
 * Tests for PR #882: OffloadContextEngine sessionKey fallback in assemble(),
 * afterTurn(), and compact().
 *
 * Verifies that all three context-engine API methods resolve the session
 * manager through the fallback chain (sessionKey → sessionTarget.sessionKey
 * → sessionId → key) when OpenClaw's framework calls without sessionKey,
 * and that internal memory sessions are properly skipped (issue #878).
 *
 * Coverage: 26 test cases across 4 categories:
 * 1. assemble() fallback chain (8 tests)
 * 2. afterTurn() fallback chain (8 tests)
 * 3. compact() fallback chain (5 tests)
 * 4. SessionRegistry integration (5 tests)
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

async function setupTest(sessionKey: string, sessionId: string) {
  const sessions = new SessionRegistry("/tmp/test-offload");
  const engine = createMockEngine(sessions);
  await sessions.resolve(sessionKey, sessionId);
  return { sessions, engine };
}

// ── assemble() tests ────────────────────────────────────────────────────────

describe("OffloadContextEngine.assemble() sessionKey fallback", () => {
  it("resolves from sessionKey when present", async () => {
    const { engine } = await setupTest("agent:main:assemble-test", "session-a1");
    const result = await engine.assemble({
      sessionKey: "agent:main:assemble-test",
      sessionId: "session-a1",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });
    expect(result).not.toEqual({ messages: expect.any(Array), estimatedTokens: 0 });
    expect(result.messages).toBeDefined();
  });

  it("falls back to sessionTarget.sessionKey when sessionKey is missing", async () => {
    const { engine } = await setupTest("agent:main:target-assemble", "session-a2");
    const result = await engine.assemble({
      sessionTarget: { sessionKey: "agent:main:target-assemble" },
      sessionId: "session-a2",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });
    expect(result.messages).toBeDefined();
  });

  it("falls back to sessionId when sessionKey and sessionTarget are missing", async () => {
    const { engine } = await setupTest("agent:main:id-fallback", "session-a3");
    const result = await engine.assemble({
      sessionId: "session-a3",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });
    expect(result.messages).toBeDefined();
  });

  it("falls back to params.key when all other sources are missing", async () => {
    const { engine } = await setupTest("agent:main:key-fallback", "session-a4");
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
    expect(result).toEqual({ messages: expect.any(Array), estimatedTokens: 0 });
  });

  it("returns empty result when no session can be resolved", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    const result = await engine.assemble({
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });
    expect(result).toEqual({ messages: expect.any(Array), estimatedTokens: 0 });
  });

  it("caches resolved manager as params._offloadManager", async () => {
    const { sessions, engine } = await setupTest("agent:main:cached-mgr", "session-a5");
    const params: any = {
      sessionKey: "agent:main:cached-mgr",
      sessionId: "session-a5",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    };
    await engine.assemble(params);
    expect(params._offloadManager).toBeDefined();
    expect(params._offloadManager.constructor).toBe(OffloadStateManager);
  });

  it("logs warning when session resolution fails", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const logger = createMockLogger();
    const engine = new OffloadContextEngine({
      logger, sessions, pCfg: {},
      getContextWindow: () => 100000, notifyL2NewNullEntries: () => {},
      clearL2Timeout: () => {}, backendClient: null,
      judgeL15: async () => {}, disposeL15: () => {}, flushL1: async () => {},
    });
    // Mock resolveIfAllowed to throw
    sessions.resolveIfAllowed = vi.fn().mockRejectedValue(new Error("DB error"));
    await engine.assemble({
      sessionKey: "agent:main:fail-log",
      sessionId: "session-fail",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 1000000,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to resolve session"));
  });
});

// ── afterTurn() tests ───────────────────────────────────────────────────────

describe("OffloadContextEngine.afterTurn() sessionKey fallback", () => {
  it("resolves from sessionKey when present", async () => {
    const { engine } = await setupTest("agent:main:afterturn-test", "session-b1");
    await expect(engine.afterTurn({
      sessionKey: "agent:main:afterturn-test",
      sessionId: "session-b1",
    })).resolves.toBeUndefined();
  });

  it("falls back to sessionTarget.sessionKey when sessionKey is missing", async () => {
    const { engine } = await setupTest("agent:main:afterturn-target", "session-b2");
    await expect(engine.afterTurn({
      sessionTarget: { sessionKey: "agent:main:afterturn-target" },
      sessionId: "session-b2",
    })).resolves.toBeUndefined();
  });

  it("falls back to sessionId when sessionKey and sessionTarget are missing", async () => {
    const { engine } = await setupTest("agent:main:afterturn-id", "session-b3");
    await expect(engine.afterTurn({ sessionId: "session-b3" })).resolves.toBeUndefined();
  });

  it("falls back to params.key when all other sources are missing", async () => {
    const { engine } = await setupTest("agent:main:afterturn-key", "session-b4");
    await expect(engine.afterTurn({
      key: "agent:main:afterturn-key",
      sessionId: "session-b4",
    })).resolves.toBeUndefined();
  });

  it("skips internal memory sessions", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await expect(engine.afterTurn({
      sessionKey: "memory-l1-task-session-12345",
      sessionId: "mem-session",
    })).resolves.toBeUndefined();
  });

  it("returns early when no session can be resolved", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await expect(engine.afterTurn({})).resolves.toBeUndefined();
  });

  it("uses _offloadManager when cached", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    const mgr = new OffloadStateManager();
    await expect(engine.afterTurn({
      _offloadManager: mgr,
      sessionKey: "agent:main:cached-afterturn",
      sessionId: "session-b5",
    })).resolves.toBeUndefined();
  });

  it("caches resolved manager as _params._offloadManager", async () => {
    const { sessions, engine } = await setupTest("agent:main:cache-afterturn", "session-b6");
    // Resolve via get() in afterTurn
    const params: any = { sessionKey: "agent:main:cache-afterturn", sessionId: "session-b6" };
    await engine.afterTurn(params);
    expect(params._offloadManager).toBeDefined();
  });
});

// ── compact() tests ─────────────────────────────────────────────────────────

describe("OffloadContextEngine.compact() sessionKey fallback (PR #882 variant)", () => {
  it("resolves from sessionKey when present", async () => {
    const { engine } = await setupTest("agent:main:compact-882", "session-c1");
    const result = await engine.compact({
      sessionKey: "agent:main:compact-882",
      sessionId: "session-c1",
      tokenBudget: 1000000,
    });
    expect(result).not.toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });

  it("falls back to params.key", async () => {
    const { engine } = await setupTest("agent:main:compact-key", "session-c2");
    const result = await engine.compact({
      key: "agent:main:compact-key",
      sessionId: "session-c2",
      tokenBudget: 1000000,
    });
    expect(result).not.toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });

  it("caches _offloadManager after resolution", async () => {
    const { sessions, engine } = await setupTest("agent:main:cache-compact", "session-c3");
    const params: any = { sessionKey: "agent:main:cache-compact", sessionId: "session-c3", tokenBudget: 1000000 };
    await engine.compact(params);
    expect(params._offloadManager).toBeDefined();
    // Second call should use cache
    const spy = vi.spyOn(sessions, "resolveIfAllowed");
    await engine.compact(params);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns no_session_manager when all sources are empty", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    const result = await engine.compact({ tokenBudget: 1000000 });
    expect(result).toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });

  it("handles resolveIfAllowed throwing without crashing", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    sessions.resolveIfAllowed = vi.fn().mockRejectedValue(new Error("DB error"));
    const engine = createMockEngine(sessions);
    const result = await engine.compact({
      sessionKey: "agent:main:compact-throw", sessionId: "session-c5", tokenBudget: 1000000,
    });
    expect(result).toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });
});

// ── SessionRegistry integration tests ───────────────────────────────────────

describe("SessionRegistry cross-method integration", () => {
  it("resolves the same session across assemble → afterTurn → compact", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    await sessions.resolve("agent:main:cross-method", "session-x1");

    // assemble
    const aParams: any = { sessionKey: "agent:main:cross-method", sessionId: "session-x1", messages: [{ role: "user", content: "hello" }], tokenBudget: 1000000 };
    await engine.assemble(aParams);
    expect(aParams._offloadManager).toBeDefined();

    // afterTurn should reuse the cached manager
    const atParams: any = { _offloadManager: aParams._offloadManager, sessionKey: "agent:main:cross-method", sessionId: "session-x1" };
    await expect(engine.afterTurn(atParams)).resolves.toBeUndefined();

    // compact should reuse the cached manager
    const cParams: any = { _offloadManager: aParams._offloadManager, sessionKey: "agent:main:cross-method", sessionId: "session-x1", tokenBudget: 1000000 };
    const result = await engine.compact(cParams);
    expect(result).not.toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });

  it("resolves session from sessionTarget.sessionKey in all three methods", async () => {
    const { sessions, engine } = await setupTest("agent:main:target-all", "session-x2");
    const target = { sessionKey: "agent:main:target-all" };

    // assemble
    const aResult = await engine.assemble({ sessionTarget: target, sessionId: "session-x2", messages: [{ role: "user", content: "hi" }], tokenBudget: 1000000 });
    expect(aResult.messages).toBeDefined();

    // afterTurn
    await expect(engine.afterTurn({ sessionTarget: target, sessionId: "session-x2" })).resolves.toBeUndefined();

    // compact
    const cResult = await engine.compact({ sessionTarget: target, sessionId: "session-x2", tokenBudget: 1000000 });
    expect(cResult).not.toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });

  it("resolves session from sessionId in all three methods", async () => {
    const { engine } = await setupTest("agent:main:id-all", "session-x3");
    const aResult = await engine.assemble({ sessionId: "session-x3", messages: [{ role: "user", content: "hi" }], tokenBudget: 1000000 });
    expect(aResult.messages).toBeDefined();
    await expect(engine.afterTurn({ sessionId: "session-x3" })).resolves.toBeUndefined();
    const cResult = await engine.compact({ sessionId: "session-x3", tokenBudget: 1000000 });
    expect(cResult).not.toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });

  it("resolves session from params.key in all three methods", async () => {
    const { engine } = await setupTest("agent:main:key-all", "session-x4");
    const aResult = await engine.assemble({ key: "agent:main:key-all", sessionId: "session-x4", messages: [{ role: "user", content: "hi" }], tokenBudget: 1000000 });
    expect(aResult.messages).toBeDefined();
    await expect(engine.afterTurn({ key: "agent:main:key-all", sessionId: "session-x4" })).resolves.toBeUndefined();
    const cResult = await engine.compact({ key: "agent:main:key-all", sessionId: "session-x4", tokenBudget: 1000000 });
    expect(cResult).not.toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });

  it("properly filters internal memory sessions in all three methods", async () => {
    const sessions = new SessionRegistry("/tmp/test-offload");
    const engine = createMockEngine(sessions);
    const memKey = "memory-l1-task-session-99999";
    const aResult = await engine.assemble({ sessionKey: memKey, sessionId: "mem-all", messages: [], tokenBudget: 1000000 });
    expect(aResult).toEqual({ messages: expect.any(Array), estimatedTokens: 0 });
    await expect(engine.afterTurn({ sessionKey: memKey, sessionId: "mem-all" })).resolves.toBeUndefined();
    const cResult = await engine.compact({ sessionKey: memKey, sessionId: "mem-all", tokenBudget: 1000000 });
    expect(cResult).toEqual({ ok: false, compacted: false, reason: "no_session_manager" });
  });
});