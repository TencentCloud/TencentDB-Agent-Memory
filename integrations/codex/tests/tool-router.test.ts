import { describe, expect, it, vi } from "vitest";
import { ToolRouter } from "../src/tool-router.js";
import { ResultFormatter } from "../src/result-formatter.js";
import { SessionResolver } from "../src/session-resolver.js";
import type { CodexAdapterConfig } from "../src/types.js";

const config: CodexAdapterConfig = {
  gatewayUrl: "http://gateway", requestTimeoutMs: 1000, enableSupervisor: true,
  userId: "user", logDir: "logs", captureMode: "summary", resultMaxChars: 12_000,
};

describe("ToolRouter", () => {
  it("normalizes capture into a valid two-message turn", async () => {
    const capture = vi.fn().mockResolvedValue({ l0_recorded: 2, scheduler_notified: true });
    const client = { capture };
    const supervisor = { ensureRunning: vi.fn().mockResolvedValue(true), isRunning: vi.fn().mockResolvedValue(true) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const router = new ToolRouter(
      config,
      client as never,
      supervisor as never,
      new SessionResolver({ explicitSessionKey: "session" }),
      new ResultFormatter(),
      logger,
    );
    const result = await router.call("agent_memory_capture", { user_content: "request", assistant_content: "outcome" });
    expect(result.isError).toBeUndefined();
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      session_key: "session",
      messages: expect.arrayContaining([expect.objectContaining({ role: "user" }), expect.objectContaining({ role: "assistant" })]),
    }));
  });

  it("returns a non-fatal result when Gateway recovery fails", async () => {
    const supervisor = { ensureRunning: vi.fn().mockResolvedValue(false), isRunning: vi.fn().mockResolvedValue(false) };
    const router = new ToolRouter(
      config,
      {} as never,
      supervisor as never,
      new SessionResolver({ explicitSessionKey: "session" }),
      new ResultFormatter(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    const result = await router.call("agent_memory_recall", { query: "history" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("temporarily unavailable") });
  });
});
