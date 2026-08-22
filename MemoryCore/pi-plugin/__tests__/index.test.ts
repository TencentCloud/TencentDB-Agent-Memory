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
    const api: any = { registerProvider, on };
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
});
