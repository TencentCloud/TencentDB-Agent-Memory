import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "../client.js";
import { withL0Retry } from "../pending-writes.js";
import type { TdaiIdentity, TdaiMemoryConfig } from "../types.js";

const config: TdaiMemoryConfig = {
  enabled: true,
  endpoint: "http://memory-core.test",
  apiKey: "test-key",
  serviceId: "test-service",
  writeL0: true,
  recallL1: false,
  injectL2L3: false,
  l1Limit: 5,
  l2Limit: 3,
  timeoutMs: 1_000,
};

const identity: TdaiIdentity = {
  teamId: "team-1",
  userId: "user-1",
  agentId: "agent-1",
  sessionId: "session-1",
};

const messages = [{ role: "user" as const, content: "hello" }];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TdaiClient L0 writes", () => {
  it("rejects HTTP failures so retryable 503 responses are retried", async () => {
    const fetchMock = vi.fn(async () => new Response("temporarily unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TdaiClient(config);
    await expect(
      withL0Retry(() => client.addConversation(identity, messages), { attempts: 3, baseMs: 0 }),
    ).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable HTTP failures", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TdaiClient(config);
    await expect(
      withL0Retry(() => client.addConversation(identity, messages), { attempts: 3, baseMs: 0 }),
    ).rejects.toThrow("HTTP 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-zero gateway envelopes without retrying them", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 40003, message: "invalid request" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TdaiClient(config);
    await expect(
      withL0Retry(() => client.addConversation(identity, messages), { attempts: 3, baseMs: 0 }),
    ).rejects.toThrow("envelope code=40003");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
