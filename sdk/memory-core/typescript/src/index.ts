/**
 * @tencentdb-agent-memory/memory-sdk-ts-v2 — TypeScript SDK for TencentDB Agent Memory v3 API.
 *
 * 顶级 export 直接来自 v3 严格 isolation 版本。老代码若之前从
 * `@tencentdb-agent-memory/memory-sdk-ts-v2/v3` 子路径导入，可以继续用（子路径
 * 保留为向后兼容别名，与本模块内容完全一致）。
 */

export * from "./v3/index.js";

// HTTP 契约的原始 data-shape 类型 —— v3 client 返回这些形状（v3/types.ts 里
// 有一份 `V3*` 别名，两个名字均可用）。
export type {
  // Common
  ApiResponseEnvelope, CountData,
  // L0
  ConversationItem, ConversationAddData, ConversationQueryData,
  ConversationSearchData, ConversationSearchHit, ConversationDeleteData,
  // L1
  AtomicDetail, AtomicUpdateData, AtomicQueryData,
  AtomicSearchData, AtomicSearchHit, AtomicDeleteData,
  // L2
  ScenarioEntry, ScenarioListData, ScenarioFile, ScenarioWriteData,
  // L3
  CoreFile, CoreWriteData,
  // Offload
  OffloadToolPair, OffloadRecentMessage,
  OffloadIngestRequest, OffloadIngestData,
  OffloadCompactRequest, OffloadCompactData, OffloadCompactReport,
  OffloadQueryMmdRequest, OffloadQueryMmdData,
} from "./types.js";

// 共享类型 / util（不属于 v3-only，也不是 v2 API 实现，导出给需要自定义 transport
// 或用 STS COS 直读的调用方使用）
export { ParamError, TDAMError } from "./errors.js";
export { HttpTransport, type HttpTransportOptions } from "./http.js";
export type { MemoryClientConfig, Transport } from "./client.js";
export {
  MemoryFileReader,
  StsCredentialManager,
  StsCredential,
  createMemoryFileReader,
  cosV5Sign,
  type MemoryFileReaderConfig,
} from "./cos.js";
