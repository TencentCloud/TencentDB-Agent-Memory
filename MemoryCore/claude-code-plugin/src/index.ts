export { loadConfig, defaultStateDir, type PluginConfig } from "./config.js";
export { createMemoryClient, createKnowledge } from "./client.js";
export { handleHook, type HookInput, type HookOutput, type HookDeps } from "./hooks/handler.js";
export { PluginState } from "./hooks/state.js";
export { performRecall } from "./hooks/recall.js";
export { sendTranscriptDelta, sendPlainTurn } from "./hooks/capture.js";
export {
  normalizeTranscript,
  readTranscriptEntries,
  redactSecrets,
  resolveTranscriptPath,
  sliceAfter,
  splitBatches,
  type TranscriptEntry,
  type TranscriptMessage,
} from "./hooks/transcript.js";
export { formatRecallContext, formatL1Memories, formatSessionContext, MEMORY_TOOLS_GUIDE } from "./format.js";
export { KnowledgeServiceClient, createKnowledgeTools, WIKI_PAGE_BATCH_LIMIT, type KnowledgeTools } from "./knowledge.js";
export { createClaudeCodeMcpServer } from "./mcp/server.js";
