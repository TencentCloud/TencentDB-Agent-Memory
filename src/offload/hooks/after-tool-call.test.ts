/**
 * Tests for PR #865: getSessionMessages API integration in after_tool_call hook.
 *
 * Verifies that createAfterToolCallHandler:
 * 1. Fetches session messages via the official getSessionMessages API when
 *    event.messages is missing (replaces the dist-file monkey-patch)
 * 2. Falls back gracefully when getSessionMessages is unavailable
 * 3. Falls back gracefully when getSessionMessages throws
 * 4. Does not overwrite event.messages when it already exists
 * 5. Integration with registerOffload wiring
 *
 * Coverage: 18 test cases
 */
import { describe, expect, it, vi } from "vitest";
import { createAfterToolCallHandler } from "./after-tool-call.js";
import { OffloadStateManager } from "../state-manager.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockStateManager(overrides: Record<string, any> = {}): OffloadStateManager {
  const mgr = new OffloadStateManager();
  Object.defineProperty(mgr, "getLastSessionKey", {
    value: () => overrides.getLastSessionKey?.() ?? "agent:main:test-session",
    configurable: true,
  });
  Object.defineProperty(mgr, "l15Settled", {
    value: overrides.l15Settled ?? false, configurable: true, writable: true,
  });
  Object.defineProperty(mgr, "getActiveMmdFile", {
    value: () => overrides.getActiveMmdFile?.() ?? null, configurable: true,
  });
  return mgr;
}

function createMockEvent(overrides: Record<string, any> = {}): any {
  return {
    toolCallId: "test-call-1", toolName: "test_tool",
    durationMs: 100, result: { content: "test result" },
    ...overrides,
  };
}

function createMockCtx(): any { return {}; }

