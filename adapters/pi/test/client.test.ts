import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { TdaiMemoryClient } from "../src/client.js";
import type { PiMemoryConfig } from "../src/config.js";

interface SeenRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

type Responder = (request: SeenRequest, response: ServerResponse) => void | Promise<void>;

const openServers: Array<ReturnType<typeof createServer>> = [];

async function startServer(responder: Responder): Promise<{ endpoint: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    seen.push({
      path: request.url || "",
      headers: request.headers,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    await responder(seen[seen.length - 1]!, response);
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
    recallBudgetMs: 1_000,
    recallLimit: 5,
    scenarioLimit: 3,
    maxContextChars: 8_000,
    maxCaptureChars: 12_000,
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
  it("sends strict isolation and auth headers on capture", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 0, message: "ok", data: { accepted_ids: [], total_count: 2 } });
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await client.captureConversation({
      sessionId: "pi:session-1",
      user: "Remember TypeScript",
      assistant: "I will.",
      skillMessages: [],
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
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("captures ordered tool traces through the Skill pipeline", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 0, message: "ok", data: { status: "ok" } });
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await client.captureSkill({
      sessionId: "pi:session-1",
      user: "Run tests",
      assistant: "All pass.",
      capturedAtMs: 1_800_000_000_000,
      skillMessages: [
        { role: "user", content: "Run tests" },
        { role: "tool_call", content: '{"command":"npm test"}', tool_name: "bash", tool_call_id: "call-1" },
        { role: "tool_result", content: "ok", tool_name: "bash", tool_call_id: "call-1" },
        { role: "assistant", content: "All pass." },
      ],
    });

    expect(fixture.seen[0]?.path).toBe("/v3/skill/conversation/add");
    const messages = fixture.seen[0]?.body.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
  });

  it("recalls L1, L2, and L3 concurrently and tolerates partial failure", async () => {
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
          data: { entries: [{ path: "work.md", summary: "work context" }] },
        });
      } else {
        json(response, { code: 500, message: "down" }, 500);
      }
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    const bundle = await client.recall("typescript", undefined);

    expect(bundle.atomic).toHaveLength(1);
    expect(bundle.scenarios).toHaveLength(1);
    expect(bundle.core).toBeNull();
    expect(bundle.warnings).toHaveLength(1);
  });

  it("degrades L2/L3 gracefully when they exceed the recall budget", async () => {
    const fixture = await startServer(async (request, response) => {
      if (request.path === "/v3/atomic/search") {
        json(response, {
          code: 0,
          message: "ok",
          data: { items: [{ id: "m1", type: "preference", content: "Use TypeScript" }] },
        });
      } else {
        await new Promise((r) => setTimeout(r, 150));
        if (!response.writableEnded) json(response, { code: 0, message: "ok", data: {} });
      }
    });
    const client = new TdaiMemoryClient({ ...config(fixture.endpoint), recallBudgetMs: 50 });

    const bundle = await client.recall("typescript", undefined);

    expect(bundle.atomic).toHaveLength(1);
    expect(bundle.scenarios).toHaveLength(0);
    expect(bundle.core).toBeNull();
    expect(bundle.warnings.some((w) => w.includes("budget exceeded"))).toBe(true);
  });

  it("throws a typed error on a non-zero envelope code", async () => {
    const fixture = await startServer((_request, response) => {
      json(response, { code: 401, message: "unauthorized" }, 401);
    });
    const client = new TdaiMemoryClient(config(fixture.endpoint));

    await expect(client.searchAtomic("q", 5)).rejects.toMatchObject({
      name: "TdaiClientError",
      code: 401,
    });
  });
});
