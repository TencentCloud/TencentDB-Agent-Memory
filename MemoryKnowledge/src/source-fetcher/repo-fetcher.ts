import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import pLimit from "p-limit";
import { createRepoGit, type RepoGit } from "./repo-git.js";
import { expandRepoManifest, parseRepoManifestSource, type RepoManifestProject } from "./repo-manifest.js";
import type { FetchResult, ISourceFetcher, SourceType } from "./types.js";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function ensureParent(root: string, path: string): Promise<void> {
  let current = root;
  for (const component of path.split("/").slice(0, -1)) {
    current = join(current, component);
    const entry = await lstat(current).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return undefined;
    });
    if (entry && !entry.isDirectory()) throw new Error("Repo manifest file destination is not a directory");
    if (!entry) await mkdir(current);
  }
}

async function mapFiles(root: string, project: RepoManifestProject): Promise<void> {
  if (!project.files?.length) return;
  const projectRoot = await realpath(join(root, project.path));
  for (const mapping of project.files) {
    const from = await realpath(join(projectRoot, mapping.from));
    const relativeSource = relative(projectRoot, from);
    if (isAbsolute(relativeSource) || relativeSource === ".." || relativeSource.startsWith(`..${sep}`)) {
      throw new Error("Repo manifest file source is outside its checkout");
    }
    const to = join(root, mapping.to);
    await ensureParent(root, mapping.to);
    const entry = await lstat(from);
    if (mapping.kind === "copyfile") {
      if (!entry.isFile()) throw new Error("Repo manifest copyfile source must be a file");
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } else {
      await symlink(relative(dirname(to), from), to, entry.isDirectory() ? "dir" : "file");
    }
  }
}

export class RepoSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "repo-manifest";

  constructor(private readonly newGit: () => RepoGit = createRepoGit) {}

  validate(sourceUrl: string): void {
    parseRepoManifestSource(sourceUrl);
  }

  async fetch(sourceUrl: string, revision: string, localPath: string): Promise<FetchResult> {
    const source = parseRepoManifestSource(sourceUrl);
    const git = this.newGit();
    await mkdir(localPath, { recursive: true });
    if ((await readdir(localPath)).length) throw new Error("Repo manifest workspace must be empty");
    const manifestDirectory = await mkdtemp(join(tmpdir(), "knowledge-repo-manifest-"));
    try {
      await git.prepare([source.repository]);
      const manifestCommit = await git.fetch(source.repository, revision, manifestDirectory, true);
      const projects = await expandRepoManifest(source, (path) => git.readFile(manifestDirectory, manifestCommit, path));
      await git.prepare(projects.map((project) => project.repository));
      const limit = pLimit(4);
      const clones = await Promise.allSettled(projects.map((project) => limit(async () => {
        try {
          return await git.fetch(project.repository, project.revision, join(localPath, project.path), false);
        } catch {
          throw new Error(`Unable to fetch repo manifest project ${project.path}`);
        }
      })));
      const commits = clones.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      const workspace = await realpath(localPath);
      for (const project of projects) await mapFiles(workspace, project);
      return {
        localPath,
        sourceType: this.supportedType,
        version: createHash("sha256").update(JSON.stringify([
          manifestCommit, source.manifestFile,
          projects.map((project, index) => [project.path, commits[index]]),
        ])).digest("hex"),
      };
    } catch (error) {
      await rm(localPath, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(manifestDirectory, { recursive: true, force: true });
    }
  }

  async sync(sourceUrl: string, revision: string, localPath: string): Promise<FetchResult> {
    const parent = await mkdtemp(join(dirname(localPath), `.${basename(localPath)}-repo-`));
    const staged = join(parent, "next");
    const previous = join(parent, "previous");
    try {
      const result = await this.fetch(sourceUrl, revision, staged);
      const hasPrevious = await rename(localPath, previous).then(() => true, (error: unknown) => {
        if (missing(error)) return false;
        throw error;
      });
      try {
        await rename(staged, localPath);
      } catch (error) {
        if (hasPrevious) await rename(previous, localPath);
        throw error;
      }
      return { ...result, localPath };
    } finally {
      // When rollback cannot restore the path, leave the recovered checkout for the operator.
      const intact = await lstat(localPath).then(() => true, () => false);
      if (intact || !(await lstat(previous).then(() => true, () => false))) {
        await rm(parent, { recursive: true, force: true });
      }
    }
  }
}
