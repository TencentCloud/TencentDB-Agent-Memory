import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayClient,
  createMemoryRuntime,
  createMimoMemoryPlugin,
  formatRecallContext,
  latestTrajectoryText,
  makeSessionKey,
  readConfig,
  textFromParts,
  type MemoryRuntime,
} from "../../mimo-adapter/tdai-memory.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function pluginInput() {
  return {
    client: {
      app: {
        log: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as never;
}

function userMessage(text: string, synthetic = false) {
  return {
    role: "user" as const,
    id: "user-1",
    agent: "build",
    created: 1,
    parts: [{ type: "text", text, synthetic }],
  };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    id: "assistant-1",
    agent: "build",
    created: 2,
    parts: [{ type: "text", text }],
  };
}

function runtime(overrides: Partial<MemoryRuntime> = {}): MemoryRuntime {
  return {
    recall: vi.fn().mockResolvedValue(""),
    capture: vi.fn().mockResolvedValue(null),
    sessionEnd: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("GatewayClient", () => {
  it("sends Gateway-compatible lifecycle requests with Bearer auth", async () => {
    const requests: Array<{
      url: string;
      body: unknown;
      authorization?: string;
    }> = [];
    const server = createServer(async (request, response) => {
      requests.push({
        url: request.url ?? "",
        body: await requestBody(request),
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ context: "remembered" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${address.port}/`,
      apiKey: "test-token",
      timeoutMs: 1_000,
    });
    await client.recall("query", "mimo_session");
    await client.capture("user turn", "assistant turn", "mimo_session");
    await client.sessionEnd("mimo_session");

    expect(requests).toEqual([
      {
        url: "/recall",
        authorization: "Bearer test-token",
        body: { query: "query", session_key: "mimo_session" },
      },
      {
        url: "/capture",
        authorization: "Bearer test-token",
        body: {
          user_content: "user turn",
          assistant_content: "assistant turn",
          session_key: "mimo_session",
        },
      },
      {
        url: "/session/end",
        authorization: "Bearer test-token",
        body: { session_key: "mimo_session" },
      },
    ]);
  });

  it("returns null instead of throwing when the Gateway is unreachable", async () => {
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 50,
    });

    await expect(client.recall("query", "session")).resolves.toBeNull();
    await expect(client.capture("user", "assistant", "session")).resolves.toBeNull();
    await expect(client.sessionEnd("session")).resolves.toBeNull();
  });
});

describe("runtime and text helpers", () => {
  it("uses stable MiMo session keys and the shared API-key fallback", () => {
    expect(makeSessionKey("ses_123")).toBe("mimo_ses_123");
    expect(readConfig({ TDAI_GATEWAY_API_KEY: "shared-secret" }).apiKey).toBe(
      "shared-secret",
    );
  });

  it("keeps non-synthetic text and excludes injected/internal parts", () => {
    const parts = [
      { type: "text", text: "Current question" },
      { type: "text", text: "Internal reminder", synthetic: true },
      { type: "reasoning", text: "Private reasoning" },
      { type: "text", text: "Ignored", ignored: true },
    ];

    expect(textFromParts(parts as never)).toBe("Current question");
    expect(
      latestTrajectoryText(
        [
          userMessage("Earlier question"),
          userMessage("Synthetic continuation", true),
        ],
        "user",
      ),
    ).toBe("Earlier question");
  });

  it("maps raw Gateway responses into the narrow memory runtime", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ context: "Remembered fact" }),
      capture: vi.fn().mockResolvedValue({ l0_recorded: 2 }),
      sessionEnd: vi.fn().mockResolvedValue({ flushed: true }),
    };
    const memory = createMemoryRuntime({ client: client as never });

    await expect(memory.recall("question", "ses_1")).resolves.toBe(
      "Remembered fact",
    );
    await memory.capture("user", "assistant", "ses_1");
    await memory.sessionEnd("ses_1");

    expect(client.recall).toHaveBeenCalledWith(
      "question",
      "mimo_ses_1",
      undefined,
    );
    expect(client.capture).toHaveBeenCalledWith(
      "user",
      "assistant",
      "mimo_ses_1",
      undefined,
    );
    expect(client.sessionEnd).toHaveBeenCalledWith(
      "mimo_ses_1",
      undefined,
    );
  });
});

describe("MiMo Code lifecycle plugin", () => {
  it("recalls on chat.message and projects context into every LLM step", async () => {
    const memory = runtime({
      recall: vi.fn().mockResolvedValue("User prefers Rust."),
    });
    const hooks = await createMimoMemoryPlugin({ runtime: memory })(pluginInput());
    const message = {
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
    };

    await hooks["chat.message"]?.(message, {
      message: {} as never,
      parts: [{ type: "text", text: "What language do I prefer?" }] as never,
    });
    const first = { system: ["Stable base prompt"] };
    const second = { system: ["Stable base prompt"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_1", model: {} as never },
      first,
    );
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_1", model: {} as never },
      second,
    );

    expect(memory.recall).toHaveBeenCalledWith(
      "What language do I prefer?",
      "ses_1",
    );
    expect(first.system).toEqual([
      "Stable base prompt",
      formatRecallContext("User prefers Rust."),
    ]);
    expect(second.system).toEqual(first.system);
  });

  it("does not duplicate an existing recall section", async () => {
    const memory = runtime({
      recall: vi.fn().mockResolvedValue("Earlier context"),
    });
    const hooks = await createMimoMemoryPlugin({ runtime: memory })(pluginInput());
    await hooks["chat.message"]?.(
      { sessionID: "ses_1" },
      {
        message: {} as never,
        parts: [{ type: "text", text: "Question" }] as never,
      },
    );
    const output = {
      system: [formatRecallContext("Already present")],
    };

    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_1", model: {} as never },
      output,
    );

    expect(output.system).toHaveLength(1);
  });

  it("captures only completed main-agent runs and clears recalled state", async () => {
    const memory = runtime({
      recall: vi.fn().mockResolvedValue("Earlier context"),
      capture: vi.fn().mockResolvedValue({ l0_recorded: 2 }),
    });
    const hooks = await createMimoMemoryPlugin({ runtime: memory })(pluginInput());
    await hooks["chat.message"]?.(
      { sessionID: "ses_1" },
      {
        message: {} as never,
        parts: [{ type: "text", text: "Remember this." }] as never,
      },
    );

    await hooks["session.post"]?.(
      {
        sessionID: "ses_1",
        agentID: "main",
        outcome: "completed",
        finalText: "Remembered.",
        trajectory: [
          userMessage("Remember this."),
          assistantMessage("Remembered."),
        ],
      },
      {},
    );
    const after = { system: ["Stable base prompt"] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_1", model: {} as never },
      after,
    );

    expect(memory.capture).toHaveBeenCalledWith(
      "Remember this.",
      "Remembered.",
      "ses_1",
    );
    expect(after.system).toEqual(["Stable base prompt"]);
  });

  it("does not capture subagents, failures, or cancelled runs", async () => {
    const memory = runtime();
    const hooks = await createMimoMemoryPlugin({ runtime: memory })(pluginInput());
    const base = {
      sessionID: "ses_1",
      finalText: "Answer",
      trajectory: [userMessage("Question"), assistantMessage("Answer")],
    };

    await hooks["session.post"]?.(
      { ...base, agentID: "explore", outcome: "completed" },
      {},
    );
    await hooks["session.post"]?.(
      { ...base, agentID: "main", outcome: "error" },
      {},
    );
    await hooks["session.post"]?.(
      { ...base, agentID: "main", outcome: "cancelled" },
      {},
    );

    expect(memory.capture).not.toHaveBeenCalled();
  });

  it("flushes the matching Gateway session when MiMo deletes a session", async () => {
    const memory = runtime();
    const hooks = await createMimoMemoryPlugin({ runtime: memory })(pluginInput());

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_1" } },
      } as never,
    });

    expect(memory.sessionEnd).toHaveBeenCalledWith("ses_1");
  });

  it("fails open when every memory operation throws", async () => {
    const memory = runtime({
      recall: vi.fn().mockRejectedValue(new Error("Gateway unavailable")),
      capture: vi.fn().mockRejectedValue(new Error("Gateway unavailable")),
      sessionEnd: vi.fn().mockRejectedValue(new Error("Gateway unavailable")),
    });
    const hooks = await createMimoMemoryPlugin({ runtime: memory })(pluginInput());

    await expect(
      hooks["chat.message"]?.(
        { sessionID: "ses_1" },
        {
          message: {} as never,
          parts: [{ type: "text", text: "Continue." }] as never,
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks["session.post"]?.(
        {
          sessionID: "ses_1",
          agentID: "main",
          outcome: "completed",
          finalText: "Completed normally.",
          trajectory: [
            userMessage("Continue."),
            assistantMessage("Completed normally."),
          ],
        },
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { info: { id: "ses_1" } },
        } as never,
      }),
    ).resolves.toBeUndefined();
  });
});
