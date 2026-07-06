/**
 * BasePlatformAdapter unit tests (offline, fake MemoryClient).
 */

import { describe, expect, it, vi } from "vitest";

import { BasePlatformAdapter } from "./base-platform-adapter.js";
import type { MemoryClient, RecallOutcome, CaptureOutcome } from "./types.js";

function createFakeClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    recall: vi.fn(async (): Promise<RecallOutcome> => ({ context: "ctx", memoryCount: 1 })),
    capture: vi.fn(async (): Promise<CaptureOutcome> => ({ l0Recorded: 2, schedulerNotified: true })),
    searchMemories: vi.fn(async () => ({ text: "", total: 0, strategy: "none", items: [] })),
    searchConversations: vi.fn(async () => ({ text: "", total: 0, items: [] })),
    endSession: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: "ok" as const, vectorStore: true, embeddingService: true })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Minimal concrete adapter exposing the protected helpers for testing. */
class TestAdapter extends BasePlatformAdapter {
  readonly platformName = "test-platform";
  async start(): Promise<void> {}
  recallForTest(query: string, sessionKey: string): Promise<RecallOutcome> {
    return this.safeRecall({ query, sessionKey });
  }
  captureForTest(): Promise<CaptureOutcome | undefined> {
    return this.safeCapture({ userContent: "u", assistantContent: "a", sessionKey: "s" });
  }
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("BasePlatformAdapter", () => {
  it("stop() closes the memory client", async () => {
    const client = createFakeClient();
    const adapter = new TestAdapter({ client, logger: silentLogger });

    await adapter.stop();

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("safeRecall passes params through and returns the outcome", async () => {
    const client = createFakeClient();
    const adapter = new TestAdapter({ client, logger: silentLogger });

    const outcome = await adapter.recallForTest("what do I like", "s1");

    expect(client.recall).toHaveBeenCalledWith({ query: "what do I like", sessionKey: "s1" });
    expect(outcome).toEqual({ context: "ctx", memoryCount: 1 });
  });

  it("safeRecall swallows errors, logs a warning, and degrades to empty context", async () => {
    const client = createFakeClient({
      recall: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    });
    const warn = vi.fn();
    const adapter = new TestAdapter({ client, logger: { ...silentLogger, warn } });

    const outcome = await adapter.recallForTest("q", "s");

    expect(outcome).toEqual({ context: "", memoryCount: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gateway down"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("test-platform"));
  });

  it("safeCapture swallows errors and returns undefined", async () => {
    const client = createFakeClient({
      capture: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const warn = vi.fn();
    const adapter = new TestAdapter({ client, logger: { ...silentLogger, warn } });

    const outcome = await adapter.captureForTest();

    expect(outcome).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("safeCapture returns the capture outcome on success", async () => {
    const adapter = new TestAdapter({ client: createFakeClient(), logger: silentLogger });

    const outcome = await adapter.captureForTest();

    expect(outcome).toEqual({ l0Recorded: 2, schedulerNotified: true });
  });
});
