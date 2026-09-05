/**
 * resolveFileStorageBackend — the single place that decides local vs. COS
 * vs. git file storage for a given instance and constructs+caches its
 * StorageAdapter.
 *
 * Extracted from two near-identical call sites in server.ts
 * (`resolveStorageForInstance` and the `resolveStorage` closure inside
 * `buildTaskExecutor`) that had drifted into slightly different shapes for
 * the same local/COS decision. Both now delegate here; this is also where
 * the "git" branch is added, per docs/rfc/git-storage-backend.md.
 */
import type { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend, GitStorageBackend } from "../core/storage/index.js";
import type { IGitCredentialProvider, StorageLogger } from "../core/storage/types.js";
import { StaticGitCredentialProvider } from "../core/storage/git-credential.js";
import type { GatewayConfig } from "./config.js";
import type { IStateBackend } from "../core/state/types.js";
import type { InstanceConfigProvider } from "../core/instance-config-provider.js";

/**
 * Default credentialRef resolution: treat it as an environment variable
 * name holding the token (http-token) or nothing (ssh, where sshKeyPath
 * itself is the secret-adjacent material, expected to already be
 * permission-restricted on disk by the deployment). This codebase has no
 * existing secret-manager integration to hook into for git auth — swap this
 * for a real one as needed; the contract callers rely on is just
 * `IGitCredentialProvider`.
 */
function resolveGitCredentialProvider(git: GatewayConfig["memory"]["git"]): IGitCredentialProvider {
  if (git.authMethod === "ssh") {
    if (!git.sshKeyPath) {
      throw new Error(`fileStorageBackend=git authMethod=ssh requires memory.git.sshKeyPath`);
    }
    return new StaticGitCredentialProvider({ authMethod: "ssh", privateKeyPath: git.sshKeyPath });
  }
  const token = git.credentialRef ? process.env[git.credentialRef] : undefined;
  if (!token) {
    throw new Error(
      `fileStorageBackend=git authMethod=http-token requires memory.git.credentialRef to name a set ` +
        `environment variable (got credentialRef=${JSON.stringify(git.credentialRef)})`,
    );
  }
  return new StaticGitCredentialProvider({ authMethod: "http-token", token });
}

export interface ResolveFileStorageBackendOptions {
  instanceId: string;
  config: GatewayConfig;
  logger: StorageLogger;
  cache: Map<string, StorageAdapter>;
  /** Read live, not snapshotted — a COS client initialized mid-call must be visible immediately. */
  getSharedCosClient: () => import("../integrations/cos/cos-backend.js").SharedCosClient | null;
  getConfigProvider: () => InstanceConfigProvider | null;
  getStateBackend: () => IStateBackend | null;
  /** Only the worker-task path lazily initializes a missing COS client; resolveStorageForInstance does not (preserves existing behavior at both call sites). */
  ensureCosClient?: () => Promise<void>;
  /**
   * Only `start()`'s core-default-storage call site historically had an
   * unconditional-success contract: pre-this-diff it always fell back to
   * LocalStorageBackend rather than ever throwing, regardless of deployMode.
   * resolveStorageForInstance/the worker-task closure correctly throw when
   * COS is unavailable in service mode — this must default to false so
   * their stricter behavior isn't accidentally loosened.
   */
  allowLocalFallbackOnCosUnavailable?: boolean;
  /** For error messages, e.g. "instance abc123" vs "worker task xyz (instance=abc123)". */
  errorContext: string;
}

export async function resolveFileStorageBackend(opts: ResolveFileStorageBackendOptions): Promise<StorageAdapter> {
  const { StorageAdapter: StorageAdapterCtor } = await import("../core/storage/adapter.js");
  const cached = opts.cache.get(opts.instanceId);
  if (cached) return cached;

  const selection = opts.config.memory.fileStorageBackend ?? "auto";

  if (selection === "git") {
    const git = opts.config.memory.git;
    if (!git?.remoteUrl) {
      throw new Error(`fileStorageBackend=git requires memory.git.remoteUrl (${opts.errorContext})`);
    }
    const stateBackend = opts.getStateBackend();
    if (!stateBackend) {
      throw new Error(
        `fileStorageBackend=git requires a configured state backend for the single-writer lock, ` +
          `but none is available (${opts.errorContext}). A process-local state backend would provide ` +
          `no cross-process protection in a multi-instance deployment; configure a real distributed ` +
          `IStateBackend before enabling the git storage backend.`,
      );
    }
    const backend = new GitStorageBackend({
      localRootDir: git.localRootDir,
      remoteUrl: git.remoteUrl,
      credentialProvider: resolveGitCredentialProvider(git),
      // This codebase's isolation unit is instanceId; there's no separate
      // tenant concept at this layer (contrast COS, which shares one bucket
      // across instances via pathPrefix). "default" keeps the branch
      // hierarchy shape from the RFC without inventing a fake tenant id.
      branchNameSeed: { tenantId: "default", instanceId: opts.instanceId },
      stateBackend,
      batchWindowMs: git.batchWindowMs,
      maxBatchDelayMs: git.maxBatchDelayMs,
      lockTtlMs: git.lockTtlMs,
      maxPushRetries: git.maxPushRetries,
      recoveryMode: git.recoveryMode,
      logger: opts.logger,
    });
    const adapter = new StorageAdapterCtor(backend);
    opts.cache.set(opts.instanceId, adapter);
    return adapter;
  }

  const useLocal =
    selection === "local" ||
    (selection === "auto" && !opts.getSharedCosClient() && opts.config.deployMode === "standalone");

  if (useLocal) {
    const backend = new LocalStorageBackend({ rootDir: opts.config.data.baseDir, logger: opts.logger });
    const adapter = new StorageAdapterCtor(backend);
    opts.cache.set(opts.instanceId, adapter);
    return adapter;
  }

  // COS path
  if (!opts.getSharedCosClient() && opts.ensureCosClient) {
    await opts.ensureCosClient();
  }
  const sharedCosClient = opts.getSharedCosClient();
  if (!sharedCosClient) {
    if (opts.allowLocalFallbackOnCosUnavailable) {
      const backend = new LocalStorageBackend({ rootDir: opts.config.data.baseDir, logger: opts.logger });
      const adapter = new StorageAdapterCtor(backend);
      opts.cache.set(opts.instanceId, adapter);
      return adapter;
    }
    throw new Error(`SharedCosClient not initialized for ${opts.errorContext}`);
  }
  const configProvider = opts.getConfigProvider();
  if (!configProvider) {
    throw new Error(`configProvider not initialized for ${opts.errorContext}`);
  }
  const cosConfig = await configProvider.resolveCos();
  if (!cosConfig?.cosUrl) {
    throw new Error(`COS config not available for ${opts.errorContext} (Shark returned null or empty CosUrl)`);
  }
  const { CosStorageBackend } = await import("../integrations/cos/cos-backend.js");
  const prefix = `${cosConfig.pathPrefix.replace(/\/$/, "")}/${opts.instanceId}/`;
  const backend = new CosStorageBackend({ sharedClient: sharedCosClient, prefix, logger: opts.logger });
  const adapter = new StorageAdapterCtor(backend);
  opts.cache.set(opts.instanceId, adapter);
  return adapter;
}
