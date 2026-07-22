import {
  createAdapterRuntime,
  createGatewayMemoryClient,
  type AdapterRuntime,
  type PlatformAdapter,
} from "@tencentdb-agent-memory/memory-tencentdb/adapter-sdk";

interface ConsumerBindings {
  recall(prompt: string): Promise<string | undefined>;
}

class ConsumerAdapter implements PlatformAdapter<ConsumerBindings> {
  readonly platform = "consumer";

  create(runtime: AdapterRuntime): ConsumerBindings {
    return {
      recall: async (prompt) => (
        await runtime.recall({ query: prompt, sessionKey: "consumer:session" })
      )?.context,
    };
  }
}

const adapter = new ConsumerAdapter();
adapter.create(createAdapterRuntime({
  platform: adapter.platform,
  client: createGatewayMemoryClient(),
}));