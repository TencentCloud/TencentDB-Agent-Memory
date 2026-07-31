import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeMemoryRuntime } from "../src/plugin-runtime.js";
import { ResultFormatter } from "../src/result-formatter.js";
import { SessionResolver } from "../src/session-resolver.js";
import { SessionTracker } from "../src/session-tracker.js";
import type { MemoryService } from "../src/memory-service.js";

function createRuntime(tracker = new SessionTracker()) {
  const capture = vi.fn(async () => ({
    l0_recorded: 2,
    scheduler_notified: true,
  }));
  const recall = vi.fn(async () => ({
    context: "remembered",
    strategy: "hybrid",
    memory_count: 1,
  }));
  const sessionEnd = vi.fn(async () => ({ flushed: true }));
  const service = {
    client: { capture, recall, sessionEnd },
    run: async <T>(operation: () => Promise<T>) => operation(),
  } as unknown as MemoryService;
  const client = {
    session: {
      messages: vi.fn(async () => ({
        data: [
          {
            info: { id: "u1", sessionID: "s1", role: "user" },
            parts: [
              { type: "text", text: "request" },
              { type: "text", text: "recalled", synthetic: true },
            ],
          },
          {
            info: {
              id: "a1",
              sessionID: "s1",
              role: "assistant",
              parentID: "u1",
              time: { completed: 2 },
            },
            parts: [{ type: "text", text: "answer" }],
          },
        ],
      })),
    },
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const runtime = new OpenCodeMemoryRuntime(
    {
      gatewayUrl: "http://127.0.0.1:8420",
      requestTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      enableSupervisor: false,
      userId: "user",
      logDir: ".logs",
      resultMaxChars: 12_000,
    },
    client,
    process.cwd(),
    service,
    new SessionResolver({ cwd: process.cwd() }),
    tracker,
    new ResultFormatter(12_000),
    logger,
  );
  return { runtime, capture, recall, sessionEnd, client };
}

describe("OpenCodeMemoryRuntime", () => {
  it("recalls and returns a marked injection", async () => {
    const { runtime, recall } = createRuntime();
    const result = await runtime.recallForMessage("s1", "u1", [
      { type: "text", text: "question" },
    ]);
    expect(result).toContain("<memory-tencentdb-context>");
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ query: "question" }),
    );
  });

  it("captures a completed assistant message only once", async () => {
    const { runtime, capture } = createRuntime();
    await runtime.recallForMessage("s1", "u1", [
      { type: "text", text: "request" },
    ]);
    await runtime.captureSession("s1");
    await runtime.captureSession("s1");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        user_content: "request",
        assistant_content: "answer",
        messages: [
          { role: "user", content: "request" },
          { role: "assistant", content: "answer" },
        ],
      }),
    );
  });

  it("does not capture an accepted message again after a process restart", async () => {
    const stateDir = await mkdtemp(
      join(tmpdir(), "memory-tencentdb-opencode-"),
    );
    const stateFile = join(stateDir, "capture-state.json");
    try {
      const first = createRuntime(new SessionTracker(stateFile));
      await first.runtime.recallForMessage("s1", "u1", [
        { type: "text", text: "request" },
      ]);
      await first.runtime.captureSession("s1");
      expect(first.capture).toHaveBeenCalledTimes(1);

      const restarted = createRuntime(new SessionTracker(stateFile));
      await restarted.runtime.recallForMessage("s1", "u1", [
        { type: "text", text: "request" },
      ]);
      await restarted.runtime.captureSession("s1");
      expect(restarted.capture).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("performs a final capture and flush on session end", async () => {
    const { runtime, sessionEnd } = createRuntime();
    await runtime.recallForMessage("s1", "u1", [
      { type: "text", text: "request" },
    ]);
    await runtime.endSession("s1", true);
    expect(sessionEnd).toHaveBeenCalledTimes(1);
  });

  it("does not import old turns when attached to an existing session", async () => {
    const { runtime, capture } = createRuntime();
    await runtime.captureSession("s1");
    expect(capture).not.toHaveBeenCalled();
  });
});
