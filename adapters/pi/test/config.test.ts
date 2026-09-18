import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  TDAI_MEMORY_ENDPOINT: "https://memory.example.com",
  TDAI_MEMORY_API_KEY: "secret",
  TDAI_MEMORY_SERVICE_ID: "service-1",
  TDAI_MEMORY_TEAM_ID: "team-1",
  TDAI_MEMORY_AGENT_ID: "agent-1",
  TDAI_MEMORY_USER_ID: "user-1",
};

describe("loadConfig", () => {
  it("loads strict-isolation settings and safe defaults", () => {
    const result = loadConfig(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      endpoint: "https://memory.example.com",
      timeoutMs: 5_000,
      recallLimit: 5,
      scenarioLimit: 3,
      maxContextChars: 8_000,
      includeCore: true,
      includeScenarios: true,
    });
  });

  it("reports every missing identity field without exposing secrets", () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Missing TDAI_MEMORY_API_KEY",
        "Missing TDAI_MEMORY_SERVICE_ID",
        "Missing TDAI_MEMORY_TEAM_ID",
        "Missing TDAI_MEMORY_AGENT_ID",
        "Missing TDAI_MEMORY_USER_ID",
      ]),
    );
  });

  it("blocks bearer tokens over remote plain HTTP by default", () => {
    const result = loadConfig({
      ...validEnv,
      TDAI_MEMORY_ENDPOINT: "http://memory.example.com:8420",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("Remote HTTP");
  });

  it("allows explicitly opted-in private HTTP deployments", () => {
    const result = loadConfig({
      ...validEnv,
      TDAI_MEMORY_ENDPOINT: "http://memory-core:8420",
      TDAI_PI_ALLOW_INSECURE_HTTP: "1",
    });
    expect(result.ok).toBe(true);
  });

  it("validates bounded numeric options", () => {
    const result = loadConfig({
      ...validEnv,
      TDAI_PI_RECALL_LIMIT: "21",
      TDAI_PI_TIMEOUT_MS: "fast",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
  });
});
