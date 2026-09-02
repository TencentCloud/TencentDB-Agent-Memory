import type { LanguageModelMiddleware } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  createAiSdkMemoryMiddleware,
  type AiSdkMemoryPort,
} from "./memory-middleware.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function prompt(text = "What did we decide?") {
  return [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
    },
  ];
}

function generateResult(text: string, finish: "stop" | "tool-calls" = "stop") {
  return {
    content: text ? [{ type: "text" as const, text }] : [],
    finishReason: { unified: finish, raw: undefined },
    usage,
    warnings: [],
  };
}

type TransformHook = NonNullable<LanguageModelMiddleware["transformParams"]>;
type TransformOptions = Parameters<TransformHook>[0];
type GenerateHook = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type GenerateOptions = Parameters<GenerateHook>[0];
type StreamHook = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type StreamOptions = Parameters<StreamHook>[0];

const model = {} as TransformOptions["model"];

async function transform(
  middleware: LanguageModelMiddleware,
  inputPrompt = prompt(),
): Promise<TransformOptions["params"]> {
  return middleware.transformParams!({
    type: "generate",
    params: { prompt: inputPrompt },
    model,
  });
}

async function generate(
  middleware: LanguageModelMiddleware,
  params: TransformOptions["params"],
  result: ReturnType<typeof generateResult>,
) {
  return middleware.wrapGenerate!({
    params,
    model,
    doGenerate: async () => result,
    doStream: async () => {
      throw new Error("unexpected stream call");
    },
  } as GenerateOptions);
}

describe("createAiSdkMemoryMiddleware", () => {
  it("injects recalled context and captures a terminal generate result", async () => {
    const memory = {
      recall: vi.fn(async () => ({ context: "Use the blue deployment." })),
      capture: vi.fn(async () => undefined),
    } satisfies AiSdkMemoryPort;
    const middleware = createAiSdkMemoryMiddleware({
      memory,
      sessionKey: "session-1",
      userId: "user-1",
    });

    const transformed = await transform(middleware);
    const result = await generate(
      middleware,
      transformed,
      generateResult("We chose the blue deployment."),
    );

    expect(result.content).toEqual([
      { type: "text", text: "We chose the blue deployment." },
    ]);
    expect(memory.recall).toHaveBeenCalledWith({
      query: "What did we decide?",
      sessionKey: "session-1",
      userId: "user-1",
    });
    expect(transformed.prompt).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What did we decide?" },
          {
            type: "text",
            text:
              '<relevant-memories source="tencentdb-agent-memory">\n' +
              "Use the blue deployment.\n" +
              "</relevant-memories>",
          },
        ],
      },
    ]);
    expect(memory.capture).toHaveBeenCalledWith({
      userContent: "What did we decide?",
      assistantContent: "We chose the blue deployment.",
      sessionKey: "session-1",
      userId: "user-1",
    });
  });

  it("reuses recall across tool steps and captures only the terminal response", async () => {
    const memory = {
      recall: vi.fn(async () => ({ context: "Project memory" })),
      capture: vi.fn(async () => undefined),
    } satisfies AiSdkMemoryPort;
    const middleware = createAiSdkMemoryMiddleware({
      memory,
      sessionKey: "tool-session",
    });

    const firstParams = await transform(middleware, prompt("Run the deployment"));
    await generate(middleware, firstParams, generateResult("", "tool-calls"));
    const secondParams = await transform(middleware, prompt("Run the deployment"));
    await generate(middleware, secondParams, generateResult("Final answer"));

    expect(memory.recall).toHaveBeenCalledTimes(1);
    expect(memory.capture).toHaveBeenCalledTimes(1);
    expect(memory.capture).toHaveBeenCalledWith({
      userContent: "Run the deployment",
      assistantContent: "Final answer",
      sessionKey: "tool-session",
      userId: undefined,
    });
  });

  it("replaces its own recall block without changing earlier prompt messages", async () => {
    const memory = {
      recall: vi.fn(async () => ({ context: "Fresh memory" })),
      capture: vi.fn(async () => undefined),
    } satisfies AiSdkMemoryPort;
    const middleware = createAiSdkMemoryMiddleware({
      memory,
      sessionKey: "idempotent-session",
    });
    const existingPrompt = [
      { role: "system" as const, content: "Stable system prompt" },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Question" },
          {
            type: "text" as const,
            text:
              '<relevant-memories source="tencentdb-agent-memory">\n' +
              "Stale memory\n" +
              "</relevant-memories>",
          },
          {
            type: "file" as const,
            data: "aGVsbG8=",
            mediaType: "text/plain",
          },
        ],
      },
    ];

    const transformed = await transform(middleware, existingPrompt);

    expect(transformed.prompt[0]).toEqual(existingPrompt[0]);
    expect(transformed.prompt[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Question" },
        { type: "file", data: "aGVsbG8=", mediaType: "text/plain" },
        {
          type: "text",
          text:
            '<relevant-memories source="tencentdb-agent-memory">\n' +
            "Fresh memory\n" +
            "</relevant-memories>",
        },
      ],
    });
  });

  it("captures text after a successful stream completes", async () => {
    const memory = {
      recall: vi.fn(async () => ({ context: "Streaming memory" })),
      capture: vi.fn(async () => undefined),
    } satisfies AiSdkMemoryPort;
    const middleware = createAiSdkMemoryMiddleware({
      memory,
      sessionKey: "stream-session",
    });
    const transformed = await transform(middleware, prompt("Stream this"));
    const result = await middleware.wrapStream!({
      params: transformed,
      model,
      doGenerate: async () => {
        throw new Error("unexpected generate call");
      },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "Streamed " });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "answer" });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              usage,
              finishReason: { unified: "stop", raw: undefined },
            });
            controller.close();
          },
        }),
      }),
    } as StreamOptions);

    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts.some((part) => part.type === "finish")).toBe(true);
    expect(memory.capture).toHaveBeenCalledWith({
      userContent: "Stream this",
      assistantContent: "Streamed answer",
      sessionKey: "stream-session",
      userId: undefined,
    });
  });

  it("fails open when recall or capture rejects", async () => {
    const recallError = new Error("recall unavailable");
    const captureError = new Error("capture unavailable");
    const onError = vi.fn();
    const memory = {
      recall: vi.fn(async () => Promise.reject(recallError)),
      capture: vi.fn(async () => Promise.reject(captureError)),
    } satisfies AiSdkMemoryPort;
    const middleware = createAiSdkMemoryMiddleware({
      memory,
      sessionKey: "failure-session",
      onError,
    });

    const transformed = await transform(middleware, prompt("Keep working"));
    const result = await generate(
      middleware,
      transformed,
      generateResult("Model still succeeds"),
    );

    expect(result.content).toEqual([{ type: "text", text: "Model still succeeds" }]);
    expect(transformed.prompt).toEqual(prompt("Keep working"));
    expect(onError).toHaveBeenNthCalledWith(1, { phase: "recall", error: recallError });
    expect(onError).toHaveBeenNthCalledWith(2, { phase: "capture", error: captureError });
  });
});
