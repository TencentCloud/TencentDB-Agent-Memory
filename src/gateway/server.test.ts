import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";

import { TdaiGateway } from "./server.js";

type JsonObject = Record<string, unknown>;

function createRequest(pathname: string, body: JsonObject): http.IncomingMessage {
  const payload = JSON.stringify(body);
  const req = new Readable({
    read() {
      this.push(payload);
      this.push(null);
    },
  }) as http.IncomingMessage;
  req.method = "POST";
  req.url = pathname;
  req.headers = { host: "127.0.0.1" };
  return req;
}

function createResponse(): {
  res: http.ServerResponse;
  result: Promise<{ status: number; body: JsonObject }>;
} {
  let status = 200;
  let resolveResult!: (value: { status: number; body: JsonObject }) => void;

  const result = new Promise<{ status: number; body: JsonObject }>((resolve) => {
    resolveResult = resolve;
  });

  const res = {
    setHeader: () => undefined,
    writeHead: (nextStatus: number) => {
      status = nextStatus;
    },
    end: (chunk?: unknown) => {
      const rawBody = typeof chunk === "string" ? chunk : "";
      resolveResult({ status, body: JSON.parse(rawBody) as JsonObject });
    },
  } as unknown as http.ServerResponse;

  return { res, result };
}

function createGateway(context: string): TdaiGateway {
  const gateway = new TdaiGateway({
    data: { baseDir: "/tmp/tdai-gateway-test" },
    server: { host: "127.0.0.1", port: 0, apiKey: undefined, corsOrigins: [] },
  });

  (gateway as unknown as { logger: Record<string, () => void> }).logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  (gateway as unknown as { core: unknown }).core = {
    handleBeforeRecall: async () => ({
      appendSystemContext: context,
      recallStrategy: "keyword",
      recalledL1Memories: [{ content: "remember me", score: 0.9, type: "fact" }],
    }),
    handleSessionEnd: async () => undefined,
    getVectorStore: () => undefined,
    getEmbeddingService: () => undefined,
    destroy: async () => undefined,
  };

  return gateway;
}

async function post(gateway: TdaiGateway, pathname: string, body: JsonObject): Promise<JsonObject> {
  const req = createRequest(pathname, body);
  const { res, result } = createResponse();
  await (gateway as unknown as { handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> }).handleRequest(req, res);
  const response = await result;

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

describe("TdaiGateway recall dedup", () => {
  it("keeps recall responses unchanged unless dedup is requested", async () => {
    const gateway = createGateway("<user-persona>stable</user-persona>");

    const first = await post(gateway, "/recall", { query: "hello", session_key: "s1" });
    const second = await post(gateway, "/recall", { query: "hello again", session_key: "s1" });

    expect(first).toMatchObject({
      context: "<user-persona>stable</user-persona>",
      strategy: "keyword",
      memory_count: 1,
    });
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty("deduped");
  });

  it("suppresses repeated recall context only for dedup-enabled requests", async () => {
    const gateway = createGateway("<user-persona>stable</user-persona>");

    const first = await post(gateway, "/recall", { query: "hello", session_key: "s1", dedup: true });
    const second = await post(gateway, "/recall", { query: "hello again", session_key: "s1", dedup: true });

    expect(first).toMatchObject({
      context: "<user-persona>stable</user-persona>",
      memory_count: 1,
      deduped: false,
    });
    expect(second).toMatchObject({
      context: "",
      memory_count: 0,
      deduped: true,
    });
  });

  it("clears dedup state when the session ends", async () => {
    const gateway = createGateway("<user-persona>stable</user-persona>");

    await post(gateway, "/recall", { query: "hello", session_key: "s1", dedup: true });
    await post(gateway, "/recall", { query: "hello again", session_key: "s1", dedup: true });
    await post(gateway, "/session/end", { session_key: "s1" });
    const afterSessionEnd = await post(gateway, "/recall", { query: "new turn", session_key: "s1", dedup: true });

    expect(afterSessionEnd).toMatchObject({
      context: "<user-persona>stable</user-persona>",
      memory_count: 1,
      deduped: false,
    });
  });
});
