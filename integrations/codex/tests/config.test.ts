import { describe, expect, it, vi } from "vitest";
import { loadCodexAdapterConfig } from "../src/config.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("loadCodexAdapterConfig", () => {
  it("uses documented defaults and Gateway auth fallback", () => {
    const config = loadCodexAdapterConfig({ TDAI_GATEWAY_API_KEY: " gateway-key " }, logger);
    expect(config.gatewayUrl).toBe("http://127.0.0.1:8420");
    expect(config.gatewayApiKey).toBe("gateway-key");
    expect(config.captureMode).toBe("summary");
    expect(config.enableSupervisor).toBe(true);
  });

  it("falls back safely for invalid values", () => {
    const config = loadCodexAdapterConfig({
      MEMORY_TENCENTDB_CODEX_REQUEST_TIMEOUT_MS: "none",
      MEMORY_TENCENTDB_CODEX_ENABLE_SUPERVISOR: "perhaps",
      MEMORY_TENCENTDB_CODEX_CAPTURE_MODE: "full",
      MEMORY_TENCENTDB_CODEX_GATEWAY_URL: "not a URL",
    }, logger);
    expect(config.requestTimeoutMs).toBe(10_000);
    expect(config.enableSupervisor).toBe(true);
    expect(config.captureMode).toBe("summary");
    expect(config.gatewayUrl).toBe("http://127.0.0.1:8420");
    expect(logger.warn).toHaveBeenCalled();
  });
});
