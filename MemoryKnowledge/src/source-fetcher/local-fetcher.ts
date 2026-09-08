import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";

import type { FetchResult, ISourceFetcher, SourceType } from "./types.js";

/**
 * LocalSourceFetcher — 直接使用挂载进容器的本地仓库，不复制源码。
 *
 * 约定：宿主机 /home/godkill/code 挂载到容器 /workspace/repos。
 * sourceUrl 仅允许指向 /workspace/repos 下的目录。
 *
 * Knowledge/CodeGraph 的现有 worker 始终使用其托管目录 localPath 进行
 * indexProject/openIndex/restart recovery。因此本地源模式把这个托管目录本身
 * 建成指向 sourceUrl 的目录软链：既保持 worker 原有路径契约，又做到零复制。
 * CodeGraph 的 .codegraph 索引因此会落在用户仓库目录中。
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
    return this.prepare(sourceUrl, localPath);
  }

  async sync(sourceUrl: string, _branch: string, localPath: string): Promise<FetchResult> {
    return this.prepare(sourceUrl, localPath);
  }

  private async prepare(sourceUrl: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);

    const sourcePath = fs.realpathSync(this.normalizePath(sourceUrl));
    const targetPath = path.resolve(localPath);
    this.assertNoOverlap(sourcePath, targetPath);

    await this.ensureManagedSymlink(sourcePath, targetPath);

    return {
      localPath: targetPath,
      version: await this.headCommit(sourcePath),
      sourceType: "local",
    };
  }

  private assertNoOverlap(sourcePath: string, targetPath: string): void {
    if (
      sourcePath === targetPath ||
      targetPath.startsWith(sourcePath + path.sep) ||
      sourcePath.startsWith(targetPath + path.sep)
    ) {
      throw new Error(`managed localPath must not overlap source repo: ${targetPath}`);
    }
  }

  /**
   * 保证 Knowledge 托管目录是指向本地仓库的软链。
   *
   * - 已经是正确软链：直接复用；
   * - 是旧版本遗留的真实目录（包含复制出的源码/.codegraph）：安全删除后换成软链；
   * - 是错误/断裂软链：unlink 后重建。
   *
   * 删除 targetPath 只作用于托管目录本身；软链场景使用 unlink，绝不会递归删除源仓库。
   */
  private async ensureManagedSymlink(sourcePath: string, targetPath: string): Promise<void> {
    try {
      const stat = await fs.promises.lstat(targetPath);

      if (stat.isSymbolicLink()) {
        try {
          if (fs.realpathSync(targetPath) === sourcePath) return;
        } catch {
          // broken/wrong symlink: replace below
        }
        await fs.promises.unlink(targetPath);
      } else {
        await fs.promises.rm(targetPath, { recursive: true, force: true });
      }
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.symlink(sourcePath, targetPath, "dir");
  }

  private isNotFoundError(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    );
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
