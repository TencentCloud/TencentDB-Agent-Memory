import {
  CoreMemoryOperations,
  GatewayMemoryOperations,
  TdaiAdapterRuntime,
  TdaiGatewayClient,
  getMcpToolDefinitions,
  type AdapterRecallResult,
  type CoreMemoryOperationsOptions,
  type TdaiPlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";

export interface ExampleHostEvent {
  prompt?: string;
  userText?: string;
  assistantText?: string;
  messages?: unknown[];
}

export interface ExampleHostContext {
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  promptParts: string[];
}

export type ExampleRuntime = TdaiAdapterRuntime<ExampleHostEvent, ExampleHostContext>;

export const examplePlatformAdapter: TdaiPlatformAdapter<ExampleHostEvent, ExampleHostContext> = {
  platform: "example-agent-platform",

  getSession({ context }) {
    return {
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      userId: context.userId,
    };
  },

  getRecallInput({ event }) {
    return event.prompt?.trim() ? { query: event.prompt } : undefined;
  },

  getCaptureInput({ event }) {
    if (!event.userText?.trim()) return undefined;
    return {
      userContent: event.userText,
      assistantContent: event.assistantText ?? "",
      messages: event.messages,
    };
  },

  applyRecallResult(result: AdapterRecallResult, { context }) {
    const promptParts = [...context.promptParts];
    if (result.prependContext?.trim()) {
      promptParts.unshift(result.prependContext);
    }
    if (result.appendSystemContext?.trim()) {
      promptParts.push(result.appendSystemContext);
    }
    return { promptParts };
  },

  onError(phase, error) {
    console.warn(`[example-agent-platform] ${phase} failed:`, error);
  },
};

export function createGatewayBackedRuntime(options: {
  gatewayUrl: string;
  apiKey?: string;
  defaultSessionKey?: string;
  timeoutMs?: number;
}): ExampleRuntime {
  const client = new TdaiGatewayClient({
    baseUrl: options.gatewayUrl,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? 10_000,
  });

  return new TdaiAdapterRuntime({
    adapter: examplePlatformAdapter,
    operations: new GatewayMemoryOperations({
      client,
      defaultSessionKey: options.defaultSessionKey ?? "example-platform-default",
    }),
  });
}

export function createCoreBackedRuntime(core: CoreMemoryOperationsOptions["core"]): ExampleRuntime {
  return new TdaiAdapterRuntime({
    adapter: examplePlatformAdapter,
    operations: new CoreMemoryOperations({ core }),
  });
}

export async function runExampleTurn(
  runtime: ExampleRuntime,
  event: ExampleHostEvent,
  context: ExampleHostContext,
): Promise<unknown> {
  const recallResult = await runtime.handleRecall({ event, context });
  const captureResult = await runtime.handleCapture({ event, context });
  return { recallResult, captureResult };
}

export const memoryToolDefinitions = getMcpToolDefinitions();
