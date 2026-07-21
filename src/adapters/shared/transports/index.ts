/**
 * Transport 层 — MemoryClient 接口及其实现。
 *
 *    types.ts         — MemoryClient 接口 + 参数/响应类型 + 错误模型
 *    http-transport.ts — HTTP Transport（复用 GatewayClient + retry + circuit-breaker）
 *    in-process-transport.ts — InProcess Transport（直接调用 TdaiCore，可注入 fake core）
 *
 *    factory.ts       — createMemoryClient() 工厂，根据配置选择 transport
 */

export { MemoryClientError } from "./types.js";
export { HttpMemoryClient } from "./http-transport.js";
export { InProcessMemoryClient } from "./in-process-transport.js";

export type {
  MemoryClient,
  MemoryClientStatus,
  MemoryClientErrorCode,
  RecallParams,
  CaptureParams,
  SearchMemoriesParams,
  SearchConversationsParams,
  EndSessionParams,
  HealthResponse,
  RecallResponse,
  CaptureResponse,
  SearchResponse,
  SessionEndResponse,
  HttpTransportOptions,
  InProcessTransportOptions,
} from "./types.js";
