import { describe, expect, it, vi } from "vitest";
import { LocalLlmClient } from "./index.js";

const llmMocks = vi.hoisted(() => ({
  callLlm: vi.fn(async () => JSON.stringify({
    file_action: "write",
    mmd_content: "flowchart TD\n  A-->B",
    node_mapping: {},
  })),
}));

vi.mock("./llm-caller.js", () => ({
  callLlm: llmMocks.callLlm,
}));

describe("LocalLlmClient", () => {
  it("uses the configured timeout for L2 generation", async () => {
    const client = new LocalLlmClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-test",
      model: "provider/model",
      timeoutMs: 4_321,
    });

    await client.l2Generate({
      existingMmd: null,
      newEntries: [],
      recentHistory: null,
      currentTurn: null,
      taskLabel: "task",
      mmdPrefix: "task",
      mmdCharCount: 0,
    });

    const [config, opts] = llmMocks.callLlm.mock.calls[0];
    const effectiveTimeoutMs = opts.timeoutMs ?? config.timeoutMs;
    expect(effectiveTimeoutMs).toBe(4_321);
  });
});
