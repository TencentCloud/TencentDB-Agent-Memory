import {
  createMemoryTencentDbSearchTool,
  runMemoryWrappedTurn,
  type LangGraphRuntimeLike,
} from "./adapter.js";

export const memorySearchTool = createMemoryTencentDbSearchTool();

export async function invokeAgentWithMemory(input: string, runtime: LangGraphRuntimeLike) {
  return runMemoryWrappedTurn({
    input,
    runtime,
    model: async (prompt) => {
      // Replace this function with your LangGraph model node.
      return `model answer for: ${prompt}`;
    },
  });
}

