import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Gateway LLM environment compatibility", () => {
  it("accepts the Hermes MEMORY_TENCENTDB_LLM_* names", () => {
    vi.stubEnv("TDAI_LLM_API_KEY", "");
    vi.stubEnv("TDAI_LLM_BASE_URL", "");
    vi.stubEnv("TDAI_LLM_MODEL", "");
    vi.stubEnv("MEMORY_TENCENTDB_LLM_API_KEY", "hermes-key");
    vi.stubEnv("MEMORY_TENCENTDB_LLM_BASE_URL", "https://hermes.example/v1");
    vi.stubEnv("MEMORY_TENCENTDB_LLM_MODEL", "hermes-model");

    const config = loadGatewayConfig();

    expect(config.llm.apiKey).toBe("hermes-key");
    expect(config.llm.baseUrl).toBe("https://hermes.example/v1");
    expect(config.llm.model).toBe("hermes-model");
  });

  it("prefers canonical TDAI_LLM_* values when both names are set", () => {
    vi.stubEnv("TDAI_LLM_API_KEY", "tdai-key");
    vi.stubEnv("TDAI_LLM_BASE_URL", "https://tdai.example/v1");
    vi.stubEnv("TDAI_LLM_MODEL", "tdai-model");
    vi.stubEnv("MEMORY_TENCENTDB_LLM_API_KEY", "hermes-key");
    vi.stubEnv("MEMORY_TENCENTDB_LLM_BASE_URL", "https://hermes.example/v1");
    vi.stubEnv("MEMORY_TENCENTDB_LLM_MODEL", "hermes-model");

    const config = loadGatewayConfig();

    expect(config.llm.apiKey).toBe("tdai-key");
    expect(config.llm.baseUrl).toBe("https://tdai.example/v1");
    expect(config.llm.model).toBe("tdai-model");
  });
});
