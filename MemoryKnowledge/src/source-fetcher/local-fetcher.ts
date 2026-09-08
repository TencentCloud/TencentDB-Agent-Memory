import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";

import type { FetchResult, ISourceFetcher, SourceType } from "./types.js";

/**
 * LocalSourceFetcher — 从挂载进容器的本地仓库同步源码到 Knowledge 管理的工作目录。
 *
 * 约定：宿主机 /home/godkill/code 挂载到容器 /workspace/repos。
 * sourceUrl 仅允许指向 /workspace/repos 下的目录。
 *
 * 注意：CodeGraph worker 后续始终对传入的 localPath 执行 indexProject/openIndex，
 * 因此这里不能直接把 sourceUrl 作为 FetchResult.localPath 返回；必须把源码准备到
 * localPath。sync 时保留 localPath/.codegraph，避免删除正在复用的 SQLite/WAL 索引。
 */
export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "local";
  private readonly root = "/workspace/repos";

  validate(sourceUrl: string): void {
    const localPath = this.normalizePath(sourceUrl);
    const root = fs.realpathSync(this.root);

    if (!fs.existsSync(localPath)) {
      throw new Error(`local repo path does not exist: ${localPath}`);
    }

    if (!fs.statSync(localPath).isDirectory()) {
      throw new Error(`local repo path is not a directory: ${localPath}`);
    }

    const resolved = fs.realpathSync(localPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`local repo path must be inside ${root}: ${resolved}`);
    }
  }

  async fetch(sourceUrl: string, _branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const sourcePath = fs.realpathSync(this.normalizePath(sourceUrl));

    await fs.promises.mkdir(localPath, { recursive: true });
    await this.copyWorkspace(sourcePath, localPath);

    return {
      localPath,
      version: await this.headCommit(sourcePath),
      sourceType: "local",
    };
  }

  async sync(sourceUrl: string, _branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const sourcePath = fs.realpathSync(this.normalizePath(sourceUrl));

    await fs.promises.mkdir(localPath, { recursive: true });

    // 镜像当前本地工作区，但必须保留 CodeGraph 已打开/可复用的索引目录。
    // 这样 worker 后续可以安全执行 openIndex(dir) / syncIndex(instance)。
    for (const entry of await fs.promises.readdir(localPath, { withFileTypes: true })) {
      if (entry.name === ".codegraph") continue;
      await fs.promises.rm(path.join(localPath, entry.name), {
        recursive: true,
        force: true,
      });
    }

    await this.copyWorkspace(sourcePath, localPath);

    return {
      localPath,
      version: await this.headCommit(sourcePath),
      sourceType: "local",
    };
  }

  private async copyWorkspace(sourcePath: string, localPath: string): Promise<void> {
    await fs.promises.cp(sourcePath, localPath, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      filter: (src) => {
        const relative = path.relative(sourcePath, src);
        if (!relative) return true;

        // 不复制依赖目录，也绝不能把源仓库里已有的 CodeGraph DB 复制到托管目录。
        const segments = relative.split(path.sep);
        return !segments.includes("node_modules") && !segments.includes(".codegraph");
      },
    });
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
