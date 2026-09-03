import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConfig } from "../src/config.js";
import { GatewayError, MemoryGatewayClient } from "../src/client.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

async function client(
  handler: (path: string, body: any, headers: any) => any,
  overrides: Partial<AdapterConfig> = {},
): Promise<MemoryGatewayClient> {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => raw += chunk);
    request.on("end", () => {
      const payload = handler(request.url || "", JSON.parse(raw), request.headers);
      response.writeHead(payload.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload.body ?? payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const config: AdapterConfig = {
    endpoint: `http://127.0.0.1:${address.port}`, apiKey: "key", serviceId: "space", teamId: "team",
    agentId: "agent", userId: "user", stateDir: "x", timeoutMs: 1000, recallLimit: 5,
    maxContextChars: 8000, maxMessageChars: 8192, maxSkillBytes: 480000,
    recallEnabled: true, captureEnabled: true, skillEnabled: true, allowInsecureHttp: false,
    ...overrides,
  };
  return new MemoryGatewayClient(config);
}

describe("Gateway contract", () => {
  it("bounds legacy outbox messages to the Gateway's 8192-character limit", async () => {
    const calls: any[] = [];
    const gateway = await client((path, body) => {
      calls.push({ path, body });
      return { code: 0, data: { status: "ok" } };
    }, { maxMessageChars: 16_000 });
    await gateway.captureL0({
      key: "k", sessionId: "s", sourceId: "a", user: "u".repeat(10_000), assistant: "a".repeat(10_000),
      capturedAtMs: 1, skillMessages: [],
    });
    expect(calls[0].path).toBe("/v3/conversation/add");
    expect(calls[0].body.messages).toHaveLength(2);
    expect(calls[0].body.messages.every((item: { content: string }) => item.content.length <= 8_192)).toBe(true);
    expect(calls[0].body.messages[1].content).toContain("[capture truncated]");
  });

  it("sends strict isolation and paired Skill messages", async () => {
    const calls: any[] = [];
    const gateway = await client((path, body, headers) => {
      calls.push({ path, body, headers });
      return { code: 0, data: { status: "ok" } };
    });
    await gateway.captureSkill({
      key: "k", sessionId: "s", sourceId: "a", user: "q", assistant: "a", capturedAtMs: 1,
      skillMessages: [
        { role: "tool_call", content: "{}", tool_name: "read", tool_call_id: "c" },
        { role: "tool_result", content: "ok", tool_name: "read", tool_call_id: "c" },
      ],
    });
    expect(calls[0].path).toBe("/v3/skill/conversation/add");
    expect(calls[0].body).toMatchObject({ session_id: "s", team_id: "team", agent_id: "agent", user_id: "user" });
    expect(calls[0].headers.authorization).toBe("Bearer key");
  });

  it("rejects HTTP 200 responses with a business error code", async () => {
    const gateway = await client(() => ({ code: 40001, message: "invalid" }));
    await expect(gateway.status()).rejects.toMatchObject({ code: 40001 } satisfies Partial<GatewayError>);
  });

  it("keeps partial recall results when Skill is unavailable", async () => {
    const gateway = await client((path) => path === "/v3/skill/listing"
      ? { status: 503, body: { code: 50301, message: "not wired" } }
      : path === "/v3/core/read"
        ? { code: 0, data: { content: "core" } }
        : path === "/v3/conversation/search"
          ? { code: 0, data: { messages: [{ role: "user", content: "prior" }] } }
        : { code: 0, data: { items: [{ content: "atomic" }] } });
    const result = await gateway.recall("query");
    expect(result.core).toBe("core");
    expect(result.atomic[0]?.content).toBe("atomic");
    expect(result.conversations[0]?.content).toBe("prior");
    expect(result.warnings[0]).toContain("skills");
  });
});
