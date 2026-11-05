/**
 * Tests for #709 — StandaloneLLMRunner must pick the wire protocol provider
 * from `config.protocol`: Anthropic native when "anthropic", OpenAI-compatible
 * otherwise (backward compatible).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAI } = vi.hoisted(() => ({
  createOpenAI: vi.fn(() => ({ chat: vi.fn() })),
}));
const { createAnthropic } = vi.hoisted(() => ({
  createAnthropic: vi.fn(() => ({ chat: vi.fn() })),
}));
const { generateText } = vi.hoisted(() => ({
  generateText: vi.fn(async () => ({ text: "done", steps: [] })),
}));

vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("ai", () => ({
  generateText,
  tool: vi.fn(),
  stepCountIs: vi.fn(),
  jsonSchema: vi.fn(),
}));

import { StandaloneLLMRunner, type StandaloneLLMConfig } from "./llm-runner.js";

const BASE: StandaloneLLMConfig = {
  baseUrl: "https://api.test/v1",
  apiKey: "test-key",
  model: "some-model",
};

async function runWith(overrides: Partial<StandaloneLLMConfig>): Promise<void> {
  const runner = new StandaloneLLMRunner({
    config: { ...BASE, ...overrides },
  });
  await runner.run({
    prompt: "hi",
    systemPrompt: "sys",
    taskId: "t-1",
  } as never);
}

describe("StandaloneLLMRunner protocol selection (#709)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses createAnthropic when protocol=anthropic", async () => {
    await runWith({ protocol: "anthropic" });

    expect(createAnthropic).toHaveBeenCalledWith({
      baseURL: BASE.baseUrl,
      apiKey: BASE.apiKey,
    });
    expect(createOpenAI).not.toHaveBeenCalled();
  });

  it("uses createOpenAI by default (protocol unset, backward compatible)", async () => {
    await runWith({});

    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: BASE.baseUrl,
      apiKey: BASE.apiKey,
      compatibility: "compatible",
    });
    expect(createAnthropic).not.toHaveBeenCalled();
  });

  it("uses createOpenAI when protocol=openai", async () => {
    await runWith({ protocol: "openai" });

    expect(createOpenAI).toHaveBeenCalled();
    expect(createAnthropic).not.toHaveBeenCalled();
  });
});