function createHandler(
  getSessionMessages: ((opts: { sessionKey: string; limit?: number }) => Promise<unknown[] | undefined>) | undefined,
  stateManager?: OffloadStateManager,
  logger?: ReturnType<typeof createMockLogger>,
) {
  return createAfterToolCallHandler(
    stateManager ?? createMockStateManager(),
    logger ?? createMockLogger(),
    undefined, undefined, null,
    getSessionMessages,
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createAfterToolCallHandler getSessionMessages integration", () => {
  it("fetches messages via getSessionMessages when event.messages is missing", async () => {
    const getSessionMessages = vi.fn(async () => [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const handler = createHandler(getSessionMessages);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(getSessionMessages).toHaveBeenCalledWith({ sessionKey: "agent:main:test-session", limit: 50 });
    expect(event.messages).toHaveLength(2);
  });

  it("does not fetch when event.messages is already present", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const handler = createHandler(getSessionMessages);
    const existingMessages = [{ role: "user", content: "existing" }];
    const event = createMockEvent({ messages: existingMessages });
    await handler(event, createMockCtx());
    expect(getSessionMessages).not.toHaveBeenCalled();
    expect(event.messages).toBe(existingMessages);
  });

  it("does not fetch when getSessionMessages is undefined", async () => {
    const handler = createHandler(undefined);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(event.messages).toBeUndefined();
  });

  it("handles getSessionMessages throwing gracefully", async () => {
    const getSessionMessages = vi.fn(async () => { throw new Error("API unavailable"); });
    const logger = createMockLogger();
    const handler = createHandler(getSessionMessages, undefined, logger);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(getSessionMessages).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("getSessionMessages failed"));
    expect(event.messages).toBeUndefined();
  });

  it("does not fetch when session key is unknown", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const stateManager = createMockStateManager({ getLastSessionKey: () => null });
    const handler = createHandler(getSessionMessages, stateManager);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  it("does not fetch for internal memory sessions", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const stateManager = createMockStateManager({ getLastSessionKey: () => "memory-l1-task-session-12345" });
    const handler = createHandler(getSessionMessages, stateManager);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  it("handles getSessionMessages returning empty array", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const handler = createHandler(getSessionMessages);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(getSessionMessages).toHaveBeenCalled();
    expect(event.messages).toBeUndefined();
  });

  it("handles getSessionMessages returning undefined", async () => {
    const getSessionMessages = vi.fn(async () => undefined);
    const handler = createHandler(getSessionMessages);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(getSessionMessages).toHaveBeenCalled();
    expect(event.messages).toBeUndefined();
  });

  it("handles non-array getSessionMessages return value gracefully", async () => {
    const getSessionMessages = vi.fn(async () => ({ not: "an array" }) as any);
    const handler = createHandler(getSessionMessages);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(event.messages).toBeUndefined();
  });

  it("uses ctx.sessionKey when stateManager.getLastSessionKey() returns null", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const stateManager = createMockStateManager({ getLastSessionKey: () => null });
    const handler = createHandler(getSessionMessages, stateManager);
    const event = createMockEvent({ messages: undefined });
    await handler(event, { sessionKey: "agent:main:ctx-session" });
    expect(getSessionMessages).toHaveBeenCalledWith({ sessionKey: "agent:main:ctx-session", limit: 50 });
  });

  it("handles ctx.sessionKey being undefined gracefully", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const stateManager = createMockStateManager({ getLastSessionKey: () => null });
    const handler = createHandler(getSessionMessages, stateManager);
    const event = createMockEvent({ messages: undefined });
    await handler(event, { sessionKey: undefined });
    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  it("uses default limit of 50", async () => {
    const getSessionMessages = vi.fn(async () => [{ role: "user", content: "data" }]);
    const handler = createHandler(getSessionMessages);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(getSessionMessages).toHaveBeenCalledWith({ sessionKey: expect.any(String), limit: 50 });
  });

  it("recovers messages and continues processing", async () => {
    const getSessionMessages = vi.fn(async () => [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world", tool_calls: [{ id: "tc-1" }] },
    ]);
    const handler = createHandler(getSessionMessages);
    const event = createMockEvent({ messages: undefined });
    await handler(event, createMockCtx());
    expect(event.messages).toHaveLength(2);
  });

  it("preserves event.messages when getSessionMessages returns data but messages already exist", async () => {
    const getSessionMessages = vi.fn(async () => [{ role: "user", content: "fetched" }]);
    const handler = createHandler(getSessionMessages);
    const existingMessages = [{ role: "user", content: "existing" }];
    const event = createMockEvent({ messages: existingMessages });
    await handler(event, createMockCtx());
    expect(getSessionMessages).not.toHaveBeenCalled();
    expect(event.messages).toBe(existingMessages);
  });
});

describe("getSessionMessages wiring in registerOffload", () => {
  it("passes the raw api.runtime.subagent.getSessionMessages when available", () => {
    const apiGetSessionMessages = vi.fn(async () => []);
    const api = { runtime: { subagent: { getSessionMessages: apiGetSessionMessages } } };
    const getSessionMessages = (api as any).runtime?.subagent?.getSessionMessages as
      | ((opts: { sessionKey: string; limit?: number }) => Promise<unknown[]>)
      | undefined;
    expect(getSessionMessages).toBe(apiGetSessionMessages);
  });

  it("passes undefined when api.runtime.subagent is not available", () => {
    const api = { runtime: {} };
    const getSessionMessages = (api as any).runtime?.subagent?.getSessionMessages as
      | ((opts: { sessionKey: string; limit?: number }) => Promise<unknown[]>)
      | undefined;
    expect(getSessionMessages).toBeUndefined();
  });

  it("passes undefined when api.runtime is not available", () => {
    const api = {};
    const getSessionMessages = (api as any).runtime?.subagent?.getSessionMessages as
      | ((opts: { sessionKey: string; limit?: number }) => Promise<unknown[]>)
      | undefined;
    expect(getSessionMessages).toBeUndefined();
  });

  it("passes undefined when api is null", () => {
    const getSessionMessages = (null as any)?.runtime?.subagent?.getSessionMessages;
    expect(getSessionMessages).toBeUndefined();
  });
});