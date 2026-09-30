import { describe, expect, it, vi } from "vitest";
import { registerPiAgentMemoryExtension } from "./extension.js";
import { PiAgentGatewayClient } from "./gateway-client.js";

function mockClient() {
  return new PiAgentGatewayClient({ baseUrl: "http://127.0.0.1:8420", fetchImpl: vi.fn() as unknown as typeof fetch });
}

describe("registerPiAgentMemoryExtension", () => {
  it("registers Pi lifecycle hooks and custom tool definitions without MCP", () => {
    const hooks = new Map<string, unknown>();
    const tools = new Map<string, unknown>();
    const pi = {
      on: vi.fn((name: string, handler: unknown) => hooks.set(name, handler)),
      registerTool: vi.fn((definition: { name: string }) => tools.set(definition.name, definition)),
    };

    registerPiAgentMemoryExtension(pi, { client: mockClient() });

    expect([...hooks.keys()]).toEqual(["before_agent_start", "session_shutdown", "tool_result"]);
    expect([...tools.keys()]).toEqual(["memory_search", "conversation_search", "context_get"]);
    expect(tools.get("memory_search")).toMatchObject({
      name: "memory_search",
      parameters: expect.objectContaining({ type: "object" }),
      execute: expect.any(Function),
    });
  });
});