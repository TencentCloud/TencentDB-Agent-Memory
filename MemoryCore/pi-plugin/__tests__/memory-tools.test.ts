import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";
import { requestMemory } from "../memory-tools.js";

const path = "场景/中文-路径😀.md";
const key = "synthetic-test-key";
let requests: Array<{ url: string; headers: IncomingMessage["headers"]; bytes: Buffer; body: any }>;
let reply: (res: ServerResponse, body: any) => void;
let baseUrl: string;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  requests = [];
  reply = (res, body) => res.end(JSON.stringify({ code: 0, data: { path: body.path, content: "合成中文正文" } }));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    requests.push({ url: req.url!, headers: req.headers, bytes, body });
    reply(res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test listener");
  baseUrl = `http://127.0.0.1:${address.port}/prefix`;
  vi.stubEnv("TDAI_PROXY_URL", baseUrl);
  vi.stubEnv("TDAI_USER_KEY", key);
  vi.stubEnv("TDAI_TEAM_ID", "synthetic-team");
  vi.stubEnv("TDAI_AGENT_ID", "synthetic-agent");
  vi.stubEnv("TDAI_SPACE_ID", "synthetic-space");
  vi.stubEnv("TDAI_AGENT_SOURCE", "pi");
  vi.stubEnv("PI_OFFLINE", undefined);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function load() {
  const tools = new Map<string, any>();
  const provider = vi.fn();
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerProvider: provider, on: vi.fn() } as any);
  return { tools, provider };
}

const config = () => ({ proxyUrl: baseUrl, userKey: key, spaceId: "synthetic-space", agentSource: "pi" });
const context = (id: string) => ({ model: { provider: "tdai" }, sessionManager: { getSessionId: () => id } });

describe("native Pi memory reads", () => {
  it("preserves the exact UTF-8 L2 path, body and imported agent through the registered tool", async () => {
    const { tools } = load();
    const params = { path, agent_id: "imported-agent" };
    const result = await tools.get("tdai_read_scene").execute("call", params, undefined, undefined, context("first"));
    const response = JSON.parse(result.content[0].text);
    expect(response.data).toEqual({ path, content: "合成中文正文" });
    expect(requests[0].bytes).toEqual(Buffer.from(JSON.stringify(params), "utf8"));
    expect(requests[0].url).toBe("/prefix/memory-bridge/v3/scenario/read");
    expect(requests[0].headers).toMatchObject({
      "content-type": "application/json; charset=utf-8", "x-api-key": key,
      "x-conversation-id": "pi-first", "x-tdai-service-id": "synthetic-space",
    });
  });

  it("registers only the six read tools and refreshes the authenticating session on each call", async () => {
    reply = (res) => res.end(JSON.stringify({ code: 0, data: { items: [] } }));
    const { tools, provider } = load();
    expect(provider).toHaveBeenCalledOnce();
    expect([...tools.keys()]).toEqual([
      "tdai_memory_search", "tdai_atomic_query", "tdai_conversation_search",
      "tdai_conversation_query", "tdai_scenario_ls", "tdai_read_scene",
    ]);
    const inputs = [
      ["tdai_memory_search", "atomic/search", { query: "中文" }],
      ["tdai_atomic_query", "atomic/query", { type: "instruction", limit: 1 }],
      ["tdai_conversation_search", "conversation/search", { query: "中文", session_id: "pi-history" }],
      ["tdai_conversation_query", "conversation/query", { session_id: "pi-history" }],
      ["tdai_scenario_ls", "scenario/ls", { path_prefix: "场景" }],
    ] as const;
    for (const [name, endpoint, input] of inputs) {
      await tools.get(name).execute("call", input, undefined, undefined, context(name));
      expect(requests.at(-1)?.url).toBe(`/prefix/memory-bridge/v3/${endpoint}`);
      expect(requests.at(-1)?.body).toEqual(input);
      expect(requests.at(-1)?.headers["x-conversation-id"]).toBe(`pi-${name}`);
    }
    for (const tool of tools.values()) {
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.parameters.properties).not.toHaveProperty("user_key");
      expect(tool.parameters.properties).not.toHaveProperty("team_id");
    }
  });

  it("skips registration without the existing identity configuration and refuses offline calls", async () => {
    vi.stubEnv("TDAI_USER_KEY", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(load().tools.size).toBe(0);
    vi.stubEnv("TDAI_USER_KEY", key);
    const { tools } = load();
    await expect(tools.get("tdai_scenario_ls").execute("call", {}, undefined, undefined, {
      ...context("first"), model: { provider: "another-provider" },
    })).rejects.toThrow(/tdai provider/);
    vi.stubEnv("PI_OFFLINE", "1");
    await expect(tools.get("tdai_scenario_ls").execute("call", {}, undefined, undefined, context("first"))).rejects.toThrow(/offline/i);
    expect(requests).toHaveLength(0);
  });

  it("rejects unknown endpoints, identity overrides and unsafe base URLs before sending", async () => {
    for (const [endpoint, body] of [["scenario/write", { path }], ["scenario/read", { path, team_id: "other" }]]) {
      await expect(requestMemory(config(), endpoint as any, body as any, "first")).rejects.toThrow();
    }
    for (const proxyUrl of ["file:///memory", "http://user:password@localhost", `${baseUrl}?query=1`, `${baseUrl}#fragment`]) {
      await expect(requestMemory({ ...config(), proxyUrl }, "scenario/read", { path }, "first")).rejects.toThrow();
    }
    await expect(requestMemory(config(), "scenario/read", { path }, "")).rejects.toThrow(/session/i);
    expect(requests).toHaveLength(0);
  });

  it("reports missing content and mismatched paths explicitly, while allowing an empty file", async () => {
    for (const data of [{ path, content: null }, { path: "wrong.md", content: "text" }]) {
      reply = (res) => res.end(JSON.stringify({ code: 0, data }));
      await expect(requestMemory(config(), "scenario/read", { path }, "first")).rejects.toThrow(/scene|path/i);
    }
    reply = (res) => res.end(JSON.stringify({ code: 0, data: { path, content: "" } }));
    await expect(requestMemory(config(), "scenario/read", { path }, "first")).resolves.toMatchObject({ data: { content: "" } });
  });

  it("fails on HTTP/business/invalid-UTF8 responses without echoing keys or following redirects", async () => {
    for (const status of [302, 401, 500]) {
      reply = (res) => { res.writeHead(status, { location: `${baseUrl}/redirect` }); res.end(key); };
      await expect(requestMemory(config(), "scenario/ls", {}, "first")).rejects.toThrow(`HTTP ${status}`);
    }
    reply = (res) => res.end(JSON.stringify({ code: 1, message: key, data: null }));
    await expect(requestMemory(config(), "scenario/ls", {}, "first")).rejects.toThrow("code 1");
    reply = (res) => res.end(Buffer.from([0xff]));
    await expect(requestMemory(config(), "scenario/ls", {}, "first")).rejects.toThrow(/UTF-8 JSON/);
    expect(requests).toHaveLength(5);
  });

  it("bounds the response and respects cancellation and the request deadline", async () => {
    reply = (res) => res.end("x".repeat(2 * 1024 * 1024 + 1));
    await expect(requestMemory(config(), "scenario/ls", {}, "first")).rejects.toThrow(/large/);
    reply = () => {};
    await expect(requestMemory(config(), "scenario/ls", {}, "first", undefined, 30)).rejects.toThrow(/timed out/i);
    const controller = new AbortController();
    const pending = requestMemory(config(), "scenario/ls", {}, "first", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});
