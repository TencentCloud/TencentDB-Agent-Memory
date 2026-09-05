/**
 * Git credential providers — mirrors credential-provider.ts's Static/Cached
 * split, for git auth instead of COS.
 */
import type { GitCredential, IGitCredentialProvider, StorageLogger } from "./types.js";

/** Returns a fixed credential. Use for local dev, tests, or a pre-resolved secret. */
export class StaticGitCredentialProvider implements IGitCredentialProvider {
  constructor(private readonly credential: GitCredential) {}

  async getGitCredential(): Promise<GitCredential> {
    return this.credential;
  }

  invalidate(): void {
    // no-op for a static credential
  }
}

/** A function that fetches a fresh git credential from an external source (e.g. a secret manager). */
export type GitCredentialFetcher = () => Promise<GitCredential>;

export interface CachedGitCredentialProviderOptions {
  fetcher: GitCredentialFetcher;
  /** Refresh buffer in ms since last fetch (no expiresAt concept on GitCredential, so this is a flat TTL). Default: 10 minutes. */
  cacheTtlMs?: number;
  logger?: StorageLogger;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

/** Generic cached git credential provider — in-memory cache, forced invalidation on push auth failure. */
export class CachedGitCredentialProvider implements IGitCredentialProvider {
  private cached: GitCredential | null = null;
  private fetchedAt = 0;
  private readonly cacheTtlMs: number;
  private readonly fetcher: GitCredentialFetcher;
  private readonly logger?: StorageLogger;
  private fetchPromise: Promise<GitCredential> | null = null;

  constructor(opts: CachedGitCredentialProviderOptions) {
    this.fetcher = opts.fetcher;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.logger = opts.logger;
  }

  async getGitCredential(): Promise<GitCredential> {
    if (this.cached && Date.now() - this.fetchedAt < this.cacheTtlMs) {
      return this.cached;
    }
    if (!this.fetchPromise) {
      this.fetchPromise = this.refresh();
    }
    try {
      return await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  invalidate(): void {
    this.logger?.debug?.(`[storage][git-credential] cache invalidated`);
    this.cached = null;
    this.fetchedAt = 0;
    this.fetchPromise = null;
  }

  private async refresh(): Promise<GitCredential> {
    try {
      const credential = await this.fetcher();
      this.cached = credential;
      this.fetchedAt = Date.now();
      return credential;
    } catch (err) {
      if (this.cached) {
        this.logger?.warn(`[storage][git-credential] refresh failed, using stale cache: ${err}`);
        return this.cached;
      }
      throw err;
    }
  }
}
