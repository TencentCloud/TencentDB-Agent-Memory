import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the env before importing the factory.
const setters: Record<string, string> = {
  TDAI_PROXY_URL: "http://127.0.0.1:8096",
  TDAI_SPACE_ID: "default",
  TDAI_AGENT_SOURCE: "pi",
  TDAI_TEAM_ID: "team-azqo3jvm25",
  TDAI_AGENT_ID: "agt-ea0b0wybln",
  TDAI_TASK_ID: "task-enjvravg2l",
  TDAI_USER_KEY: "sk-mem-test",
  TDAI_MODEL: "glm-5.2-vision",
};

describe("pi-plugin", () => {
  let registerProviderCalls: { name: string; cfg: any }[];
  let onCalls: { evt: string; h: any }[];
  let factory: any;
  let originalEnv: Record<string, string | undefined> | undefined;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(setters)) process.env[k] = v;
    registerProviderCalls = [];
    onCalls = [];
    vi.resetModules();
    factory = (await import("../index.js")).default;
  });

  afterEach(() => {
    // Restore env so stubbed TDAI_* values never leak to later files in the
    // test process (vitest worker isolation limits but does not prevent it).
    if (originalEnv) {
      for (const k of Object.keys(setters)) {
        if (k in originalEnv) process.env[k] = originalEnv[k] as string;
        else delete process.env[k];
      }
    }
  });

  it("registers a 'tdai' provider with /v1 baseUrl and static identity headers", () => {
    const api: any = {
      registerProvider: (name: string, cfg: any) => registerProviderCalls.push({ name, cfg }),
      registerTool: () => {},
      on: (evt: string, h: any) => onCalls.push({ evt, h }),
    };
    factory(api);
    expect(registerProviderCalls).toHaveLength(1);
    const { name, cfg } = registerProviderCalls[0];
    expect(name).toBe("tdai");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8096/pi/default/v1");
    expect(cfg.api).toBe("openai-completions");
    expect(cfg.apiKey).toBe("sk-mem-test");
    expect(cfg.headers["x-team-id"]).toBe("team-azqo3jvm25");
    expect(cfg.headers["x-agent-id"]).toBe("agt-ea0b0wybln");
    expect(cfg.headers["x-task-id"]).toBe("task-enjvravg2l");
    expect(cfg.models[0].id).toBe("glm-5.2-vision");
  });

  it("registers a before_provider_headers hook", () => {
    const api: any = {
      registerProvider: () => {},
      registerTool: () => {},
      on: (evt: string, h: any) => onCalls.push({ evt, h }),
    };
    factory(api);
    const hook = onCalls.find((c) => c.evt === "before_provider_headers");
    expect(hook).toBeDefined();
  });

  it("sets x-conversation-id = pi-<sid> only for the tdai provider", () => {
    const localOnCalls: { evt: string; h: any }[] = [];
    const api: any = {
      registerProvider: () => {},
      registerTool: () => {},
      on: (evt: string, h: any) => localOnCalls.push({ evt, h }),
    };
    factory(api);
    const hook = localOnCalls.find((c) => c.evt === "before_provider_headers")!.h;

    const event: any = { headers: {} };
    // Non-tdai provider: must NOT mutate
    hook(event, { model: { provider: "lunaroute" }, sessionManager: { getSessionId: () => "abc" } });
    expect(event.headers["x-conversation-id"]).toBeUndefined();

    // tdai provider: must set
    hook(event, { model: { provider: "tdai" }, sessionManager: { getSessionId: () => "sess-123" } });
    expect(event.headers["x-conversation-id"]).toBe("pi-sess-123");
  });

  it("warns and skips registration when a required env var is missing (Pi still starts)", async () => {
    delete process.env.TDAI_TEAM_ID;
    vi.resetModules();
    const failingFactory = (await import("../index.js")).default;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerProvider = vi.fn();
    const on = vi.fn();
    const api: any = { registerProvider, registerTool: () => {}, on };
    // Must NOT throw — a startup extension must never block Pi from loading.
    expect(() => failingFactory(api)).not.toThrow();
    // Must NOT register the provider or hook when env is missing.
    expect(registerProvider).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    // Must warn naming the missing var.
    expect(warn.mock.calls[0]?.[0]).toMatch(/TDAI_TEAM_ID/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/pi-tdai-client/);
    warn.mockRestore();
  });

  it("registers WITHOUT x-task-id when TDAI_TASK_ID is absent (task-optional)", async () => {
    delete process.env.TDAI_TASK_ID;
    vi.resetModules();
    const tasklessFactory = (await import("../index.js")).default;
    const registerProviderCalls: { name: string; cfg: any }[] = [];
    const onCalls: { evt: string; h: any }[] = [];
    const api: any = {
      registerProvider: (name: string, cfg: any) => registerProviderCalls.push({ name, cfg }),
      registerTool: () => {},
      on: (evt: string, h: any) => onCalls.push({ evt, h }),
    };
    // Must NOT throw and MUST still register (task is optional).
    expect(() => tasklessFactory(api)).not.toThrow();
    expect(registerProviderCalls).toHaveLength(1);
    const { cfg } = registerProviderCalls[0];
    expect(cfg.headers["x-team-id"]).toBe("team-azqo3jvm25");
    expect(cfg.headers["x-agent-id"]).toBe("agt-ea0b0wybln");
    // No x-task-id header when task is absent → proxy registers with broad recall.
    expect(cfg.headers["x-task-id"]).toBeUndefined();
  });

  it("registers an ask_followup_question tool that picks and returns XML", async () => {
    const registerTool = vi.fn();
    const api: any = { registerProvider: () => {}, registerTool, on: () => {} };
    factory(api);
    expect(registerTool).toHaveBeenCalled();
    const tool = registerTool.mock.calls[0][0];
    expect(tool.name).toBe("ask_followup_question");

    // The proxy's args (double-encoded questions string). Pi parses
    // function.arguments against the tool's parameters schema before calling
    // execute, so params arrives as { title: string, questions: string }.
    const params = {
      title: "会话初始化 — 选择 Team",
      questions: JSON.stringify([{ id: "team", question: "Team?", options: ["Team A (a1b2c3d4)"], multiSelect: false }]),
    };
    const ctx: any = {
      mode: "tui", hasUI: true,
      ui: { custom: async (factory: any) => {
        const comp = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s }, {}, (d: any) => d);
        comp.handleInput("\r"); // Enter → first option
        return { id: "team", answer: "Team A (a1b2c3d4)" };
      } },
    };
    const res = await tool.execute("call_session_init_123", params, undefined, undefined, ctx);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Team A (a1b2c3d4)");
    expect(res.content[0].text).toContain("<question_answer>");
  });

  it("the ask_followup_question tool no-ops for non-session-init ids", async () => {
    const registerTool = vi.fn();
    const api: any = { registerProvider: () => {}, registerTool, on: () => {} };
    factory(api);
    const tool = registerTool.mock.calls[0][0];
    const res = await tool.execute("call_some_other_id", { title: "x", questions: "[]" }, undefined, undefined, { mode: "tui", hasUI: true, ui: { custom: async () => null } });
    // Non-matching id → must NOT render a picker and must return a benign skip.
    expect(res.content[0].text).toMatch(/session-init|skip/i);
  });
});
