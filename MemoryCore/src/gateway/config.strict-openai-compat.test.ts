import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "./config.js";
import { parseConfig } from "../config.js";
import { resolveStandaloneLlmForRuntime } from "../adapters/standalone/llm-provider-resolver.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("strict content config", () => {
  it.each([
    [undefined, undefined, false], [true, undefined, true],
    [true, "false", false], [false, "true", true],
  ])("YAML flag %s, env %s resolves to %s throughout gateway config", (flag, env, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "strict-compat-"));
    dirs.push(dir);
    const file = join(dir, "gateway.json");
    writeFileSync(file, JSON.stringify({ llm: { apiKey: "test", stream: true, strictOpenAICompat: flag } }));
    vi.stubEnv("TDAI_GATEWAY_CONFIG", file);
    vi.stubEnv("TDAI_LLM_STRICT_OPENAI_COMPAT", env);
    vi.stubEnv("TDAI_LLM_STREAM", undefined);
    const config = loadGatewayConfig();
    expect(config.llm.strictOpenAICompat).toBe(expected);
    expect(config.memory.llm.strictOpenAICompat).toBe(expected);
    expect(config.memory.llm.stream).toBe(true);
    expect(resolveStandaloneLlmForRuntime(config.memory.llm, "test").strictOpenAICompat).toBe(expected);
  });

  it("supports plugin config and proxy URL resolution", () => {
    expect(parseConfig({}).llm.strictOpenAICompat).toBe(false);
    const config = parseConfig({ llm: { enabled: true, strictOpenAICompat: true,
      provider: "proxy", apiKey: "test", proxy: { useMemorySystemUserKey: false } } });
    const resolved = resolveStandaloneLlmForRuntime(config.llm, "test");
    expect(resolved.strictOpenAICompat).toBe(true);
    expect(resolved.baseUrl).toContain("/proxy/test/v1");
  });
});
