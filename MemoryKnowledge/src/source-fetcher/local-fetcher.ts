/**
 * LocalSourceFetcher — локальные git-репозитории (абсолютный путь или file://).
 *
 * Пилот-патч 2026-08-18 (см. types.ts: «LocalSourceFetcher / FtpSourceFetcher — 未来扩展»).
 * Безопасность: путь обязан существовать и содержать .git — произвольные каталоги
 * без git-истории не принимаются (клон идёт штатным `git clone <path>`, hooks не тянутся).
 */

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { simpleGit } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

export class LocalSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "local";

  validate(sourceUrl: string): void {
    const p = this.toPath(sourceUrl);
    if (!existsSync(p)) {
      throw new Error(`local repo path does not exist: ${p}`);
    }
    if (!existsSync(join(p, ".git"))) {
      throw new Error(`not a git repository (no .git): ${p}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const src = this.toPath(sourceUrl);
    // Для локального клона --depth игнорируется git'ом без file:// — клонируем полно.
    const opts: Record<string, string | null> = {};
    if (branch) opts["--branch"] = branch;
    await simpleGit().clone(src, localPath, opts);
    return { localPath, version: await this.headCommit(localPath), sourceType: "local" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit(localPath);
    await git.fetch("origin", branch);
    await git.reset(["--hard", `origin/${branch}`]);
    return { localPath, version: await this.headCommit(localPath), sourceType: "local" };
  }

  private toPath(sourceUrl: string): string {
    return sourceUrl.startsWith("file://") ? new URL(sourceUrl).pathname : resolve(sourceUrl);
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      const hash = await simpleGit(localPath).revparse(["HEAD"]);
      return hash.trim().slice(0, 12) || null;
    } catch {
      return null;
    }
  }
}
