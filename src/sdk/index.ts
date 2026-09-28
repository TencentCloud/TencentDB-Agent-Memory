/**
 * TDAI Unified Adapter SDK.
 *
 * A platform-neutral toolkit for wiring the TDAI four-layer memory engine
 * into any agent host. It sits on top of the Gateway HTTP boundary that the
 * OpenClaw and Hermes adapters already established, and distills the whole
 * cross-platform surface into three layers:
 *
 *   1. Transport   — `TdaiGatewayClient`: typed, retrying HTTP client.
 *   2. Capability  — `MemoryAdapter`: the one interface every transport
 *                    implements and every platform consumes.
 *                    `GatewayMemoryAdapter` is the reference HTTP transport.
 *   3. Tools       — `buildMemoryTools(adapter)`: host-neutral tool descriptors
 *                    (name + description + JSON Schema + `invoke`). A new
 *                    platform adapter just maps these onto its host's tool type.
 *
 * See `docs/adapters/ADDING-A-PLATFORM.md` for the end-to-end recipe.
 */

export {
  TdaiGatewayClient,
  TdaiGatewayError,
} from "./gateway-client.js";
export type {
  TdaiGatewayClientOptions,
  TdaiGatewayErrorCode,
  FetchLike,
  GatewayClientLogger,
  CaptureParams,
  SearchMemoriesParams,
  SearchConversationsParams,
  SeedParams,
} from "./gateway-client.js";

export {
  GatewayMemoryAdapter,
} from "./memory-adapter.js";
export type {
  MemoryAdapter,
  GatewayMemoryAdapterOptions,
  RecallInput,
  RecallResult,
  MemorySearchInput,
  MemorySearchResult,
  ConversationSearchInput,
  ConversationSearchResult,
  CaptureInput,
  CaptureResult,
  MemoryHealth,
} from "./memory-adapter.js";

export {
  buildMemoryTools,
  coerceLimit,
} from "./tools.js";
export type {
  MemoryTool,
  MemoryToolResult,
  JsonSchema,
  BuildMemoryToolsOptions,
} from "./tools.js";
