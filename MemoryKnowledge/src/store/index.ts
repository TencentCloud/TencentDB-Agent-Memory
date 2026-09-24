/**
 * Knowledge data layer barrel — metadata/status SQLite + async orchestration services.
 */

export { SqliteKnowledgeStore } from "./sqlite-store.js";
export type {
  IKnowledgeStore,
  SyncStatus,
  WikiStatus,
  CodeGraphRow,
  CreateCodeGraphInput,
  CodeGraphStatusPatch,
  CodeGraphMetaPatch,
  WikiRow,
  CreateWikiInput,
  WikiStatusPatch,
  WikiMetaPatch,
  CreateResult,
  ListOpts,
  CountOpts,
  AuditAction,
  AuditLogInput,
  AuditLogRow,
  SyncedCodeGraphRef,
  SyncedWikiRef,
  GitCredentialKind,
  GitCredentialRow,
  CreateGitCredentialInput,
  CredentialAuditAction,
  CredentialAuditRow,
} from "./types.js";

export {
  genWikiId,
  genCodeGraphId,
  genGitCredentialId,
  isWikiId,
  isCodeGraphId,
  isGitCredentialId,
  WIKI_ID_PREFIX,
  CODE_GRAPH_ID_PREFIX,
  GIT_CREDENTIAL_ID_PREFIX,
} from "./ids.js";

export { BuildQueue } from "./build-queue.js";
export { SerialQueue } from "./serial-queue.js";

export { createLlmBindingStore, resolveLlmConfig } from "./llm-binding-store.js";
export type {
  ILlmBindingStore,
  LlmBindingRow,
  LlmBindingInput,
  LlmBindingStatus,
  LlmBindingMode,
} from "./llm-binding-store.js";

export { createGitCredentialStore, DuplicateCredentialNameError } from "./git-credential-store.js";
export type { IGitCredentialStore, GitCredentialStoreOptions } from "./git-credential-store.js";

export { CodeGraphService } from "./code-graph-service.js";
export type {
  CodeGraphWorker,
  CodeGraphBuildContext,
  CodeGraphBuildResult,
  CodeGraphServiceOptions,
  CreateCodeGraphParams,
  SyncResult,
} from "./code-graph-service.js";

export { WikiService } from "./wiki-service.js";
export type {
  WikiWorker,
  WikiBuildContext,
  WikiBuildResult,
  WikiServiceOptions,
  CreateWikiParams,
  IngestResult,
  RawFileEntry,
  RawWriteResult,
  RawReadItem,
  RawWriteManyItem,
  RawRmResult,
  PageWriteResult,
  PageReadItem,
  PageWriteManyItem,
  PageRmResult,
  WriteOutcome,
} from "./wiki-service.js";

export { AutoSyncScheduler, resolveAutoSyncConfig } from "./auto-sync-scheduler.js";
export type { AutoSyncConfig, AutoSyncSchedulerDeps } from "./auto-sync-scheduler.js";
