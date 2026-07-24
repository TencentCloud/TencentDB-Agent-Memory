/**
 * @tencentdb-agent-memory/memory-sdk-ts — TypeScript SDK for TencentDB Agent Memory v2 API.
 */

export { MemoryClient, type MemoryClientConfig, type Transport } from "./client.js";
export { TDAMError } from "./errors.js";
export { HttpTransport, type HttpTransportOptions } from "./http.js";
export { MemoryFileReader, StsCredentialManager, StsCredential, createMemoryFileReader, cosV5Sign, type MemoryFileReaderConfig } from "./cos.js";
export type {
  // L0
  ConversationItem, ConversationAddRequest, ConversationAddData,
  ConversationQueryRequest, ConversationQueryData,
  ConversationSearchRequest, ConversationSearchData,
  ConversationDeleteRequest, ConversationDeleteData,
  // L1
  AtomicDetail, AtomicUpdateRequest, AtomicUpdateData,
  AtomicQueryRequest, AtomicQueryData,
  AtomicSearchRequest, AtomicSearchData,
  AtomicDeleteRequest, AtomicDeleteData,
  // L2
  ScenarioEntry, ScenarioListRequest, ScenarioListData,
  ScenarioReadRequest, ScenarioFile,
  ScenarioWriteRequest, ScenarioWriteData,
  ScenarioRmRequest,
  // L3
  CoreFile, CoreWriteRequest, CoreWriteData,
  // Offload
  OffloadToolPair, OffloadRecentMessage,
  OffloadIngestRequest, OffloadIngestData,
  OffloadCompactRequest, OffloadCompactData, OffloadCompactReport,
  OffloadReadRefRequest, OffloadReadRefData,
  OffloadQueryMmdRequest, OffloadQueryMmdData,
  // Common
  ApiResponseEnvelope,
} from "./types.js";
