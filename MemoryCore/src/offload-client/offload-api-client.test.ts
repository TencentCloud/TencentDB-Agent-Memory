import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OffloadApiClient } from "./offload-api-client.js";
import type { Logger, OffloadClientConfig } from "./types.js";

const config: OffloadClientConfig = {
  enabled: true,
  serverUrl: "http://127.0.0.1:9100",
  apiKey: "test-key",
  serviceId: "test-service",
  compactionRatio: 0.5,
  ingestTimeoutMs: 5_000,
  compactionTimeoutMs: 30_000,
};

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("OffloadApiClient timeout cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    ["health", (client: OffloadApiClient) => client.checkHealth()],
    ["ingest", (client: OffloadApiClient) => client.ingest("session-1", [])],
    ["L1.5 ingest", (client: OffloadApiClient) => client.ingestL15("session-1", "prompt")],
    ["compaction", (client: OffloadApiClient) => client.compaction({
      sessionId: "session-1",
      messages: [],
      ratio: 0.8,
      contextWindow: 128_000,
      totalTokens: 100_000,
    })],
  ])("clears the %s deadline after fetch rejects", async (_name, run) => {
    await run(new OffloadApiClient(config, logger));

    expect(vi.getTimerCount()).toBe(0);
  });
});
