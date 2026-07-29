import { describe, expect, it, vi } from "vitest";
import {
  combineRecallContext,
  runCodingAgentAdapter,
  type CodingAgentClient,
  type CodingAgentPlatformAdapter,
} from "./platform-adapter.js";

function createClient(): CodingAgentClient {
  return {
    health: vi.fn(async () => ({ status: "ok" })),
    recall: vi.fn(async () => ({ prepend_context: "dynamic", append_system_context: "stable" })),
    capture: vi.fn(async () => ({ l0_recorded: 1 })),
    endSession: vi.fn(async () => ({ flushed: true })),
  };
}

/**
 * A fictional platform integrated purely by implementing the single
 * CodingAgentPlatformAdapter interface — the "new platform = one interface"
 * acceptance goal of issue #235.
 */
const demoAdapter: CodingAgentPlatformAdapter<{ event: string; text?: string; id?: string }> = {
  platform: "demo",
  toEvent(input) {
    if (input.event === "prompt" && input.text && input.id) {
      return { kind: "recall", recall: { query: input.text, sessionKey: `demo:${input.id}` } };
    }
    if (input.event === "reply" && input.text && input.id) {
      return {
        kind: "capture",
        turn: { userContent: "q", assistantContent: input.text, sessionKey: `demo:${input.id}` },
      };
    }
    if (input.event === "close" && input.id) {
      return { kind: "session-end", sessionKey: `demo:${input.id}` };
    }
    return { kind: "noop" };
  },
  renderRecall(context) {
    return { inject: context };
  },
};

describe("unified coding-agent adapter SDK", () => {
  it("recalls and renders context via the platform interface", async () => {
    const client = createClient();
    const result = await runCodingAgentAdapter(demoAdapter, { event: "prompt", text: "hi", id: "1" }, { client });

    expect(client.recall).toHaveBeenCalledWith({ query: "hi", sessionKey: "demo:1" });
    expect(JSON.parse(result.stdout ?? "{}")).toEqual({ inject: "dynamic\n\nstable" });
  });

  it("captures a completed turn", async () => {
    const client = createClient();
    await runCodingAgentAdapter(demoAdapter, { event: "reply", text: "done", id: "1" }, { client });

    expect(client.capture).toHaveBeenCalledWith({
      userContent: "q",
      assistantContent: "done",
      sessionKey: "demo:1",
    });
  });

  it("flushes the session on close", async () => {
    const client = createClient();
    await runCodingAgentAdapter(demoAdapter, { event: "close", id: "1" }, { client });

    expect(client.endSession).toHaveBeenCalledWith("demo:1");
  });

  it("does nothing for unmapped events", async () => {
    const client = createClient();
    const result = await runCodingAgentAdapter(demoAdapter, { event: "unknown" }, { client });

    expect(result).toEqual({ exitCode: 0 });
    expect(client.recall).not.toHaveBeenCalled();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("fails open when the Gateway throws", async () => {
    const client = createClient();
    vi.mocked(client.recall).mockRejectedValue(new Error("connection refused"));

    const result = await runCodingAgentAdapter(demoAdapter, { event: "prompt", text: "hi", id: "1" }, { client });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("connection refused");
    expect(result.stderr).toContain("demo");
  });

  it("combines dynamic and stable context and strips the tool guide", () => {
    expect(combineRecallContext({
      prepend_context: "dynamic L1",
      append_system_context: "stable persona\n\n<memory-tools-guide>tools</memory-tools-guide>",
      context: "stable persona",
    })).toBe("dynamic L1\n\nstable persona");
  });
});
