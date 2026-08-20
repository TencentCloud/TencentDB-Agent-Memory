/**
 * RepoSourceFetcher — 解析 Android repo manifest，把多个 project clone 到同一目录树。
 *
 * 背景：Android 平台用 `repo init -u <manifests-url> -m <manifest-file>` 管理几十上百个
 * 独立 git 仓库。code-graph 的建图入口是「一个目录 → indexProject」，因此本 fetcher 负责：
 *   1. 浅克隆 manifests 仓库，解析 manifest XML（remote / default / project）；
 *   2. 按每个 project 的 `path` 把对应 git 仓库 clone 到 localPath 的各自子目录；
 *   3. 返回整棵目录树，供上层 `indexProject(dir)` 一次建图。
 *
 * manifest 仓库本身（XML 文件）不落入 localPath，避免污染 code graph 索引。
 *
 * 安全：
 *   - validate 复用 HTTPS-only + SSRF 私网黑名单（与 GitSourceFetcher 一致）；
 *   - project.path 做路径穿越（`..`）校验，禁止 clone 到 localPath 之外；
 *   - remote.fetch 支持绝对 URL（http/https/ssh/git@）与相对路径两种形态。
 */

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import simpleGit, { ResetMode } from "simple-git";
import pLimit from "p-limit";
import type { ISourceFetcher, FetchResult, SourceType, FetchOptions } from "./types.js";

/** manifest 解析结果。 */
export interface ManifestProject {
  name: string;
  path: string;
  remote?: string;
  revision?: string;
}

export interface ParsedManifest {
  remotes: Array<{ name: string; fetch?: string }>;
  defaultRemote?: string;
  defaultRevision?: string;
  projects: ManifestProject[];
}

/** 私有网段 / 环回地址黑名单（与 GitSourceFetcher 保持一致）。 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/** 并发 clone 的 project 数（p-limit 限流，避免一次性开几十个 git 进程）。 */
const CLONE_CONCURRENCY = 6;

function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

/** 提取标签属性 name="value"（值不含引号）。 */
function parseAttributes(tagContent: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagContent)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/** 解析 manifest XML 正文（不处理 include/remove-project/extend-project 等高级语法）。 */
export function parseManifest(xml: string): ParsedManifest {
  const noComments = xml.replace(/<!--[\s\S]*?-->/g, "");

  const remotes: ParsedManifest["remotes"] = [];
  const remoteRe = /<remote\b([^>]*?)(?:\/>|>)/g;
  let m: RegExpExecArray | null;
  while ((m = remoteRe.exec(noComments)) !== null) {
    const a = parseAttributes(m[1]);
    if (a.name) remotes.push({ name: a.name, fetch: a.fetch });
  }

  let defaultRemote: string | undefined;
  let defaultRevision: string | undefined;
  const defRe = /<default\b([^>]*?)(?:\/>|>)/g;
  const dm = defRe.exec(noComments);
  if (dm) {
    const a = parseAttributes(dm[1]);
    defaultRemote = a.remote;
    defaultRevision = a.revision;
  }

  const projects: ManifestProject[] = [];
  const projRe = /<project\b([^>]*?)(?:\/>|>)/g;
  while ((m = projRe.exec(noComments)) !== null) {
    const a = parseAttributes(m[1]);
    if (!a.name) continue;
    projects.push({
      name: a.name,
      path: a.path ?? a.name,
      remote: a.remote,
      revision: a.revision,
    });
  }

  return { remotes, defaultRemote, defaultRevision, projects };
}

/** 归一化 revision：去掉 refs/heads/ 前缀（tags / commit SHA 原样保留，由 clone 逻辑处理）。 */
function normalizeRevision(revision: string | undefined): string {
  if (!revision) return "master";
  return revision.replace(/^refs\/heads\//, "");
}

/** 拼装 project 的最终 clone URL。 */
function resolveCloneUrl(
  manifestUrl: string,
  manifest: ParsedManifest,
  project: ManifestProject,
): string {
  const remoteName = project.remote ?? manifest.defaultRemote;
  const remote = manifest.remotes.find((r) => r.name === remoteName);
  const fetch = remote?.fetch ?? "";

  let base: string;
  if (/^https?:\/\//i.test(fetch) || fetch.startsWith("git@") || fetch.startsWith("ssh://")) {
    base = fetch.replace(/\/+$/, "");
  } else if (fetch) {
    // 相对路径：相对 manifests 仓库根解析。new URL 需 base 以 / 结尾才按目录语义处理。
    const baseUrl = manifestUrl.replace(/\/?$/, "/");
    base = new URL(fetch, baseUrl).href.replace(/\/+$/, "");
  } else {
    // 无 remote.fetch：回退到 manifests 仓库的上级目录（AOSP 默认 `..` 语义）。
    const baseUrl = manifestUrl.replace(/\/?$/, "/");
    base = new URL("..", baseUrl).href.replace(/\/+$/, "");
  }
  return `${base}/${project.name}`;
}

/** 把 project.path 解析为 localPath 下的安全绝对路径（拒绝 `..` 穿越）。 */
function resolveTargetPath(localPath: string, p: string): string {
  let normalized = p;
  if (normalized === "." || normalized === "./" || normalized === "") {
    return localPath;
  }
  normalized = normalized.replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) {
    throw new Error(`invalid project path (path traversal): ${p}`);
  }
  return join(localPath, normalized);
}

