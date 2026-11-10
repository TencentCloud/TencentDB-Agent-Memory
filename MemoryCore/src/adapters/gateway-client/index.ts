export { GatewayMemoryClient } from "./client.js";
export { createGatewayPlatformAdapter } from "./platform-adapter.js";
export { gatewayClientOptionsFromEnv } from "./environment.js";
export { assertTdaiIdentity, deriveTdaiSessionKey, resolveTdaiIdentity } from "./identity.js";
export {
  GatewayMemoryClientError,
  GatewayConfigurationError,
  GatewayTransportError,
  GatewayTimeoutError,
  GatewayRedirectError,
  GatewayHttpError,
  GatewayParseError,
  GatewayResponseError,
} from "./errors.js";
export type {
  GatewayMemoryClientOptions,
  GatewayHealthResponse,
  GatewayRecallInput,
  GatewayRecallResponse,
  GatewayCaptureMessage,
  GatewayCaptureInput,
  GatewayCaptureResponse,
  GatewayMemorySearchInput,
  GatewayMemorySearchResponse,
  GatewayConversationSearchInput,
  GatewayConversationSearchResponse,
  GatewaySessionEndInput,
  GatewaySessionEndResponse,
  SessionIdentity,
  CompletedPlatformTurn,
  PlatformBinding,
  GatewayPlatformAdapter,
} from "./types.js";
export type {
  TdaiIdentity,
  ResolveTdaiIdentityOptions,
} from "./identity.js";
