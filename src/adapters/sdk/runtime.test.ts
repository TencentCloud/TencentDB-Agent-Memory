import { describe, expect, it, vi } from "vitest";
import { createAdapterRuntime } from "./runtime.js";
import type { AdapterOperationStore, MemoryClient } from "./types.js";

function createClient(overrides: Partial<MemoryClient> = {}): MemoryClient {
  return {
    recall: vi.fn().mockResolvedValue({ context: "", strategy: undefined, memoryCount: 0 }),
    capture: vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true }),
    endSession: vi.fn().mockResolvedValue({ flushed: true }),
    searchMemories: vi.fn().mockResolvedValue({ results: "", total: 0, strategy: "keyword" }),
    searchConversations: vi.fn().mockResolvedValue({ results: "", total: 0 }),
    ...overrides,
  };
}

class MemoryOperationStore implements AdapterOperationStore {
  private readonly claimed = new Set<string>();
  private readonly completed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key) || this.completed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async complete(key: string): Promise<void> {
    this.claimed.delete(key);
    this.completed.add(key);
  }

  async release(key: string): Promise<void> {
    this.claimed.delete(key);
  }
}

describe("createAdapterRuntime", () => {
  it("returns trimmed recall context", async () => {
    const client = createClient({
      recall: vi.fn().mockResolvedValue({ context: "  remembered value  ", memoryCount: 1 }),
    });
    const runtime = createAdapterRuntime({ platform: "test", client });

    await expect(runtime.recall({ query: "question", sessionKey: "test:session" }))
      .resolves.toEqual({ context: "remembered value", memoryCount: 1 });
  });

  it("fails open and logs recall errors", async () => {
    const log = vi.fn();
    const runtime = createAdapterRuntime({
      platform: "test",
      client: createClient({ recall: vi.fn().mockRejectedValue(new Error("offline")) }),
      log,
    });

    await expect(runtime.recall({ query: "question", sessionKey: "test:session" }))
      .resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[test] recall failed open: offline");
  });

  it("ignores whitespace-only recall context", async () => {
    const runtime = createAdapterRuntime({
      platform: "test",
      client: createClient({
        recall: vi.fn().mockResolvedValue({ context: "   \n  ", memoryCount: 0 }),
      }),
    });

    await expect(runtime.recall({ query: "question", sessionKey: "test:session" }))
      .resolves.toBeUndefined();
  });

  it("distinguishes an empty successful recall from a failed recall", async () => {
    const recall = vi.fn()
      .mockResolvedValueOnce({ context: "   ", memoryCount: 0 })
      .mockRejectedValueOnce(new Error("offline"));
    const runtime = createAdapterRuntime({
      platform: "test",
      client: createClient({ recall }),
      log: vi.fn(),
    });

    await expect(runtime.recallOutcome({ query: "empty", sessionKey: "test:session" }))
      .resolves.toEqual({ ok: true, result: undefined });
    await expect(runtime.recallOutcome({ query: "failed", sessionKey: "test:session" }))
      .resolves.toEqual({ ok: false });
  });

  it("deduplicates successful capture operations", async () => {
    const capture = vi.fn().mockResolvedValue({ l0Recorded: 2, schedulerNotified: true });
    const runtime = createAdapterRuntime({
      platform: "test",
      client: createClient({ capture }),
      operationStore: new MemoryOperationStore(),
    });
    const input = {
      operationId: "turn-1",
      userContent: "hello",
      assistantContent: "hi",
      sessionKey: "test:session",
    };

    await Promise.all([runtime.capture(input), runtime.capture(input)]);
    await runtime.capture(input);

    expect(capture).toHaveBeenCalledOnce();
  });

  it("releases failed capture operations for retry", async () => {
    const capture = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ l0Recorded: 2, schedulerNotified: true });
    const runtime = createAdapterRuntime({
      platform: "test",
      client: createClient({ capture }),
      operationStore: new MemoryOperationStore(),
      log: vi.fn(),
    });
    const input = {
      operationId: "turn-1",
      userContent: "hello",
      assistantContent: "hi",
      sessionKey: "test:session",
    };

    await runtime.capture(input);
    await runtime.capture(input);

    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("runs the same session serially while allowing different sessions in parallel", async () => {
    const runtime = createAdapterRuntime({ platform: "test", client: createClient() });
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runtime.runExclusive("session-1", async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    });
    const second = runtime.runExclusive("session-1", async () => {
      events.push("second");
    });
    const other = runtime.runExclusive("session-2", async () => {
      events.push("other");
    });

    await vi.waitFor(() => expect(events).toEqual(["first-start", "other"]));
    releaseFirst?.();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["first-start", "other", "first-end", "second"]);
  });

  it("continues a session queue after an operation fails", async () => {
    const runtime = createAdapterRuntime({ platform: "test", client: createClient() });
    const events: string[] = [];

    await expect(runtime.runExclusive("session-1", async () => {
      events.push("failed");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await runtime.runExclusive("session-1", async () => {
      events.push("continued");
    });

    expect(events).toEqual(["failed", "continued"]);
  });

  it("waits for queued work when disposed", async () => {
    const runtime = createAdapterRuntime({ platform: "test", client: createClient() });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = runtime.runExclusive("session-1", () => gate);
    const dispose = runtime.dispose(1_000);

    let disposed = false;
    void dispose.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    release?.();
    await Promise.all([work, dispose]);
    expect(disposed).toBe(true);
  });
});