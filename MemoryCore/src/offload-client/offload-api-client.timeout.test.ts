import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OffloadApiClient } from "./offload-api-client.js";

describe("OffloadApiClient timeouts", () => {
  let server: Server;
  let baseUrl: string;
  const stalled: ServerResponse[] = [];

  beforeEach(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        // Send headers + partial body, then stall forever.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"code":0,"data":');
        stalled.push(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const res of stalled.splice(0)) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("compaction aborts when the server stalls after sending headers", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const client = new OffloadApiClient(
      { serverUrl: baseUrl, apiKey: "k", serviceId: "s", ingestTimeoutMs: 200, compactionTimeoutMs: 200 } as any,
      logger as any,
    );
    const started = Date.now();
    const result = await client.compaction({
      sessionId: "s1",
      messages: [],
      ratio: 0.5,
      contextWindow: 1000,
      totalTokens: 10,
    });
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("compaction failed"));
  }, 10_000);
});
