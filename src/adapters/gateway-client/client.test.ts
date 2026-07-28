import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayMemoryClient } from "./client.js";
import {
  GatewayConfigurationError,
  GatewayHttpError,
  GatewayResponseError,
  GatewayTimeoutError,
  GatewayTransportError,
} from "./errors.js";
import { createGatewayPlatformAdapter } from "./platform-adapter.js";

interface SeenRequest {
  method: string;
  url: string;
  authorization?: string;
  body?: Record<string, unknown>;
}

const servers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

async function startServer(
  handler: (req: http.IncomingMessage, body: string) => {
    status?: number;
    contentType?: string;
    body: string;
  },
): Promise<{ baseUrl: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization:
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : undefined,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : undefined,
      });
      const result = handler(req, raw);
      res.writeHead(result.status ?? 200, {
        "Content-Type": result.contentType ?? "application/json",
      });
      res.end(result.body);
    });
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return { baseUrl: `http://127.0.0.1:${address.port}`, seen };
}

describe("GatewayMemoryClient", () => {
  it("maps every public method to the existing Gateway routes", async () => {
    const { baseUrl, seen } = await startServer((req) => {
      switch (req.url) {
        case "/health":
          return {
            body: JSON.stringify({
              status: "ok",
              version: "test",
              uptime: 1,
              stores: { vectorStore: true, embeddingService: false },
            }),
          };
        case "/recall":
          return { body: JSON.stringify({ context: "remembered" }) };
        case "/capture":
          return { body: JSON.stringify({ l0_recorded: 2, scheduler_notified: true }) };
        case "/search/memories":
          return { body: JSON.stringify({ results: "l1", total: 1, strategy: "fts" }) };
        case "/search/conversations":
          return { body: JSON.stringify({ results: "l0", total: 1 }) };
        case "/session/end":
          return { body: JSON.stringify({ flushed: true }) };
        default:
          return { status: 404, body: JSON.stringify({ error: "missing" }) };
      }
    });
    const client = new GatewayMemoryClient({ baseUrl, apiKey: " secret " });

    expect((await client.health()).status).toBe("ok");
    expect(
      await client.recall({ query: "q", sessionKey: "session", userId: "user" }),
    ).toEqual({ context: "remembered" });
    expect(
      await client.capture({
        userContent: "hello",
        assistantContent: "world",
        sessionKey: "session",
        sessionId: "turn",
        messages: [
          { role: "user", content: "hello", timestamp: 10 },
          { role: "assistant", content: "world", timestamp: 20 },
        ],
      }),
    ).toEqual({ l0_recorded: 2, scheduler_notified: true });
    expect(await client.searchMemories({ query: "q", limit: 3, type: "episodic" }))
      .toEqual({ results: "l1", total: 1, strategy: "fts" });
    expect(await client.searchConversations({ query: "q", sessionKey: "session" }))
      .toEqual({ results: "l0", total: 1 });
    expect(await client.endSession({ sessionKey: "session" })).toEqual({ flushed: true });

    expect(seen.map((request) => request.url)).toEqual([
      "/health",
      "/recall",
      "/capture",
      "/search/memories",
      "/search/conversations",
      "/session/end",
    ]);
    expect(seen.every((request) => request.authorization === "Bearer secret")).toBe(true);
    expect(seen[1].body).toEqual({
      query: "q",
      session_key: "session",
      user_id: "user",
    });
    expect(seen[2].body).toMatchObject({
      user_content: "hello",
      assistant_content: "world",
      session_key: "session",
      session_id: "turn",
    });
  });

  it("preserves a configured base path", async () => {
    const { baseUrl, seen } = await startServer(() => ({
      body: JSON.stringify({
        status: "ok",
        version: "test",
        uptime: 1,
        stores: { vectorStore: true, embeddingService: false },
      }),
    }));
    await new GatewayMemoryClient({ baseUrl: `${baseUrl}/gateway` }).health();
    expect(seen[0].url).toBe("/gateway/health");
  });

  it("rejects unsafe base URLs by default", () => {
    expect(() => new GatewayMemoryClient({ baseUrl: "ftp://127.0.0.1:8420" }))
      .toThrow(GatewayConfigurationError);
    expect(() => new GatewayMemoryClient({ baseUrl: "http://user:pass@127.0.0.1:8420" }))
      .toThrow(/credentials/);
    expect(() => new GatewayMemoryClient({ baseUrl: "https://memory.example.com" }))
      .toThrow(/allowRemote/);
    expect(() => new GatewayMemoryClient({
      baseUrl: "https://memory.example.com",
      allowRemote: true,
      fetch: vi.fn() as unknown as typeof fetch,
    })).not.toThrow();
  });

  it("surfaces non-2xx responses with status and body", async () => {
    const { baseUrl } = await startServer(() => ({
      status: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    }));
    const error = await new GatewayMemoryClient({ baseUrl }).recall({
      query: "q",
      sessionKey: "s",
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(GatewayHttpError);
    expect(error.status).toBe(401);
    expect(error.responseBody).toContain("Unauthorized");
  });

  it("distinguishes malformed JSON, timeouts, and transport failures", async () => {
    const { baseUrl } = await startServer(() => ({ body: "not-json" }));
    await expect(new GatewayMemoryClient({ baseUrl }).health())
      .rejects.toBeInstanceOf(GatewayResponseError);

    const timeoutFetch = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    ) as unknown as typeof fetch;
    await expect(new GatewayMemoryClient({
      timeoutMs: 5,
      fetch: timeoutFetch,
    }).health()).rejects.toBeInstanceOf(GatewayTimeoutError);

    const brokenFetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(new GatewayMemoryClient({ fetch: brokenFetch }).health())
      .rejects.toBeInstanceOf(GatewayTransportError);
  });

  it("rejects valid JSON that does not match the route response schema", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ status: "ok", stores: {} }),
    }));
    const error = await new GatewayMemoryClient({ baseUrl }).health()
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(GatewayResponseError);
    expect(error.reason).toBe("unexpected schema");
  });

  it("validates required text fields before making a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GatewayMemoryClient({ fetch: fetchImpl });
    expect(() => client.recall({ query: " ", sessionKey: "s" }))
      .toThrow(GatewayConfigurationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createGatewayPlatformAdapter", () => {
  it("maps prompt, turn, and session events through one PlatformBinding", async () => {
    const client = {
      recall: vi.fn(async () => ({ context: "ctx" })),
      capture: vi.fn(async () => ({ l0_recorded: 2, scheduler_notified: true })),
      endSession: vi.fn(async () => ({ flushed: true })),
    } as unknown as GatewayMemoryClient;
    type Event = { sessionKey: string; text?: string; assistant?: string };
    const adapter = createGatewayPlatformAdapter<Event, Event, Event, string>({
      getSessionIdentity: (event) => ({ sessionKey: event.sessionKey }),
      getRecallQuery: (event) => event.text ?? "",
      getCompletedTurn: (event) => event.assistant
        ? { userContent: event.text ?? "", assistantContent: event.assistant }
        : null,
      formatRecall: (response) => `<memory>${response.context}</memory>`,
    }, client);

    await expect(adapter.beforePrompt({ sessionKey: "s", text: "question" }))
      .resolves.toBe("<memory>ctx</memory>");
    await expect(adapter.turnCommitted({
      sessionKey: "s",
      text: "question",
      assistant: "answer",
    })).resolves.toEqual({ l0_recorded: 2, scheduler_notified: true });
    await expect(adapter.turnCommitted({ sessionKey: "s" })).resolves.toBeNull();
    await expect(adapter.sessionEnd({ sessionKey: "s" }))
      .resolves.toEqual({ flushed: true });

    expect(client.recall).toHaveBeenCalledWith({
      query: "question",
      sessionKey: "s",
      userId: undefined,
    });
    expect(client.capture).toHaveBeenCalledWith({
      userContent: "question",
      assistantContent: "answer",
      sessionKey: "s",
      sessionId: undefined,
      userId: undefined,
    });
  });
});
