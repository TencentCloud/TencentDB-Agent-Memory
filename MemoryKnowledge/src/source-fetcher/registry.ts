/**
 * SourceFetcherRegistry — 按 sourceUrl 协议路由到对应的 ISourceFetcher。
 *
 * module.ts 的 worker 通过 registry.resolve(url) 获取 fetcher，不再直接调 git。
 * 未来新增协议只需 implements ISourceFetcher + register()。
 */

import type { ISourceFetcher, SourceType } from "./types.js";
import { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";

export class SourceFetcherRegistry {
  private readonly fetchers = new Map<SourceType, ISourceFetcher>();

  constructor(gitOptions?: GitSourceFetcherOptions) {
    this.register(new GitSourceFetcher(gitOptions));
    // 未来：this.register(new LocalSourceFetcher());
    // 未来：this.register(new FtpSourceFetcher());
  }

  register(fetcher: ISourceFetcher): void {
    this.fetchers.set(fetcher.supportedType, fetcher);
  }

  /** 根据 sourceUrl 自动探测协议类型，返回对应 fetcher；未注册则 throw。 */
  resolve(sourceUrl: string): ISourceFetcher {
    const type = this.detectType(sourceUrl);
    const fetcher = this.fetchers.get(type);
    if (!fetcher) {
      throw new Error(`unsupported source type: ${type} (${sourceUrl})`);
    }
    return fetcher;
  }

  private detectType(url: string): SourceType {
    if (
      url.startsWith("git@") ||
      url.startsWith("ssh://") ||
      url.startsWith("https://") ||
      url.startsWith("http://")
    ) {
      return "git";
    }
    if (url.startsWith("file://") || url.startsWith("/") || url.startsWith("./")) {
      return "local";
    }
    if (url.startsWith("ftp://")) return "ftp";
    return "git";
  }
}
