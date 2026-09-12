/**
 * Codex MCP adapter — barrel re-export.
 *
 * Provides a Gateway HTTP client and an MCP server/registration helpers
 * so Codex can call TencentDB Agent Memory tools through the Model Context Protocol.
 */

export {
  CodexGatewayClient,
  GatewayClientError,
} from "./gateway-client.js";
export type { CodexGatewayClientOptions } from "./gateway-client.js";

export {
  createCodexMcpServer,
  registerCodexMemoryTools,
  runCodexMcpServer,
} from "./mcp-server.js";
export type { CodexMemoryClient, ToolRegistrationTarget } from "./mcp-server.js";

export {
  recallInputSchema,
  captureInputSchema,
  memorySearchInputSchema,
  conversationSearchInputSchema,
  sessionEndInputSchema,
  normalizeLimit,
} from "./tool-schemas.js";
export type {
  RecallToolInput,
  CaptureToolInput,
  MemorySearchToolInput,
  ConversationSearchToolInput,
  SessionEndToolInput,
} from "./tool-schemas.js";
