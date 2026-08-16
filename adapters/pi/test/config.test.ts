import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    TDAI_MEMORY_API_KEY: "sk-test",
    TDAI_MEMORY_SERVICE_ID: "service-1",
    TDAI_MEMORY_TEAM_ID: "team-1",
    TDAI_MEMORY_AGENT_ID: "agent-1",
    TDAI_MEMORY_USER_ID: "user-1",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads a valid configuration with defaults", () => {
    const result = loadConfig(env());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      endpoint: "http://127.0.0.1:8420",
      apiKey: "sk-test",
      serviceId: "service-1",
      teamId: "team-1",
      agentId: "agent-1",
      userId: "user-1",
      timeoutMs: 5_000,
      recallLimit: 5,
      includeCore: true,
      includeScenarios: true,
      allowInsecureHttp: false,
    });
  });

  it("reports every missing required variable", () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(5);
    expect(result.errors.join(" ")).toContain("TDAI_MEMORY_API_KEY");
    expect(result.errors.join(" ")).toContain("TDAI_MEMORY_USER_ID");
  });

  it("rejects a remote plain-HTTP endpoint by default", () => {
    const result = loadConfig(env({ TDAI_MEMORY_ENDPOINT: "http://192.168.1.10:8420" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("TDAI_PI_ALLOW_INSECURE_HTTP");
  });

  it("allows a remote plain-HTTP endpoint when explicitly opted in", () => {
    const result = loadConfig(
      env({ TDAI_MEMORY_ENDPOINT: "http://192.168.1.10:8420", TDAI_PI_ALLOW_INSECURE_HTTP: "1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpoint).toBe("http://192.168.1.10:8420");
  });

  it("clamps out-of-range integers and records an error", () => {
    const result = loadConfig(env({ TDAI_PI_TIMEOUT_MS: "10" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("TDAI_PI_TIMEOUT_MS");
  });

  it("normalizes trailing slashes off the endpoint", () => {
    const result = loadConfig(env({ TDAI_MEMORY_ENDPOINT: "http://127.0.0.1:8420///" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpoint).toBe("http://127.0.0.1:8420");
  });
});
