/**
 * Tests for the Pi TDAI extension (index.ts).
 *
 * The extension is env-only config + provider registration + one header hook.
 * We drive the default export with a minimal fake ExtensionAPI and assert on
 * the registration payload and hook behaviour, without requiring a real Pi
 * runtime or the peer dependency.
 *
 * Design notes:
 * - Each case mutates process.env, so we snapshot/restore around every test.
 * - The module reads env at call time (inside the default export), not at
 *   import time, so a single import is enough — we just re-invoke the factory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import register from "../index.js";

interface RegisteredProvider {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  headers: Record<string, string>;
  models: Array<{ id: string; name: string }>;
}

type HeaderHook = (event: any, ctx: any) => void;

/** Minimal fake ExtensionAPI capturing what the extension registers. */
function makeFakePi() {
  const providers: Record<string, RegisteredProvider> = {};
  const hooks: Record<string, HeaderHook> = {};
  return {
    providers,
    hooks,
    registerProvider(id: string, cfg: RegisteredProvider) {
      providers[id] = cfg;
    },
    on(event: string, handler: HeaderHook) {
      hooks[event] = handler;
    },
  };
}

const ENV_KEYS = [
  "TDAI_PROXY_URL",
  "TDAI_SPACE_ID",
  "TDAI_AGENT_SOURCE",
  "TDAI_MODEL",
  "TDAI_USER_KEY",
  "TDAI_TEAM_ID",
  "TDAI_AGENT_ID",
  "TDAI_TASK_ID",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

/** Set the three required identity env vars. */
function setRequiredEnv(overrides: Partial<Record<string, string>> = {}) {
  process.env.TDAI_USER_KEY = "user-key-123";
  process.env.TDAI_TEAM_ID = "team-1";
  process.env.TDAI_AGENT_ID = "agent-1";
  Object.assign(process.env, overrides);
}

describe("pi-tdai-client registration", () => {
  it("registers the tdai provider when all required env vars are present", () => {
    setRequiredEnv();
    const pi = makeFakePi();

    register(pi as any);

    expect(Object.keys(pi.providers)).toEqual(["tdai"]);
    const provider = pi.providers.tdai;
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe("user-key-123");
    expect(provider.models[0].id).toBe("glm-5.2-vision"); // default model
  });

  it("does NOT register when a required env var is missing, and warns", () => {
    // Missing TDAI_TEAM_ID
    process.env.TDAI_USER_KEY = "user-key-123";
    process.env.TDAI_AGENT_ID = "agent-1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();

    register(pi as any);

    expect(pi.providers).toEqual({});
    expect(pi.hooks).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("TDAI_TEAM_ID");
  });

  it("does not require TDAI_TASK_ID (optional business dimension)", () => {
    setRequiredEnv(); // no TDAI_TASK_ID
    const pi = makeFakePi();

    register(pi as any);

    expect(pi.providers.tdai).toBeDefined();
  });
});

describe("header assembly", () => {
  it("includes x-team-id and x-agent-id, omits x-task-id when unset", () => {
    setRequiredEnv();
    const pi = makeFakePi();

    register(pi as any);

    const headers = pi.providers.tdai.headers;
    expect(headers["x-team-id"]).toBe("team-1");
    expect(headers["x-agent-id"]).toBe("agent-1");
    expect(headers).not.toHaveProperty("x-task-id");
  });

  it("includes x-task-id when TDAI_TASK_ID is set", () => {
    setRequiredEnv({ TDAI_TASK_ID: "task-9" });
    const pi = makeFakePi();

    register(pi as any);

    expect(pi.providers.tdai.headers["x-task-id"]).toBe("task-9");
  });
});

describe("baseUrl construction", () => {
  it("uses defaults: proxy host, pi agent source, default space, /v1 suffix", () => {
    setRequiredEnv();
    const pi = makeFakePi();

    register(pi as any);

    expect(pi.providers.tdai.baseUrl).toBe(
      "http://127.0.0.1:8096/pi/default/v1",
    );
  });

  it("honours TDAI_PROXY_URL, TDAI_AGENT_SOURCE and TDAI_SPACE_ID", () => {
    setRequiredEnv({
      TDAI_PROXY_URL: "https://mem.example.com",
      TDAI_AGENT_SOURCE: "codebuddy",
      TDAI_SPACE_ID: "space-x",
    });
    const pi = makeFakePi();

    register(pi as any);

    expect(pi.providers.tdai.baseUrl).toBe(
      "https://mem.example.com/codebuddy/space-x/v1",
    );
  });
});

describe("before_provider_headers hook", () => {
  it("injects x-conversation-id for the tdai provider", () => {
    setRequiredEnv();
    const pi = makeFakePi();
    register(pi as any);

    const hook = pi.hooks["before_provider_headers"];
    expect(hook).toBeTypeOf("function");

    const event = { headers: {} as Record<string, string> };
    const ctx = {
      model: { provider: "tdai" },
      sessionManager: { getSessionId: () => "sess-42" },
    };
    hook(event, ctx);

    expect(event.headers["x-conversation-id"]).toBe("pi-sess-42");
  });

  it("leaves headers untouched for non-tdai providers", () => {
    setRequiredEnv();
    const pi = makeFakePi();
    register(pi as any);

    const hook = pi.hooks["before_provider_headers"];
    const event = { headers: {} as Record<string, string> };
    const ctx = {
      model: { provider: "openai" },
      sessionManager: { getSessionId: () => "sess-1" },
    };
    hook(event, ctx);

    expect(event.headers).not.toHaveProperty("x-conversation-id");
  });
});
