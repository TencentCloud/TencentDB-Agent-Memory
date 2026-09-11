import { describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { createMockDriver } from "../drivers/mock.js";
import { createMemoryAgent } from "../memory-agent.js";
import type { GatewaySupervisorLike, MemoryPaths } from "../types.js";

describe("MemoryAgent with an in-memory fake Gateway", () => {
  it("uses the real GatewayClient request mapping for recall, capture, and session end", async () => {
    const fakeGateway = new InMemoryFakeGateway();
    const gatewayUrl = "http://fake-gateway.local";
    const agent = createMemoryAgent({
      agentSdkName: "codex-sdk",
      driver: createMockDriver({
        responder: (input) => input.prompt.includes("Use the SDK adapter.")
          ? "captured through fake gateway"
          : "missing memory",
      }),
      gateway: new GatewayClient({ gatewayUrl, fetchImpl: fakeGateway.fetch }),
      supervisor: new FakeSupervisor(gatewayUrl),
      sessionKey: "session:fake",
      userId: "user:fake",
      strict: true,
    });

    const session = await agent.startSession();
    const result = await session.run({ prompt: "Which adapter should I use?" });
    await session.end();

    expect(result.text).toBe("captured through fake gateway");
    expect(result.memory.captured).toEqual({ l0Recorded: 2, schedulerNotified: true });
    expect(fakeGateway.calls.map((call) => call.path)).toEqual(["/recall", "/capture", "/session/end"]);
    expect(fakeGateway.calls[0].body).toEqual({
      query: "Which adapter should I use?",
      session_key: "session:fake",
      user_id: "user:fake",
    });
    expect(fakeGateway.calls[1].body).toMatchObject({
      user_content: "Which adapter should I use?",
      assistant_content: "captured through fake gateway",
      session_key: "session:fake",
      user_id: "user:fake",
    });
  });
});

class InMemoryFakeGateway {
  calls: Array<{ path: string; body?: unknown }> = [];

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (path !== "/health") {
      this.calls.push({ path, body });
    }

    if (path === "/health") return jsonResponse({ status: "ok" });
    if (path === "/recall") return jsonResponse({
      context: "Use the SDK adapter.",
      strategy: "hybrid",
      memory_count: 1,
    });
    if (path === "/capture") return jsonResponse({
      l0_recorded: 2,
      scheduler_notified: true,
    });
    if (path === "/session/end") return jsonResponse({ flushed: true });
    return jsonResponse({ error: "missing" }, 404);
  }) as typeof fetch;
}

class FakeSupervisor implements GatewaySupervisorLike {
  endpoints;
  paths: MemoryPaths = {
    rootDir: "/tmp/root",
    configPath: "/tmp/root/tdai-gateway.yaml",
    dataDir: "/tmp/root/data",
    logDir: "/tmp/root/logs",
    runtimeDir: "/tmp/root/runtime",
  };

  constructor(gatewayUrl: string) {
    this.endpoints = { gatewayUrl };
  }

  async ensureRunning(): Promise<void> {}
  async close(): Promise<void> {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
