import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  diagnosticText,
  MAX_CONVERSATION_MESSAGE_CHARS,
  MAX_SEARCH_QUERY_CHARS,
  TdaiMemoryClient,
} from "../src/client.js";
import type { PiMemoryConfig } from "../src/config.js";

interface SeenRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

type Responder = (
  request: SeenRequest,
  response: ServerResponse,
) => void | Promise<void>;

const openServers: Array<ReturnType<typeof createServer>> = [];

async function startServer(responder: Responder): Promise<{
  endpoint: string;
  seen: SeenRequest[];
}> {
  const seen: SeenRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const entry: SeenRequest = {
      path: request.url || "",
      headers: request.headers,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    };
    seen.push(entry);
    await responder(entry, response);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { endpoint: "http://127.0.0.1:" + address.port, seen };
}

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json", "x-trace-id": "trace-1" });
  response.end(JSON.stringify(data));
}

function config(endpoint: string): PiMemoryConfig {
  return {
    endpoint,
    apiKey: "api-secret",
    serviceId: "service-1",
    teamId: "team-1",
    agentId: "agent-1",
    userId: "user-1",
    taskId: "task-1",
    timeoutMs: 1_000,
    recallLimit: 5,
    scenarioLimit: 3,
    maxContextChars: 8_000,
    includeCore: true,
    includeScenarios: true,
    allowInsecureHttp: false,
  };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("TdaiMemoryClient", () => {
  it("captures a deterministic v3 turn with strict isolation and auth headers", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 0, message: "ok", data: { accepted_ids: [], total_count: 2 } });
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await client.captureTurn({
      sessionId: "pi:session-1",
      user: "Remember TypeScript",
      assistant: "I will.",
      capturedAtMs: 1_800_000_000_000,
    });

    expect(fixture.seen).toHaveLength(1);
    const request = fixture.seen[0]!;
    expect(request.path).toBe("/v3/conversation/add");
    expect(request.headers.authorization).toBe("Bearer api-secret");
    expect(request.headers["x-tdai-service-id"]).toBe("service-1");
    expect(request.body).toMatchObject({
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      task_id: "task-1",
      session_id: "pi:session-1",
    });
    const messages = request.body.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.map((message) => message.content)).toEqual([
      "Remember TypeScript",
      "I will.",
    ]);
  });

  it("recalls L1, L2, and L3 concurrently", async () => {
    const fixture = await startServer((request, response) => {
      if (request.path === "/v3/atomic/search") {
        json(response, {
          code: 0,
          message: "ok",
          data: { items: [{ id: "m1", type: "preference", content: "Use TypeScript" }] },
        });
      } else if (request.path === "/v3/scenario/ls") {
        json(response, {
          code: 0,
          message: "ok",
          data: { entries: [{ path: "coding.md", summary: "Project context" }] },
        });
      } else {
        json(response, { code: 0, message: "ok", data: { content: "Core profile" } });
      }
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    const recalled = await client.recall("language preference");

    expect(recalled.atomic[0]?.content).toBe("Use TypeScript");
    expect(recalled.scenarios[0]?.summary).toBe("Project context");
    expect(recalled.core).toBe("Core profile");
    expect(recalled.warnings).toEqual([]);
    expect(fixture.seen.map((request) => request.path).sort()).toEqual([
      "/v3/atomic/search",
      "/v3/core/read",
      "/v3/scenario/ls",
    ]);
  });

  it("returns partial recall when one memory layer is unavailable", async () => {
    const fixture = await startServer((request, response) => {
      if (request.path === "/v3/core/read") {
        json(response, { code: 503, message: "core unavailable" }, 503);
      } else {
        json(response, {
          code: 0,
          message: "ok",
          data:
            request.path === "/v3/atomic/search"
              ? { items: [{ id: "m1", type: "fact", content: "Still available" }] }
              : { entries: [] },
        });
      }
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    const recalled = await client.recall("query");

    expect(recalled.atomic).toHaveLength(1);
    expect(recalled.warnings.join(" ")).toContain("core unavailable");
  });

  it("fails when every recall layer fails", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 503, message: "offline" }, 503);
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));
    await expect(client.recall("query")).rejects.toThrow("offline");
  });

  it("requires L1 even when optional recall layers succeed", async () => {
    const fixture = await startServer((request, response) => {
      if (request.path === "/v3/atomic/search") {
        json(response, { code: 503, message: "atomic unavailable" }, 503);
      } else if (request.path === "/v3/core/read") {
        json(response, { code: 0, data: { content: "optional profile" } });
      } else {
        json(response, { code: 0, data: { entries: [{ path: "scenario.md" }] } });
      }
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await expect(client.recall("query")).rejects.toThrow("atomic unavailable");
  });

  it("does not send a request when the caller signal is already aborted", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 0, data: { total: 1 } });
    });
    const controller = new AbortController();
    controller.abort();
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await expect(client.check(controller.signal)).rejects.toThrow("aborted by caller");
    expect(fixture.seen).toHaveLength(0);
  });

  it("bounds both captured messages to the v3 message limit", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 0, data: { accepted_ids: [], total_count: 2 } });
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await client.captureTurn({
      sessionId: "pi:session-1",
      user: "u".repeat(MAX_CONVERSATION_MESSAGE_CHARS + 100),
      assistant: "a".repeat(MAX_CONVERSATION_MESSAGE_CHARS + 100),
      capturedAtMs: 1_800_000_000_000,
    });

    const messages = fixture.seen[0]!.body.messages as Array<Record<string, unknown>>;
    for (const message of messages) {
      expect(String(message.content).length).toBeLessThanOrEqual(MAX_CONVERSATION_MESSAGE_CHARS);
      expect(String(message.content)).toContain("[message truncated]");
    }
  });

  it("bounds semantic-search queries to the v3 schema limit", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 0, data: { items: [] } });
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await client.searchAtomic("q".repeat(MAX_SEARCH_QUERY_CHARS + 100), 5);

    expect(String(fixture.seen[0]!.body.query).length).toBe(MAX_SEARCH_QUERY_CHARS);
  });

  it("redacts credentials and bounds diagnostic text", () => {
    const diagnostic = diagnosticText(
      new Error(
        "Bearer super-secret-token password=top-secret " + "x".repeat(2_000),
      ),
    );
    expect(diagnostic).not.toContain("super-secret-token");
    expect(diagnostic).not.toContain("top-secret");
    expect(diagnostic.length).toBeLessThanOrEqual(512);
  });

  it("rejects malformed success responses", async () => {
    const fixture = await startServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("not-json");
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));
    await expect(client.check()).rejects.toThrow("not-json");
  });
});
