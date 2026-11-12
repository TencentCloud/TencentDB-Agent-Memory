import { describe, expect, it } from "vitest";

import {
  DEFAULT_GATEWAY_URL,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
} from "./config.js";

describe("resolveConfig", () => {
  it("falls back to defaults with an empty env", () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.baseUrl).toBe(DEFAULT_GATEWAY_URL);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("reads env vars", () => {
    const cfg = resolveConfig(
      {},
      {
        TDAI_GATEWAY_URL: "http://10.0.0.5:9000",
        TDAI_GATEWAY_API_KEY: "secret",
        TDAI_GATEWAY_TIMEOUT_MS: "5000",
      },
    );
    expect(cfg.baseUrl).toBe("http://10.0.0.5:9000");
    expect(cfg.apiKey).toBe("secret");
    expect(cfg.timeoutMs).toBe(5000);
  });

  it("prefers explicit overrides over env", () => {
    const cfg = resolveConfig(
      { baseUrl: "http://override:1", apiKey: "k2", timeoutMs: 42 },
      { TDAI_GATEWAY_URL: "http://env:2", TDAI_GATEWAY_API_KEY: "k1" },
    );
    expect(cfg.baseUrl).toBe("http://override:1");
    expect(cfg.apiKey).toBe("k2");
    expect(cfg.timeoutMs).toBe(42);
  });

  it("strips trailing slashes from the base URL", () => {
    const cfg = resolveConfig({ baseUrl: "http://gw:8420///" }, {});
    expect(cfg.baseUrl).toBe("http://gw:8420");
  });

  it("trims whitespace-only api keys down to undefined", () => {
    expect(resolveConfig({}, { TDAI_GATEWAY_API_KEY: "  \n" }).apiKey).toBeUndefined();
    expect(resolveConfig({}, { TDAI_GATEWAY_API_KEY: " k \n" }).apiKey).toBe("k");
  });

  it("ignores invalid timeout env values", () => {
    expect(resolveConfig({}, { TDAI_GATEWAY_TIMEOUT_MS: "abc" }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveConfig({}, { TDAI_GATEWAY_TIMEOUT_MS: "-5" }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});
