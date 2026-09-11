import { describe, expect, it, vi } from "vitest";
import { createAdapterRuntime } from "./runtime.js";
import type { AdapterRuntime, MemoryClient, PlatformAdapter } from "./types.js";

interface ExampleBindings {
  beforePrompt(query: string): Promise<string>;
}

class ExamplePlatformAdapter implements PlatformAdapter<ExampleBindings> {
  readonly platform = "example";

  create(runtime: AdapterRuntime): ExampleBindings {
    return {
      beforePrompt: async (query) => {
        const result = await runtime.recall({ query, sessionKey: "example:session" });
        return result?.context ? `<memory>${result.context}</memory>` : query;
      },
    };
  }
}

describe("PlatformAdapter", () => {
  it("lets a new platform integrate by implementing one interface", async () => {
    const client = {
      recall: vi.fn().mockResolvedValue({ context: "remembered", memoryCount: 1 }),
      capture: vi.fn(),
      endSession: vi.fn(),
      searchMemories: vi.fn(),
      searchConversations: vi.fn(),
    } satisfies MemoryClient;
    const adapter = new ExamplePlatformAdapter();
    const bindings = adapter.create(createAdapterRuntime({ platform: adapter.platform, client }));

    await expect(bindings.beforePrompt("question")).resolves.toBe("<memory>remembered</memory>");
  });
});