import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayClient,
  formatRecallContext,
  injectRecallIntoMessages,
  readConfig,
} from "../../cline-adapter/tdai-memory/runtime.mjs";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

describe("GatewayClient", () => {
  it("sends Gateway-compatible recall and capture requests with Bearer auth", async () => {
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
    await client.recall("query", "cline_task");
    await client.capture("user turn", "assistant turn", "cline_task");

    expect(requests).toEqual([
      {
        url: "/recall",
        authorization: "Bearer test-token",
        body: { query: "query", session_key: "cline_task" },
      },
      {
        url: "/capture",
        authorization: "Bearer test-token",
        body: {
          user_content: "user turn",
          assistant_content: "assistant turn",
          session_key: "cline_task",
        },
      },
    ]);
  });

  it("returns null instead of throwing for network errors", async () => {
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 50,
    });
    await expect(client.recall("query", "session")).resolves.toBeNull();
  });
});

describe("configuration", () => {
  it("accepts the shared Gateway API key as a fallback", () => {
    expect(readConfig({ TDAI_GATEWAY_API_KEY: "shared-secret" }).apiKey).toBe(
      "shared-secret",
    );
  });
});

describe("recall message projection", () => {
  it("adds recalled context to the latest user message without mutating history", () => {
    const messages = [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "Current question" }],
        createdAt: 1,
      },
    ];
    const projected = injectRecallIntoMessages(messages, "Earlier preference");

    expect(projected).not.toBe(messages);
    expect(messages[0].content).toHaveLength(1);
    expect(projected[0].content[1].text).toBe(
      `\n\n${formatRecallContext("Earlier preference")}`,
    );
    expect(injectRecallIntoMessages(projected, "Earlier preference")).toBe(
      projected,
    );
  });
});
