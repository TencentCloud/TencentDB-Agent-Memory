/**
 * source-fetcher barrel — 源码拉取接口层对外出口。
 */

export type { ISourceFetcher, FetchResult, SourceType, FetchOptions } from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export { RepoSourceFetcher, parseManifest, type ParsedManifest, type ManifestProject } from "./repo-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
