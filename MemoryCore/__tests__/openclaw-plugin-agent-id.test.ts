/**
 * Regression: OpenClaw client requests must carry the runtime agent id.
 * A static `server.agentId || "default"` collapses every agent into one bucket.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "../openclaw-plugin/index.js";

type Captured = { url: string; body: Record<string, unknown> };

function agentIds(captured: Captured[], pathSuffix: string): unknown[] {
  return captured.filter((call) => call.url.includes(pathSuffix)).map((call) => call.body.agent_id);
}

function createHarness(server: Record<string, unknown> = {}) {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const tools = new Map<string, unknown>();
  const api = {
    pluginConfig: {
      server: {
        url: "http://127.0.0.1:8420",
        apiKey: "local",
        instanceId: "default",
        ...server,
      },
      recall: { includePersona: false, includeSceneNav: false, maxResults: 3 },
      capture: { enabled: true },
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
    registerTool(tool: unknown, opts?: { name?: string }) {
      const declared = opts?.name ?? (tool as { name?: string }).name;
      if (!declared) throw new Error("tool registered without a name");
      tools.set(declared, tool);
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      hooks.set(name, handler);
    },
  };
  register(api);
  return { hooks, tools };
}

async function invokeTool(
  tools: Map<string, unknown>,
  name: string,
  ctx: { agentId?: string; sessionKey?: string; sessionId?: string },
  params: Record<string, unknown>,
) {
  const registered = tools.get(name);
  if (!registered) throw new Error(`tool ${name} was not registered`);
  // OpenClaw calls a tool factory with the runtime context, then execute().
  // A plain tool object has no runtime context and keeps the static client.
  const tool = typeof registered === "function"
    ? registered(ctx)
    : registered;
  if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
    throw new Error(`tool ${name} did not produce an execute function`);
  }
  return (tool as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> })
    .execute("call-1", params);
}

describe("OpenClaw plugin request agentId", () => {
  const captured: Captured[] = [];

  afterEach(() => {
    captured.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installFetch() {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const raw = init?.body ? JSON.parse(String(init.body)) : {};
      captured.push({ url: String(url), body: raw as Record<string, unknown> });
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        data: { items: [], entries: [], messages: [], content: "", total_count: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  it("uses the per-agent id from the hook sessionKey instead of server.agentId", async () => {
    installFetch();
    const { hooks } = createHarness({ agentId: "panel-static" });
    const recall = hooks.get("before_prompt_build");
    expect(recall).toBeTypeOf("function");

    await recall!(
      { prompt: "what is my book?" },
      { sessionKey: "agent:trader:sess-1", agentId: "ignored-if-session-parses", sessionId: "sess-1" },
    );
    await recall!(
      { prompt: "status?" },
      { sessionKey: "agent:main:sess-2", agentId: "main", sessionId: "sess-2" },
    );

    expect(agentIds(captured, "/v3/atomic/search")).toEqual(["trader", "main"]);
    expect(
      captured.filter((call) => call.url.includes("/v3/atomic/search")).map((call) => call.body.session_id),
    ).toEqual(["sess-1", "sess-2"]);
  });

  it("uses ctx.agentId when the sessionKey does not encode an agent", async () => {
    installFetch();
    const { hooks } = createHarness({ agentId: "panel-static" });
    const recall = hooks.get("before_prompt_build")!;

    await recall(
      { prompt: "hello" },
      { sessionKey: "legacy-session", agentId: "research", sessionId: "s-9" },
    );

    expect(agentIds(captured, "/v3/atomic/search")).toEqual(["research"]);
  });

  it("falls back to configured server.agentId, then default, only when runtime id is unavailable", async () => {
    installFetch();
    const configured = createHarness({ agentId: "panel-static" });
    await configured.hooks.get("before_prompt_build")!(
      { prompt: "hello" },
      { sessionKey: "legacy-session", sessionId: "s-1" },
    );
    expect(agentIds(captured, "/v3/atomic/search")).toEqual(["panel-static"]);

    captured.length = 0;
    const unset = createHarness({});
    await unset.hooks.get("before_prompt_build")!(
      { prompt: "hello" },
      { sessionKey: "legacy-session", sessionId: "s-2" },
    );
    expect(agentIds(captured, "/v3/atomic/search")).toEqual(["default"]);
  });

  it("writes captured turns under the runtime agent, not the static server.agentId", async () => {
    installFetch();
    const { hooks } = createHarness({ agentId: "panel-static" });
    const capture = hooks.get("agent_end");
    expect(capture).toBeTypeOf("function");

    await capture!(
      {
        success: true,
        messages: [{ role: "user", content: "buy the dip", timestamp: 1_700_000_000_000 }],
      },
      { sessionKey: "agent:trader:sess-1", agentId: "trader", sessionId: "sess-1" },
    );

    expect(agentIds(captured, "/v3/conversation/add")).toEqual(["trader"]);
    expect(
      captured.filter((call) => call.url.includes("/v3/conversation/add")).map((call) => call.body.session_id),
    ).toEqual(["sess-1"]);
  });

  it("omits hook session_id when the context has none, and capture falls back to sessionKey", async () => {
    installFetch();
    const { hooks } = createHarness({ agentId: "panel-static" });

    await hooks.get("before_prompt_build")!(
      { prompt: "hello" },
      { sessionKey: "agent:trader:raw-key" },
    );
    expect(
      captured.filter((call) => call.url.includes("/v3/atomic/search")).map((call) => call.body.session_id),
    ).toEqual([undefined]);

    captured.length = 0;
    await hooks.get("agent_end")!(
      {
        success: true,
        messages: [{ role: "user", content: "buy the dip", timestamp: 1_700_000_000_000 }],
      },
      { sessionKey: "agent:trader:raw-key" },
    );
    expect(
      captured.filter((call) => call.url.includes("/v3/conversation/add")).map((call) => call.body.session_id),
    ).toEqual(["agent:trader:raw-key"]);
  });

  it("skips blank agent ids and still calls the gateway with the next id", async () => {
    installFetch();
    const recall = (server: Record<string, unknown>, ctx: Record<string, unknown>) =>
      createHarness(server).hooks.get("before_prompt_build")!({ prompt: "hello" }, ctx);

    await recall(
      { agentId: "panel-static" },
      { sessionKey: "agent:   :rest", agentId: "research", sessionId: "s-1" },
    );
    await recall(
      { agentId: "panel-static" },
      { sessionKey: "agent::rest", agentId: "   ", sessionId: "s-2" },
    );
    await recall(
      { agentId: "   " },
      { sessionKey: "legacy-session", agentId: "", sessionId: "s-3" },
    );

    expect(agentIds(captured, "/v3/atomic/search")).toEqual(["research", "panel-static", "default"]);
  });

  it("scopes memory and conversation search tools to the runtime agent", async () => {
    installFetch();
    const { tools } = createHarness({ agentId: "panel-static" });
    const ctx = { agentId: "trader", sessionKey: "agent:trader:sess-1", sessionId: "sess-1" };

    await invokeTool(tools, "tdai_memory_search", ctx, { query: "positions" });
    await invokeTool(tools, "tdai_conversation_search", ctx, { query: "positions" });
    await invokeTool(tools, "tdai_conversation_search", ctx, {
      query: "positions",
      session_key: "other-sess",
    });

    expect(agentIds(captured, "/v3/atomic/search")).toEqual(["trader"]);
    expect(
      captured.filter((call) => call.url.includes("/v3/atomic/search")).map((call) => call.body.session_id),
    ).toEqual([undefined]);

    const conversation = captured.filter((call) => call.url.includes("/v3/conversation/search"));
    expect(conversation.map((call) => call.body.agent_id)).toEqual(["trader", "trader"]);
    // Omitted session_key searches across sessions. The tool context session must not fill it in.
    expect(conversation[0]?.body.session_id).toBeUndefined();
    expect(conversation[1]?.body.session_id).toBe("other-sess");
  });
});
