/**
 * Storage — barrel re-export for the storage abstraction layer.
 *
 * This file is the open-source / standalone surface of the storage layer.
 * It only re-exports the interface, the local backend, and the generic
 * credential primitives.
 *
 * Optional remote object storage support is loaded dynamically by the storage
 * factory at runtime.
 */

// Types & interfaces
export type {
  IStorageBackend,
  ICredentialProvider,
  IGitCredentialProvider,
  GitCredential,
  StorageBackendConfig,
  GitStorageBackendConfig,
  StorageObject,
  PutObjectOptions,
  ListObjectsOptions,
  ListResult,
  ListEntry,
  CosCredential,
  StorageLogger,
} from "./types.js";
export { StoragePaths } from "./types.js";

// Default implementation (always available)
export { LocalStorageBackend } from "./local-backend.js";
export type { LocalStorageBackendOptions } from "./local-backend.js";
export { StorageAdapter } from "./adapter.js";
export { resolveSafeRelativePath } from "./path-safety.js";

// Git backend (experimental — see docs/rfc/git-storage-backend.md). No
// optional npm dependency (shells out to the system `git` binary), so unlike
// COS it doesn't need dynamic import — always available like local.
export { GitStorageBackend, buildBranchName } from "./git-backend.js";
export type { GitStorageBackendOptions, GitSyncStatus, GitSyncSummary, BranchNameSeed } from "./git-backend.js";

// Generic credential primitives (no cloud-vendor dependency)
export {
  MockCredentialProvider,
  StaticCredentialProvider,
  CachedCredentialProvider,
  PrefixedCredentialProvider,
  parseCosUrl,
} from "./credential-provider.js";
export type {
  MockCredentialConfig,
  StaticCredentialConfig,
  CredentialFetcher,
  CachedCredentialProviderOptions,
} from "./credential-provider.js";
export {
  StaticGitCredentialProvider,
  CachedGitCredentialProvider,
} from "./git-credential.js";
export type {
  GitCredentialFetcher,
  CachedGitCredentialProviderOptions,
} from "./git-credential.js";

// Factory (dynamically loads optional COS backend when requested)
export {
  createStorageBackend,
  createLocalStorageBackend,
} from "./factory.js";
