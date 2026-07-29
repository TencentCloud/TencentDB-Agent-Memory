export {
  CodingAgentGatewayClient,
  CodingAgentGatewayError,
} from "./gateway-client.js";
export type {
  CodingAgentConversationSearchRequest,
  CodingAgentGatewayClientOptions,
  CodingAgentMemorySearchRequest,
  CodingAgentRecallRequest,
  CodingAgentTurn,
} from "./gateway-client.js";

export {
  combineRecallContext,
  runCodingAgentAdapter,
} from "./platform-adapter.js";
export type {
  CodingAgentAdapterOptions,
  CodingAgentAdapterResult,
  CodingAgentClient,
  CodingAgentEvent,
  CodingAgentPlatformAdapter,
  CodingAgentRecallLike,
} from "./platform-adapter.js";

