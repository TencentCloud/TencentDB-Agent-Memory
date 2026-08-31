import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { tiktokenCount } from "../../offload/context-token-tracker.js";
import { OpenAIEmbeddingService } from "./embedding.js";

const servers: http.Server[] = [];

async function endpoint(
  handler: (body: { input?: string[] }, attempt: number, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; attempts: () => number; inputs: string[][] }> {
  let attempts = 0;
  const inputs: string[][] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: string[] };
      inputs.push(body.input ?? []);
      attempts++;
      handler(body, attempts, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, attempts: () => attempts, inputs };
}

function sendVectors(res: http.ServerResponse, count: number): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    data: Array.from({ length: count }, (_, index) => ({ index, embedding: [1, 2, 3] })),
  }));
}

function service(baseUrl: string, overrides: Record<string, unknown> = {}): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: "openai",
    baseUrl,
    apiKey: "test",
    model: "bge-m3",
    dimensions: 3,
    sendDimensions: false,
    retryBaseDelayMs: 1,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("OpenAIEmbeddingService resilience", () => {
  it("token-budgets mixed CJK, emoji, and code without splitting Unicode", async () => {
    const remote = await endpoint((body, _attempt, res) => sendVectors(res, body.input?.length ?? 0));
    const embedding = service(remote.baseUrl, { maxInputChars: 10_000, maxInputTokens: 32 });
    const text = "香港資料庫🧬🚀 function example<T>(value: T) { return JSON.stringify(value); }".repeat(8);
    await embedding.embed(text);
    const sent = remote.inputs[0][0];
    expect(tiktokenCount(sent)).toBeLessThanOrEqual(32);
    expect(sent).not.toContain("�");
    expect(sent.length).toBeLessThan(text.length);
  });

  it("retries bounded 500 and 429 responses with observable counters", async () => {
    const remote = await endpoint((body, attempt, res) => {
      if (attempt === 1) {
        res.writeHead(500).end("server error");
      } else if (attempt === 2) {
        res.writeHead(429, { "retry-after": "0" }).end("rate limited");
      } else sendVectors(res, body.input?.length ?? 0);
    });
    const embedding = service(remote.baseUrl, { maxRetries: 2 });
    await expect(embedding.embed("retry me")).resolves.toHaveLength(3);
    expect(remote.attempts()).toBe(3);
    expect(embedding.getHealth()).toMatchObject({ state: "ready", requests: 1, failures: 0, retries: 2 });
  });

  it("retries timeouts only to the configured bound", async () => {
    const remote = await endpoint((_body, _attempt, _res) => {
      // Leave the response open until AbortSignal cancels the request.
    });
    const embedding = service(remote.baseUrl, { maxRetries: 1, timeoutMs: 15 });
    await expect(embedding.embed("timeout")).rejects.toThrow();
    expect(remote.attempts()).toBe(2);
    expect(embedding.getHealth()).toMatchObject({ state: "degraded", requests: 1, failures: 1, retries: 1 });
    expect(embedding.getHealth().lastError?.category).toBe("timeout");
  });

  it("preserves successful per-item progress and does not retry permanent 4xx", async () => {
    const remote = await endpoint((body, _attempt, res) => {
      if (body.input?.[0] === "bad") res.writeHead(400).end("invalid input");
      else sendVectors(res, body.input?.length ?? 0);
    });
    const embedding = service(remote.baseUrl, { maxRetries: 3 });
    const results = await embedding.embedBatchSettled(["bad", "good"]);
    expect(results[0]).toMatchObject({ error: expect.stringContaining("HTTP 400") });
    expect(results[1].embedding).toHaveLength(3);
    expect(remote.attempts()).toBe(2);
    expect(embedding.getHealth().failures).toBe(1);
  });
});
