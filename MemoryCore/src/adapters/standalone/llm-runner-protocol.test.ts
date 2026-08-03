import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const anthropicModel = { provider: "anthropic" };
  const openaiModel = { provider: "openai" };
  return {
    anthropicModel,
    openaiModel,
    anthropicChat: vi.fn(() => anthropicModel),
    openaiChat: vi.fn(() => openaiModel),
    createAnthropic: vi.fn(),
    createOpenAI: vi.fn(),
    generateText: vi.fn(),
  };
});

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mocks.generateText,
  };
});

import { StandaloneLLMRunner } from "./llm-runner.js";

describe("StandaloneLLMRunner wire protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAnthropic.mockReturnValue({
      chat: mocks.anthropicChat,
    });
    mocks.createOpenAI.mockReturnValue({
      chat: mocks.openaiChat,
    });
    mocks.generateText.mockResolvedValue({
      text: "ok",
      steps: [],
      usage: undefined,
      finishReason: "stop",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the native Anthropic provider for protocol=anthropic", async () => {
    const runner = new StandaloneLLMRunner({
      config: {
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "anthropic-key",
        model: "claude-haiku",
      },
    });

    await runner.run({
      taskId: "anthropic-test",
      systemPrompt: "system",
      prompt: "hello",
    });

    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      baseURL: "https://api.anthropic.com",
      apiKey: "anthropic-key",
    });
    expect(mocks.anthropicChat).toHaveBeenCalledWith("claude-haiku");
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: mocks.anthropicModel }),
    );
  });

  it("keeps the OpenAI-compatible provider as the default", async () => {
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "openai-key",
        model: "memory-model",
      },
    });

    await runner.run({
      taskId: "openai-test",
      systemPrompt: "system",
      prompt: "hello",
    });

    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      baseURL: "https://api.example.com/v1",
      apiKey: "openai-key",
      compatibility: "compatible",
    });
    expect(mocks.openaiChat).toHaveBeenCalledWith("memory-model");
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });
});
