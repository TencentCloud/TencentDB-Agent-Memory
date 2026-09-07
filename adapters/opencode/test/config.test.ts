import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const required = {
  TDAI_MEMORY_API_KEY: "test-key",
  TDAI_MEMORY_SERVICE_ID: "service-1",
  TDAI_MEMORY_TEAM_ID: "team-1",
  TDAI_MEMORY_AGENT_ID: "opencode",
  TDAI_MEMORY_USER_ID: "user-1",
};

describe("loadConfig", () => {
  it("loads required identity fields and safe defaults", () => {
    const result = loadConfig(required);

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        endpoint: "http://127.0.0.1:8420",
        recallEnabled: true,
        captureEnabled: true,
        recallLimit: 5,
      }),
    });
  });

  it("rejects remote plaintext HTTP by default", () => {
    const result = loadConfig({
      ...required,
      TDAI_MEMORY_ENDPOINT: "http://memory.example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("Remote HTTP");
  });

  it("reports missing identity fields together", () => {
    const result = loadConfig({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("Missing TDAI_MEMORY_TEAM_ID");
      expect(result.errors).toContain("Missing TDAI_MEMORY_USER_ID");
    }
  });
});
