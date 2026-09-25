/**
 * source-fetcher barrel — 源码拉取接口层对外出口。
 */

export type { ISourceFetcher, FetchResult, FetchOptions, SourceType } from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";

export {
  buildGitAuthEnv,
  assertUsablePrivateKey,
  cleanupStaleGitAuthDirs,
  stripSimpleGitDebug,
  shellQuote,
  DEFAULT_HTTPS_USERNAME,
  type GitAuthMaterial,
  type GitAuthKind,
  type GitAuthPlan,
  type GitAuthEnvOptions,
} from "./git-auth.js";

export {
  parseGitUrl,
  normalizeHost,
  isValidHost,
  hasEmbeddedCredentials,
  isPrivateHost,
  isAllowedHost,
  hostMatchesPattern,
  parseAllowedHosts,
  type ParsedGitUrl,
  type GitProtocol,
} from "./git-url.js";
