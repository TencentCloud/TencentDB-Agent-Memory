import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "./config.js";

const originalConfigPath = process.env.TDAI_GATEWAY_CONFIG;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalConfigPath === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
  else process.env.TDAI_GATEWAY_CONFIG = originalConfigPath;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("gateway local LLM configuration", () => {
  it("loads and passes capability controls to memory runners", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-llm-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "gateway.yaml");
    await fs.writeFile(configPath, `
llm:
  backend: llama.cpp
  baseUrl: http://127.0.0.1:8080/v1
  apiKey: local
  model: qwen3.5-27b
  maxTokens: 2048
  contextWindow: 8192
  inputBudgetTokens: 6000
  reasoning:
    enabled: false
    format: none
  startupProbe:
    enabled: true
    strict: true
    timeoutMs: 3000
  extraBody:
    cache_prompt: true
`, "utf8");
    process.env.TDAI_GATEWAY_CONFIG = configPath;

    const config = loadGatewayConfig();
    expect(config.llm).toMatchObject({
      backend: "llama.cpp",
      contextWindow: 8192,
      inputBudgetTokens: 6000,
      reasoning: { enabled: false, format: "none" },
      startupProbe: { enabled: true, strict: true, timeoutMs: 3000 },
      extraBody: { cache_prompt: true },
    });
    expect(config.memory.llm).toMatchObject({
      enabled: true,
      backend: "llama.cpp",
      contextWindow: 8192,
      reasoning: { enabled: false, format: "none" },
    });
  });
});
