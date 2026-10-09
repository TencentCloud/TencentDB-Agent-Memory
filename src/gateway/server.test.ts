import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { TdaiGateway } from "./server.js";
import type { GatewayConfig } from "./config.js";

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTestGateway(): Promise<TdaiGateway> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-gateway-test-"));
  dataDirs.push(dataDir);

  const config: Partial<GatewayConfig> = {
    server: {
      port: 0,
      host: "127.0.0.1",
      apiKey: "test-token",
      corsOrigins: [],
    },
    data: { baseDir: dataDir },
    llm: {
      baseUrl: "http://127.0.0.1/v1",
      apiKey: "test-llm-key",
      model: "test-model",
      maxTokens: 16,
      timeoutMs: 100,
    },
    memory: parseConfig({
      extraction: { enabled: false },
      recall: { strategy: "keyword", timeoutMs: 100 },
      embedding: { provider: "none" },
    }),
  };

  return new TdaiGateway(config);
}

function authHeaders(): Record<string, string> {
  return {
    "authorization": "Bearer test-token",
    "content-type": "application/json",
  };
}

class FakeResponse {
  statusCode = 200;
  body = "";
  readonly headers = new Map<string, string | number | readonly string[]>();

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  writeHead(statusCode: number, headers?: Record<string, string | number>): this {
    this.statusCode = statusCode;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        this.setHeader(name, value);
      }
    }
    return this;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
    }
    return this;
  }
}

async function invokeGateway(
  gateway: TdaiGateway,
  params: { method: string; url: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; json: unknown }> {
  const req = Readable.from(params.body ? [Buffer.from(params.body)] : []) as unknown as {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = params.method;
  req.url = params.url;
  req.headers = {
    host: "localhost",
    ...(params.headers ?? {}),
  };

  const res = new FakeResponse();
  await (gateway as unknown as {
    handleRequest: (req: unknown, res: unknown) => Promise<void>;
  }).handleRequest(req, res);

  return { status: res.statusCode, json: JSON.parse(res.body) as unknown };
}

describe("TdaiGateway HTTP request parsing", () => {
  it("returns 400 for malformed JSON request bodies", async () => {
    const gateway = await createTestGateway();

    const response = await invokeGateway(gateway, {
      method: "POST",
      url: "/recall",
      headers: authHeaders(),
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: "Invalid JSON body" });
  });

  it("returns 413 before routing when the JSON body exceeds the gateway limit", async () => {
    const gateway = await createTestGateway();
    const oversizedBody = JSON.stringify({
      query: "x".repeat(8 * 1024 * 1024 + 1),
      session_key: "session-1",
    });

    const response = await invokeGateway(gateway, {
      method: "POST",
      url: "/recall",
      headers: authHeaders(),
      body: oversizedBody,
    });

    expect(response.status).toBe(413);
    expect(response.json).toEqual({ error: "Request body too large" });
  });
});
