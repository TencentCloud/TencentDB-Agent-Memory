import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "./config.js";
import { resolveStandaloneLlmForRuntime } from "./adapters/standalone/llm-provider-resolver.js";
import { loadGatewayConfig } from "./gateway/config.js";

describe("standalone LLM protocol configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses anthropic and defaults unknown values to openai", () => {
    expect(parseConfig({ llm: { protocol: "anthropic" } }).llm.protocol).toBe(
      "anthropic",
    );
    expect(parseConfig({ llm: { protocol: "invalid" } }).llm.protocol).toBe(
      "openai",
    );
  });

  it("accepts TDAI_LLM_PROTOCOL for Gateway deployments", () => {
    vi.stubEnv("TDAI_LLM_PROTOCOL", "anthropic");
    expect(loadGatewayConfig().llm.protocol).toBe("anthropic");

    vi.stubEnv("TDAI_LLM_PROTOCOL", "invalid");
    expect(loadGatewayConfig().llm.protocol).toBe("openai");
  });

  it("preserves the wire protocol when proxy access rewrites credentials", () => {
    vi.stubEnv("TDAI_MEMORY_SYSTEM_USER_KEY", `sk-mem-${"a".repeat(32)}`);
    const llm = parseConfig({
      llm: {
        enabled: true,
        provider: "proxy",
        protocol: "anthropic",
        baseUrl: "https://proxy.example.com",
      },
    }).llm;

    expect(resolveStandaloneLlmForRuntime(llm, "tenant/a")).toMatchObject({
      protocol: "anthropic",
      baseUrl: "https://proxy.example.com/proxy/tenant%2Fa/v1",
      apiKey: `sk-mem-${"a".repeat(32)}`,
    });
  });

  it("writes MEMORY_LLM_PROTOCOL into the generated Gateway yaml", () => {
    const script = readFileSync(
      new URL("../../deploy/global-images/start-memory-core.sh", import.meta.url),
      "utf8",
    );
    expect(script).toContain(
      'protocol: "${MEMORY_LLM_PROTOCOL:-openai}"',
    );
  });
});
