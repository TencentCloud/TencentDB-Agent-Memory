import { describe, expect, it, vi } from "vitest";
import { loadOpenCodeAdapterConfig } from "../src/config.js";

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("loadOpenCodeAdapterConfig", () => {
  it("loads defaults and falls back to the Gateway API key", () => {
    const config = loadOpenCodeAdapterConfig(
      { TDAI_GATEWAY_API_KEY: " key " },
      logger(),
    );
    expect(config.gatewayUrl).toBe("http://127.0.0.1:8420");
    expect(config.gatewayApiKey).toBe("key");
    expect(config.enableSupervisor).toBe(false);
    expect(config.requestTimeoutMs).toBe(10_000);
  });

  it("warns and falls back for invalid values", () => {
    const log = logger();
    const config = loadOpenCodeAdapterConfig(
      {
        MEMORY_TENCENTDB_OPENCODE_GATEWAY_URL: "file:///tmp/gateway",
        MEMORY_TENCENTDB_OPENCODE_REQUEST_TIMEOUT_MS: "0",
        MEMORY_TENCENTDB_OPENCODE_ENABLE_SUPERVISOR: "maybe",
      },
      log,
    );
    expect(config.gatewayUrl).toBe("http://127.0.0.1:8420");
    expect(config.requestTimeoutMs).toBe(10_000);
    expect(config.enableSupervisor).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it("lets plugin options override environment variables", () => {
    const config = loadOpenCodeAdapterConfig(
      { MEMORY_TENCENTDB_OPENCODE_USER_ID: "env-user" },
      logger(),
      {
        userId: "option-user",
        enableSupervisor: true,
        requestTimeoutMs: 2_000,
      },
    );
    expect(config.userId).toBe("option-user");
    expect(config.enableSupervisor).toBe(true);
    expect(config.requestTimeoutMs).toBe(2_000);
  });
});
