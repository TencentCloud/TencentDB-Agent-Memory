import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function validEnv(): Record<string, string | undefined> {
  return {
    TDAI_MEMORY_API_KEY: "k",
    TDAI_MEMORY_SERVICE_ID: "s",
    TDAI_MEMORY_TEAM_ID: "t",
    TDAI_MEMORY_AGENT_ID: "a",
    TDAI_MEMORY_USER_ID: "u",
  };
}

describe("loadConfig", () => {
  it("returns errors when required keys are missing", () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
      expect(result.errors.some((e) => e.includes("TDAI_MEMORY_API_KEY"))).toBe(true);
    }
  });

  it("accepts a loopback http endpoint by default", () => {
    const result = loadConfig({ ...validEnv(), TDAI_MEMORY_ENDPOINT: "http://127.0.0.1:8420" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.endpoint).toBe("http://127.0.0.1:8420");
  });

  it("rejects remote plaintext http by default to protect the bearer token", () => {
    const result = loadConfig({ ...validEnv(), TDAI_MEMORY_ENDPOINT: "http://example.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("bearer token"))).toBe(true);
  });

  it("allows remote http when explicitly opted in", () => {
    const result = loadConfig({
      ...validEnv(),
      TDAI_MEMORY_ENDPOINT: "http://example.com",
      TDAI_PI_ALLOW_INSECURE_HTTP: "1",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts https for remote hosts", () => {
    const result = loadConfig({ ...validEnv(), TDAI_MEMORY_ENDPOINT: "https://memory.example.com" });
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid endpoint url", () => {
    const result = loadConfig({ ...validEnv(), TDAI_MEMORY_ENDPOINT: "not a url" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("valid URL"))).toBe(true);
  });

  it("rejects integers outside the documented range", () => {
    const result = loadConfig({ ...validEnv(), TDAI_PI_MAX_CONTEXT_CHARS: "10" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("TDAI_PI_MAX_CONTEXT_CHARS"))).toBe(true);
  });

  it("clamps nothing but reports when timeout is out of range", () => {
    const result = loadConfig({ ...validEnv(), TDAI_PI_TIMEOUT_MS: "10" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("TDAI_PI_TIMEOUT_MS"))).toBe(true);
  });

  it("applies defaults when optional keys are absent", () => {
    const result = loadConfig(validEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeoutMs).toBe(5_000);
      expect(result.value.recallLimit).toBe(5);
      expect(result.value.maxContextChars).toBe(8_000);
      expect(result.value.maxCaptureChars).toBe(8_000);
      expect(result.value.maxSkillBytes).toBe(512_000);
      expect(result.value.includeCore).toBe(true);
      expect(result.value.taskId).toBeUndefined();
    }
  });

  it("trims a trailing slash from the endpoint", () => {
    const result = loadConfig({ ...validEnv(), TDAI_MEMORY_ENDPOINT: "http://127.0.0.1:8420///" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.endpoint).toBe("http://127.0.0.1:8420");
  });
});
