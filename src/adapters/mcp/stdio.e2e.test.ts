import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: Record<string, unknown>;
}

function readTextContent(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new TypeError("MCP tool result must contain content");
  }
  if (!Array.isArray(result.content)) {
    throw new TypeError("MCP tool result content must be an array");
  }
  const textItem = result.content.find((item): item is { type: "text"; text: string } => (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
  ));
  if (!textItem) throw new TypeError("MCP tool result has no text content");
  return textItem.text;
}

describe("MCP stdio adapter", () => {
  const requests: RecordedRequest[] = [];
  let gateway: http.Server;
  let gatewayUrl: string;

  beforeAll(async () => {
    gateway = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf-8");
      const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });

      response.setHeader("Content-Type", "application/json");
      if (request.url === "/recall") {
        response.end(JSON.stringify({
          context: "The user prefers TypeScript.",
          strategy: "hybrid",
          memory_count: 1,
        }));
        return;
      }
      if (request.url === "/capture") {
        response.end(JSON.stringify({
          l0_recorded: 2,
          scheduler_notified: true,
        }));
        return;
      }
      if (request.url === "/health") {
        response.end(JSON.stringify({
          status: "ok",
          version: "0.1.0",
          uptime: 1,
          stores: { vectorStore: true, embeddingService: true },
        }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(0, "127.0.0.1", resolve);
    });
    const address = gateway.address() as AddressInfo;
    gatewayUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      gateway.close((error) => error ? reject(error) : resolve());
    });
  });

  it("negotiates MCP and maps read/write tools to the Gateway", async () => {
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/mcp-server.mjs")],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        TDAI_MCP_GATEWAY_URL: gatewayUrl,
        TDAI_GATEWAY_API_KEY: "test-secret",
        TDAI_MCP_SESSION_KEY: "project-session",
        TDAI_MCP_USER_ID: "developer-1",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

    const client = new Client({
      name: "tdai-mcp-e2e",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("tencentdb-agent-memory");
      expect(client.getInstructions()).toContain("tdai_capture");

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "tdai_health",
        "tdai_recall",
        "tdai_capture",
        "tdai_memory_search",
        "tdai_conversation_search",
        "tdai_session_end",
      ]);
      expect(tools.tools.find((tool) => tool.name === "tdai_capture")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: false });

      const recall = await client.callTool({
        name: "tdai_recall",
        arguments: { query: "Which language should I use?" },
      }, CallToolResultSchema);
      expect(JSON.parse(readTextContent(recall)))
        .toMatchObject({
          context: "The user prefers TypeScript.",
          memory_count: 1,
        });

      const capture = await client.callTool({
        name: "tdai_capture",
        arguments: {
          user_content: "Use TypeScript",
          assistant_content: "Understood",
        },
      }, CallToolResultSchema);
      expect(JSON.parse(readTextContent(capture)))
        .toEqual({
          l0_recorded: 2,
          scheduler_notified: true,
        });
    } finally {
      await client.close();
    }

    expect(requests).toMatchObject([
      {
        method: "POST",
        path: "/recall",
        authorization: "Bearer test-secret",
        body: {
          query: "Which language should I use?",
          session_key: "project-session",
          user_id: "developer-1",
        },
      },
      {
        method: "POST",
        path: "/capture",
        authorization: "Bearer test-secret",
        body: {
          user_content: "Use TypeScript",
          assistant_content: "Understood",
          session_key: "project-session",
          user_id: "developer-1",
        },
      },
    ]);
    expect(stderr.join("")).toBe("");
  });
});
