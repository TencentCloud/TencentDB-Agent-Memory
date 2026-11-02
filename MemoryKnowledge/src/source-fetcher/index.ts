/**
 * source-fetcher barrel — 源码拉取接口层对外出口。
 */

export type { ISourceFetcher, FetchResult, SourceType, GitFetchOptions } from "./types.js";
export {
  GitSourceFetcher,
  isGitAuthError,
  explainGitAuthError,
  isSshAuthError,
  type GitSourceFetcherOptions,
} from "./git-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
export {
  isSshUrl,
  parseSshHost,
  buildSshCommand,
  type SshFetchOptions,
} from "./ssh-options.js";
