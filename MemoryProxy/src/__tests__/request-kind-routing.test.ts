import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapRequestKindToCc } from "../common/cc-request-classifier.js";
import { opencodeAdapter } from "../agent-adapters/opencode.js";
import { workbuddyAdapter } from "../agent-adapters/workbuddy.js";
import { dshAdapter } from "../agent-adapters/dsh.js";
import { claudeCodeAdapter } from "../agent-adapters/claude-code.js";

const recordTurn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const handleSessionInitMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    intercepted: false,
    messages: [],
    sessionInfo: {
      user_id: "test-user",
      team_id: "test-team",
      agent_id: "test-agent",
      space_id: "default",
    },
  }),
);
const pipelineProcessMock = vi.hoisted(() =>
  vi.fn().mockImplementation((body, _opts) => Promise.resolve(body)),
);

vi.mock("../instance-upstream-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../instance-upstream-cache.js")>()),
  getInstanceUpstreamConfigs: async () => [],
}));

vi.mock("../tdai/recorder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tdai/recorder.js")>()),
  recordTdaiTurn: recordTurn,
}));

vi.mock("../session/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session/index.js")>();
  return {
    ...actual,
    handleSessionInit: handleSessionInitMock,
  };
});

vi.mock("../injection/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../injection/index.js")>();
  return {
    ...actual,
    getInjectionPipeline: () => ({
      process: pipelineProcessMock,
    }),
  };
});

import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";

describe("Request kind classification and auxiliary -> sidequery mapping", () => {
  it("maps adapter RequestKind accurately to CcRequestKind", () => {
    expect(mapRequestKindToCc("auxiliary")).toBe("sidequery");
    expect(mapRequestKindToCc("main")).toBe("main");
    expect(mapRequestKindToCc("fork")).toBe("fork");
    expect(mapRequestKindToCc("sidequery")).toBe("sidequery");
  });

  it("classifies representative client auxiliary requests across real adapters", () => {
    // OpenCode title generation
    expect(
      opencodeAdapter.classifyRequest({
        messages: [
          { role: "system", content: "You are a title generator. You output ONLY a thread title. Nothing else." },
          { role: "user", content: "Summarize this session" },
        ],
      }),
    ).toBe("auxiliary");

    // WorkBuddy memory consolidation
    expect(
      workbuddyAdapter.classifyRequest({
        client_metadata: { thread_source: "memory_consolidation" },
      }),
    ).toBe("auxiliary");

    // WorkBuddy memgen header
    expect(
      workbuddyAdapter.classifyRequest({}, "/v1/responses", {
        "x-openai-memgen-request": "true",
      }),
    ).toBe("auxiliary");

    // DSH compaction header
    expect(
      dshAdapter.classifyRequest({}, "/v1/chat/completions", {
        "x-deepseek-harness-compact": "1",
      }),
    ).toBe("auxiliary");

    // Claude Code: marker at n-2 is fork, marker at n-1 is main, tools empty + thinking disabled is sidequery
    expect(
      claudeCodeAdapter.classifyRequest({
        messages: [
          { role: "user", content: [{ type: "text", text: "t1", cache_control: { type: "ephemeral" } }] },
          { role: "assistant", content: "ans1" },
        ],
      }),
    ).toBe("fork");

    expect(
      claudeCodeAdapter.classifyRequest({
        messages: [
          { role: "user", content: [{ type: "text", text: "t1" }] },
          { role: "assistant", content: "ans1" },
          { role: "user", content: [{ type: "text", text: "t2", cache_control: { type: "ephemeral" } }] },
        ],
      }),
    ).toBe("main");

    expect(
      claudeCodeAdapter.classifyRequest({
        messages: [{ role: "user", content: "short title query" }],
        tools: [],
        thinking: { type: "disabled" },
      }),
    ).toBe("sidequery");
  });
});

describe("anthropicHandler behavior across auxiliary, main, and fork request kinds", () => {
  beforeEach(() => {
    recordTurn.mockClear();
    handleSessionInitMock.mockClear();
    pipelineProcessMock.mockClear();
  });

  function createTestConfig() {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://upstream.test/v1";
    config.ccRequestRouting = { enabled: true };
    config.sessionInit.enabled = true;
    config.injection.enabled = true;
    config.injection.injectors = ["skill", "knowledge", "tdai-memory"];
    config.tdai.enabled = true;
    config.tdai.endpoint = "http://memory.test";
    config.tdai.memory.enabled = true;
    config.tdai.memory.writeL0 = true;
    return config;
  }

  const anthropicResponse = JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Test response text" }],
    model: "test-model",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  it("auxiliary request (OpenCode title gen) skips session-init, injection, and L0 recording", async () => {
    const config = createTestConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(anthropicResponse, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/opencode/default/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conversation-id": "conv-aux-123",
        },
        body: JSON.stringify({
          model: "test-model",
          stream: false,
          messages: [
            {
              role: "system",
              content: "You are a title generator. You output ONLY a thread title. Nothing else.",
            },
            { role: "user", content: "What is quantum computing?" },
          ],
        }),
      });

      expect(response.status).toBe(200);
      // skipSessionInit: true -> handleSessionInit must NOT be called
      expect(handleSessionInitMock).not.toHaveBeenCalled();
      // skipInjection: true -> pipeline.process must NOT be called
      expect(pipelineProcessMock).not.toHaveBeenCalled();
      // isMainDialog: false -> recordTdaiTurn must NOT be called
      expect(recordTurn).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("main dialog request evaluates session-init, injection (readOnly=false), and records L0", async () => {
    const config = createTestConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(anthropicResponse, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/opencode/default/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conversation-id": "conv-main-123",
        },
        body: JSON.stringify({
          model: "test-model",
          stream: false,
          messages: [
            { role: "user", content: "Tell me about quantum computing" },
          ],
        }),
      });

      expect(response.status).toBe(200);
      // Main turn evaluates session-init
      expect(handleSessionInitMock).toHaveBeenCalled();
      // Main turn evaluates injection pipeline with readOnly: false
      expect(pipelineProcessMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ readOnly: false }),
      );
      // Main turn records L0 turn
      expect(recordTurn).toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("fork request (Claude Code recap/suggestion) evaluates injection with readOnly=true and skips L0", async () => {
    const config = createTestConfig();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(anthropicResponse, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/claude-code/default/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conversation-id": "conv-fork-123",
        },
        body: JSON.stringify({
          model: "test-model",
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "step 1", cache_control: { type: "ephemeral" } },
              ],
            },
            {
              role: "assistant",
              content: "step 1 completed",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      // Fork turn runs injection pipeline with readOnly: true (does not corrupt cache)
      expect(pipelineProcessMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ readOnly: true }),
      );
      // Fork turn is not main dialog -> skips L0 recording
      expect(recordTurn).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
