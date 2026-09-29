/**
 * source-fetcher barrel — 源码拉取接口层对外出口。
 */

export {
  SourceVersionProbeError,
  type ISourceFetcher,
  type FetchResult,
  type SourceType,
  type SourceVersionProbeResult,
  type SourceVersionProbeErrorCode,
} from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
