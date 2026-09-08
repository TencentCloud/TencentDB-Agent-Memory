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
 * localPath。fresh fetch 会清空历史失败残留；sync 则保留 localPath/.codegraph，
 * 避免删除正在复用的 SQLite/WAL 索引。
 */
export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "local";
  private readonly root = "/workspace/repos";

  validate(sourceUrl: string): void {
    const localPath = this.normalizePath(sourceUrl);

    if (!fs.existsSync(this.root)) {
      throw new Error(`local repo root does not exist: ${this.root}`);
    }
    if (!fs.existsSync(localPath)) {
      throw new Error(`local repo path does not exist: ${localPath}`);
    }
    if (!fs.statSync(localPath).isDirectory()) {
      throw new Error(`local repo path is not a directory: ${localPath}`);
    }

    const root = fs.realpathSync(this.root);
    const resolved = fs.realpathSync(localPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`local repo path must be inside ${root}: ${resolved}`);
    }
  }

  async fetch(sourceUrl: string, _branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const sourcePath = fs.realpathSync(this.normalizePath(sourceUrl));
    const targetPath = path.resolve(localPath);

    if (sourcePath === targetPath || targetPath.startsWith(sourcePath + path.sep)) {
      throw new Error(`managed localPath must not overlap source repo: ${targetPath}`);
    }

    // fresh build：彻底清掉之前失败任务可能遗留的 .codegraph WAL/SHM/DB，
    // 避免下一次 indexProject(dir) 继续打开旧索引导致 database is locked。
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    await fs.promises.mkdir(targetPath, { recursive: true });
    await this.copyWorkspace(sourcePath, targetPath);

    return {
      localPath: targetPath,
      version: await this.headCommit(sourcePath),
      sourceType: "local",
    };
  }

  async sync(sourceUrl: string, _branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const sourcePath = fs.realpathSync(this.normalizePath(sourceUrl));
    const targetPath = path.resolve(localPath);

    if (sourcePath === targetPath || targetPath.startsWith(sourcePath + path.sep)) {
      throw new Error(`managed localPath must not overlap source repo: ${targetPath}`);
    }

    await fs.promises.mkdir(targetPath, { recursive: true });

    // 增量同步：镜像当前本地工作区，但保留 CodeGraph 的索引目录。
    // worker 随后会 openIndex(dir)/syncIndex(instance)，因此不能删除 .codegraph。
    for (const entry of await fs.promises.readdir(targetPath, { withFileTypes: true })) {
      if (entry.name === ".codegraph") continue;
      await fs.promises.rm(path.join(targetPath, entry.name), {
        recursive: true,
        force: true,
      });
    }

    await this.copyWorkspace(sourcePath, targetPath);

    return {
      localPath: targetPath,
      version: await this.headCommit(sourcePath),
      sourceType: "local",
    };
  }

  private async copyWorkspace(sourcePath: string, targetPath: string): Promise<void> {
    await fs.promises.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      filter: (src) => {
        const relative = path.relative(sourcePath, src);
        if (!relative) return true;

        // 保留 .git，确保后续 worker 能识别为 existing repo 并进入 sync 流程。
        // node_modules 没有索引价值且体积巨大；源仓库的 .codegraph 绝不能复制。
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
