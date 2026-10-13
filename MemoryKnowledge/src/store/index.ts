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
} from "./types.js";

export {
  genWikiId,
  genCodeGraphId,
  isWikiId,
  isCodeGraphId,
  WIKI_ID_PREFIX,
  CODE_GRAPH_ID_PREFIX,
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
export type { AutoSyncConfig, AutoSyncSchedulerDeps, WikiImporter } from "./auto-sync-scheduler.js";

export { toCodeGraphTarget, toWikiTarget, targetKey } from "./auto-sync-target.js";
export type { SyncTarget, SyncTargetKind } from "./auto-sync-target.js";

export { createCredentialStore } from "../source-auth/credential-store.js";
export { encodeSecret, decodeSecret } from "../source-auth/credential-codec.js";
export type {
  ICredentialStore,
  SourceCredential,
  CredentialKind,
  CredentialStatus,
  ResourceRef,
  ResourceType,
} from "../source-auth/types.js";

export { buildCloneUrl, stripCredentials } from "../code-source/clone-url.js";
export { CodeSourceRegistry } from "../code-source/registry.js";
export type { CodeSourceMeta, ICodeSourceProvider } from "../code-source/types.js";
