/**
 * Dify adapter — barrel.
 *
 * Inbound REST adapter implementing Dify's External Knowledge Base API
 * (memory READ) plus Custom Tool endpoints (memory WRITE). Built entirely on
 * the Adapter SDK — see ./README.md for the Dify console walkthrough.
 */

export { DifyMemoryAdapter } from "./server.js";
export type { DifyMemoryAdapterOptions } from "./server.js";
export { buildOpenApiSpec } from "./openapi.js";
export {
  KNOWLEDGE_ID_MEMORIES,
  KNOWLEDGE_ID_CONVERSATIONS,
} from "./types.js";
export type {
  DifyRetrievalRequest,
  DifyRetrievalSetting,
  DifyRetrievalRecord,
  DifyRetrievalResponse,
  DifyErrorBody,
  DifyCaptureToolRequest,
  DifyCaptureToolResponse,
  DifyRecallToolRequest,
  DifyRecallToolResponse,
} from "./types.js";