export class RepoSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "repo-manifest";

  private readonly ssrfCheck: boolean;

  constructor() {
    this.ssrfCheck = ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    if (!sourceUrl.startsWith("https://")) {
      throw new Error("repo-manifest only supports https manifests URL");
    }
    let host = "";
    try {
      host = new URL(sourceUrl).hostname;
    } catch {
      /* ignore */
    }
    if (this.ssrfCheck && host && PRIVATE_ADDR_RE.test(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(
    sourceUrl: string,
    branch: string,
    localPath: string,
    options?: FetchOptions,
  ): Promise<FetchResult> {
    this.validate(sourceUrl);
    const { manifest, manifestCommit } = await this.loadManifest(sourceUrl, branch, options?.manifestFile);

    mkdirSync(localPath, { recursive: true });

    // 根 project（path="./" 或 "." 或空）clone 到 localPath 根目录；子 project clone 到
    // localPath 的子目录。两者目标有父子关系，若并发，根 project 的 clone 会因 localPath
    // 已被子 project 建出子目录而报「非空目录」。因此先串行 clone 根 project，再并发子 project。
    const isRoot = (p: ManifestProject) => p.path === "./" || p.path === "." || p.path === "";
    const rootProjects = manifest.projects.filter(isRoot);
    const subProjects = manifest.projects.filter((p) => !isRoot(p));

    for (const project of rootProjects) {
      const url = resolveCloneUrl(sourceUrl, manifest, project);
      const revision = normalizeRevision(project.revision ?? manifest.defaultRevision);
      await this.cloneProject(url, revision, resolveTargetPath(localPath, project.path));
    }

    const limit = pLimit(CLONE_CONCURRENCY);
    await Promise.all(
      subProjects.map((project) =>
        limit(async () => {
          const url = resolveCloneUrl(sourceUrl, manifest, project);
          const revision = normalizeRevision(project.revision ?? manifest.defaultRevision);
          const targetPath = resolveTargetPath(localPath, project.path);
          await this.cloneProject(url, revision, targetPath);
        }),
      ),
    );

    return { localPath, version: manifestCommit, sourceType: "repo-manifest" };
  }

  async sync(
    sourceUrl: string,
    branch: string,
    localPath: string,
    options?: FetchOptions,
  ): Promise<FetchResult> {
    this.validate(sourceUrl);
    const { manifest, manifestCommit } = await this.loadManifest(sourceUrl, branch, options?.manifestFile);

    const limit = pLimit(CLONE_CONCURRENCY);
    await Promise.all(
      manifest.projects.map((project) =>
        limit(async () => {
          const url = resolveCloneUrl(sourceUrl, manifest, project);
          const revision = normalizeRevision(project.revision ?? manifest.defaultRevision);
          const targetPath = resolveTargetPath(localPath, project.path);
          if (existsSync(join(targetPath, ".git"))) {
            await this.updateProject(url, revision, targetPath);
          } else {
            await this.cloneProject(url, revision, targetPath);
          }
        }),
      ),
    );

    return { localPath, version: manifestCommit, sourceType: "repo-manifest" };
  }

  // ── 内部 helper ──

  /** 浅克隆 manifests 仓库到临时目录，读取 manifest XML 并解析。 */
  private async loadManifest(
    manifestsUrl: string,
    branch: string,
    manifestFile?: string,
  ): Promise<{ manifest: ParsedManifest; manifestCommit: string | null }> {
    const tmp = mkdtempSync(join(tmpdir(), "repo-manifest-"));
    try {
      await simpleGit().clone(manifestsUrl, tmp, { "--depth": 1, "--branch": branch });

      const file = manifestFile?.trim() || "default.xml";
      const { readFileSync } = await import("node:fs");
      const xml = readFileSync(join(tmp, file), "utf8");
      const manifest = parseManifest(xml);

      let commit: string | null = null;
      try {
        commit = (await simpleGit(tmp).revparse(["HEAD"])).trim().slice(0, 12);
      } catch {
        commit = null;
      }
      return { manifest, manifestCommit: commit };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async cloneProject(url: string, revision: string, targetPath: string): Promise<void> {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    // 目标已是 git 仓库（上次中途失败残留）→ 转为增量更新，避免 clone 到非空目录报错。
    if (existsSync(join(targetPath, ".git"))) {
      await this.updateProject(url, revision, targetPath);
      return;
    }
    // 目标存在但非 git 仓库（脏目录）→ 清空后重新 clone。
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    await simpleGit().clone(url, targetPath, { "--depth": 1, "--branch": revision });
  }

  private async updateProject(url: string, revision: string, targetPath: string): Promise<void> {
    const git = simpleGit(targetPath);
    // manifest 里 project 的 remote/fetch 可能变化，先对齐 origin URL 再 fetch。
    await git.remote(["set-url", "origin", url]);
    await git.fetch("origin", revision, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${revision}`]);
  }
}
