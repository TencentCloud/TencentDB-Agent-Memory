/**
 * source-fetcher barrel — 源码拉取接口层对外出口。
 */

export type { ISourceFetcher, FetchResult, SourceType } from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export { LocalSourceFetcher } from "./local-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
