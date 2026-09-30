import type { LanguageModelMiddleware } from "ai";

type TransformParamsHook = NonNullable<LanguageModelMiddleware["transformParams"]>;
type AiSdkCallOptions = Parameters<TransformParamsHook>[0]["params"];
type AiSdkPrompt = AiSdkCallOptions["prompt"];
type WrapGenerateHook = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type GenerateOptions = Parameters<WrapGenerateHook>[0];
type AiSdkGenerateResult = Awaited<ReturnType<GenerateOptions["doGenerate"]>>;
type WrapStreamHook = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type StreamOptions = Parameters<WrapStreamHook>[0];
type AiSdkStreamResult = Awaited<ReturnType<StreamOptions["doStream"]>>;
type AiSdkStreamPart = AiSdkStreamResult["stream"] extends ReadableStream<infer Part>
  ? Part
  : never;

const MEMORY_BLOCK_OPEN = '<relevant-memories source="tencentdb-agent-memory">';
const MEMORY_BLOCK_CLOSE = "</relevant-memories>";
const MAX_ACTIVE_RECALLS = 32;

export interface AiSdkMemoryRecallRequest {
  query: string;
  sessionKey: string;
  userId?: string;
}

export interface AiSdkMemoryRecallResult {
  context: string;
}

export interface AiSdkMemoryCaptureRequest {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  userId?: string;
}

/** Transport-neutral memory boundary for the AI SDK middleware. */
export interface AiSdkMemoryPort {
  recall(request: AiSdkMemoryRecallRequest): Promise<AiSdkMemoryRecallResult | undefined>;
  capture(request: AiSdkMemoryCaptureRequest): Promise<void>;
}

export interface AiSdkMemoryMiddlewareError {
  phase: "recall" | "capture";
  error: unknown;
}

export interface AiSdkMemoryMiddlewareOptions {
  memory: AiSdkMemoryPort;
  /** Stable identity for one AI SDK conversation. */
  sessionKey: string;
  userId?: string;
  /** Optional fail-open diagnostic hook. Throwing from this callback is ignored. */
  onError?: (event: AiSdkMemoryMiddlewareError) => void;
}

/**
 * Create a Vercel AI SDK v6 language-model middleware for TDAI memory.
 *
 * Recall is appended to the latest user message so earlier prompt history stays
 * unchanged. Capture runs only for terminal text responses, not intermediate
 * tool-call steps. Both memory operations fail open.
 */
export function createAiSdkMemoryMiddleware(
  options: AiSdkMemoryMiddlewareOptions,
): LanguageModelMiddleware {
  const activeRecalls = new Map<string, Promise<string>>();

  const reportError = (phase: AiSdkMemoryMiddlewareError["phase"], error: unknown) => {
    try {
      options.onError?.({ phase, error });
    } catch {
      // Diagnostics must never break the model call.
    }
  };

  const clearRecall = (query: string) => {
    activeRecalls.delete(query);
  };

  const recall = (query: string): Promise<string> => {
    const cached = activeRecalls.get(query);
    if (cached) return cached;

    const pending = options.memory
      .recall({ query, sessionKey: options.sessionKey, userId: options.userId })
      .then((result) => result?.context.trim() ?? "")
      .catch((error) => {
        activeRecalls.delete(query);
        reportError("recall", error);
        return "";
      });

    activeRecalls.set(query, pending);
    while (activeRecalls.size > MAX_ACTIVE_RECALLS) {
      const oldest = activeRecalls.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      activeRecalls.delete(oldest);
    }
    return pending;
  };

  const capture = async (query: string, assistantContent: string) => {
    clearRecall(query);
    if (!query || !assistantContent.trim()) return;
    try {
      await options.memory.capture({
        userContent: query,
        assistantContent: assistantContent.trim(),
        sessionKey: options.sessionKey,
        userId: options.userId,
      });
    } catch (error) {
      reportError("capture", error);
    }
  };

  return {
    specificationVersion: "v3",

    transformParams: async ({ params }) => {
      const query = extractLatestUserText(params.prompt);
      if (!query) return params;

      const context = await recall(query);
      if (!context) return params;

      return {
        ...params,
        prompt: appendMemoryToLatestUser(params.prompt, context),
      };
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const query = extractLatestUserText(params.prompt);
      let result: AiSdkGenerateResult;
      try {
        result = await doGenerate();
      } catch (error) {
        clearRecall(query);
        throw error;
      }
      if (isTerminalFinish(result.finishReason.unified)) {
        await capture(query, extractGeneratedText(result));
      } else if (result.finishReason.unified !== "tool-calls") {
        clearRecall(query);
      }
      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const query = extractLatestUserText(params.prompt);
      let result: AiSdkStreamResult;
      try {
        result = await doStream();
      } catch (error) {
        clearRecall(query);
        throw error;
      }
      let generatedText = "";
      let finishReason: string | undefined;

      const stream = result.stream.pipeThrough(
        new TransformStream<AiSdkStreamPart, AiSdkStreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") generatedText += part.delta;
            if (part.type === "finish") finishReason = part.finishReason.unified;
            controller.enqueue(part);
          },
          async flush() {
            if (isTerminalFinish(finishReason)) {
              await capture(query, generatedText);
            } else if (finishReason && finishReason !== "tool-calls") {
              clearRecall(query);
            }
          },
        }),
      );

      return { ...result, stream };
    },
  };
}

function extractLatestUserText(prompt: AiSdkPrompt): string {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (message.role !== "user") continue;
    return message.content
      .filter((part) => part.type === "text" && !isMemoryBlock(part.text))
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function appendMemoryToLatestUser(prompt: AiSdkPrompt, context: string): AiSdkPrompt {
  const userIndex = findLatestUserIndex(prompt);
  if (userIndex < 0) return prompt;

  return prompt.map((message, index) => {
    if (index !== userIndex || message.role !== "user") return message;
    const content = message.content.filter(
      (part) => part.type !== "text" || !isMemoryBlock(part.text),
    );
    return {
      ...message,
      content: [
        ...content,
        {
          type: "text" as const,
          text: `${MEMORY_BLOCK_OPEN}\n${context}\n${MEMORY_BLOCK_CLOSE}`,
        },
      ],
    };
  });
}

function findLatestUserIndex(prompt: AiSdkPrompt): number {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index].role === "user") return index;
  }
  return -1;
}

function isMemoryBlock(text: string): boolean {
  return text.trimStart().startsWith(MEMORY_BLOCK_OPEN);
}

function isTerminalFinish(reason: string | undefined): boolean {
  return reason === "stop" || reason === "length";
}

function extractGeneratedText(result: AiSdkGenerateResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}
