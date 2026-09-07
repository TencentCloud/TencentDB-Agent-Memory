import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";

import type { FetchResult, ISourceFetcher, SourceType } from "./types.js";

/**
 * LocalSourceFetcher — 直接使用已挂载到容器内的本地仓库，不做 clone/copy。
 *
 * 约定：宿主机 /home/godkill/code 挂载到容器 /workspace/repos。
 * 仅允许访问 /workspace/repos 下的目录，避免任意本地路径被索引。
 */
export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "local";
  private readonly root = "/workspace/repos";

  validate(sourceUrl: string): void {
    const localPath = this.normalizePath(sourceUrl);
    const root = path.resolve(this.root);
    const resolved = path.resolve(localPath);

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`local repo path must be inside ${root}: ${resolved}`);
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`local repo path does not exist: ${resolved}`);
    }

    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`local repo path is not a directory: ${resolved}`);
    }
  }

  async fetch(sourceUrl: string, _branch: string, _localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const localPath = this.normalizePath(sourceUrl);
    const version = await this.headCommit(localPath);

    return {
      localPath,
      version,
      sourceType: "local",
    };
  }

  async sync(sourceUrl: string, _branch: string, _localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const localPath = this.normalizePath(sourceUrl);
    const version = await this.headCommit(localPath);

    return {
      localPath,
      version,
      sourceType: "local",
    };
  }

  private normalizePath(sourceUrl: string): string {
    if (sourceUrl.startsWith("file://")) {
      return path.resolve(new URL(sourceUrl).pathname);
    }
    return path.resolve(sourceUrl);
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }
}
