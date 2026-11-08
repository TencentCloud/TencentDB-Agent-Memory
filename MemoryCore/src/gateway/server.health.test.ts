import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { TdaiGateway } from "./server.js";
import type { HealthCheckedStore } from "./health.js";
import type { HealthResponse } from "./types.js";

async function requestHealth(store: HealthCheckedStore | undefined, embeddingPresent: boolean) {
  // Exercise the real router and JSON handler without starting memory pipelines.
  const gateway = Object.assign(Object.create(TdaiGateway.prototype), {
    config: { server: { apiKey: "required-for-business-routes" }, offload: {} },
    core: {
      getVectorStore: () => store,
      getEmbeddingService: () => embeddingPresent ? {} : undefined,
    },
    logger: { error: () => {}, warn: () => {} },
    startTime: Date.now(),
  }) as { handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> };
  const server = http.createServer((req, res) => { void gateway.handleRequest(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    // Deliberately omit auth: /health remains a public liveness probe.
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Connection: "close" },
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.json() as HealthResponse,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe("GET /health compatibility", () => {
  it.each([
    {
      name: "uninitialized store",
      store: undefined,
      embeddingPresent: false,
      expectedStatus: "degraded",
      expectedStores: { vectorStore: false, vectorStoreStatus: "unavailable", embeddingService: false },
    },
    {
      name: "usable store without embeddings (BM25)",
      store: { isDegraded: () => false },
      embeddingPresent: false,
      expectedStatus: "ok",
      expectedStores: { vectorStore: true, vectorStoreStatus: "ok", embeddingService: false },
    },
    {
      name: "degraded store with a reason",
      store: { isDegraded: () => true, getDegradedReason: () => "sqlite-vec extension missing" },
      embeddingPresent: true,
      expectedStatus: "degraded",
      expectedStores: {
        vectorStore: true,
        vectorStoreStatus: "degraded",
        vectorStoreReason: "sqlite-vec extension missing",
        embeddingService: true,
      },
    },
    {
      name: "older degraded store without a reason",
      store: { isDegraded: () => true },
      embeddingPresent: false,
      expectedStatus: "degraded",
      expectedStores: { vectorStore: true, vectorStoreStatus: "degraded", embeddingService: false },
    },
  ])("preserves boolean presence and HTTP 200 for $name", async ({ store, embeddingPresent, expectedStatus, expectedStores }) => {
    const response = await requestHealth(store, embeddingPresent);

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(response.body.status).toBe(expectedStatus);
    expect(response.body.stores).toEqual(expectedStores);
    expect(typeof response.body.stores.vectorStore).toBe("boolean");
  });
});
