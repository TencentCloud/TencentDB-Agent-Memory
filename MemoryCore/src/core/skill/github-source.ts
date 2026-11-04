import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import type { SkillResourcePayload } from "./skill-resource-store.js";
import { parseSkillFile, validateSkillFile } from "./skill-format.js";

export interface GitHubLocation {
  repository: string;
  ref?: string;
  path?: string;
}
export interface GitHubSource {
  repository: string;
  ref: string;
  path: string;
  commit: string;
  digest: string;
  checked_at: string;
  declared_version?: string;
}
export interface GitHubSnapshot {
  content: string;
  resources: SkillResourcePayload[];
  source: GitHubSource;
}
export class GitHubSourceError extends Error {
  constructor(
    message: string,
    public readonly code:
      "INVALID_PATH" | "GITHUB_UNAVAILABLE" = "INVALID_PATH",
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new GitHubSourceError(message);
};
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const safePath = (path: string) =>
  !path.startsWith("/") &&
  !/[\\\x00-\x1f]/.test(path) &&
  path.split("/").every((s) => s !== "." && s !== ".." && s !== "");

export function normalizeGitHubLocation(
  input: GitHubLocation,
): Required<GitHubLocation> {
  if (typeof input.repository !== "string")
    fail("A public GitHub repository URL is required");
  // Validate before URL normalization can erase traversal segments.
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(
      input.repository,
    );
  if (!match)
    fail(
      "Use https://github.com/owner/repository (no credentials or query parameters)",
    );
  const repository =
    `https://github.com/${match![1]}/${match![2].replace(/\.git$/, "")}`.toLowerCase();
  if (["", ".", ".."].includes(repository.split("/").at(-1)!))
    fail("Invalid repository name");
  const path = input.path ?? "";
  if (typeof path !== "string" || (path !== "" && !safePath(path)))
    fail("Invalid Skill subdirectory");
  const ref = input.ref || "HEAD";
  if (typeof ref !== "string" || ref.length > 256 || /[\x00-\x1f]/.test(ref))
    fail("Invalid Git ref");
  return { repository, ref, path };
}

/** Include paths and executable bits so attachment-only changes are detected. */
export function bundleDigest(
  content: string,
  resources: SkillResourcePayload[],
): string {
  const entries = [
    ["SKILL.md", false, createHash("sha256").update(content).digest("hex")],
    ...resources.map((r) => [
      r.path,
      r.is_executable ?? false,
      createHash("sha256")
        .update(
          Buffer.from(r.content, r.encoding === "base64" ? "base64" : "utf8"),
        )
        .digest("hex"),
    ]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en"));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Public API only: no shell, credentials, redirects or caller-controlled API hosts. */
export async function fetchGitHubSkill(
  input: GitHubLocation,
  client: typeof fetch = fetch,
): Promise<GitHubSnapshot> {
  const location = normalizeGitHubLocation(input);
  const api = `https://api.github.com/repos/${location.repository.slice("https://github.com/".length)}`;
  const signal = AbortSignal.timeout(60_000);
  async function json(path: string, limit = 8_000_000): Promise<unknown> {
    const response = await client(api + path, {
      redirect: "error",
      signal,
      headers: {
        "User-Agent": "TencentDB-Agent-Memory-Skill-Import",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubSourceError(
        `GitHub returned HTTP ${response.status}; verify public access and ref, or retry after rate limiting`,
        "GITHUB_UNAVAILABLE",
      );
    }
    if (!response.body) fail("Empty GitHub response");
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) fail("GitHub response exceeds import limit");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel();
    }
  }
  const revision = decode(
    z.object({
      sha: z.string(),
      commit: z.object({ tree: z.object({ sha: z.string() }) }),
    }),
    await json(`/commits/${encodeURIComponent(location.ref)}`, 1_000_000),
  );
  if (!sha(revision.sha) || !sha(revision.commit?.tree?.sha))
    fail("Invalid GitHub commit response");
  const tree = decode(
    z.object({
      truncated: z.boolean(),
      tree: z.array(
        z.object({
          path: z.string(),
          type: z.string(),
          mode: z.string(),
          sha: z.string(),
          size: z.number().optional(),
        }),
      ),
    }),
    await json(`/git/trees/${revision.commit.tree.sha}?recursive=1`),
  );
  if (tree.truncated || !Array.isArray(tree.tree))
    fail("Repository tree is incomplete; use a smaller repository");
  const prefix = location.path ? `${location.path}/` : "";
  const entries = tree.tree.filter(
    (entry) => entry.path.startsWith(prefix) && entry.type !== "tree",
  );
  if (entries.length > 101)
    fail("A Skill may contain at most 100 resource files");
  let total = 0;
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.slice(prefix.length);
    if (!safePath(path) || paths.has(path))
      fail("Invalid or duplicate resource path");
    paths.add(path);
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      fail("Symlinks and submodules cannot be imported");
    if (
      !sha(entry.sha) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 5_000_000
    )
      fail("Invalid or oversized GitHub blob");
    total += entry.size!;
  }
  if (total > 50_000_000) fail("Skill exceeds 50 MB");
  if (!paths.has("SKILL.md")) fail("Selected directory must contain SKILL.md");
  let content = "";
  const resources: SkillResourcePayload[] = [];
  for (const entry of entries) {
    const data = decode(
      z.object({ encoding: z.string(), content: z.string() }),
      await json(`/git/blobs/${entry.sha}`),
    );
    if (data.encoding !== "base64" || typeof data.content !== "string")
      fail("Invalid GitHub blob encoding");
    const bytes = Buffer.from(data.content, "base64");
    const actualSha = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (bytes.length !== entry.size || actualSha !== entry.sha)
      fail("GitHub blob integrity check failed");
    const path = entry.path.slice(prefix.length);
    if (path === "SKILL.md")
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    else
      resources.push({
        path,
        content: bytes.toString("base64"),
        encoding: "base64",
        is_executable: entry.mode === "100755",
      });
  }
  try {
    validateSkillFile(parseSkillFile(content));
  } catch (error) {
    fail(`Invalid SKILL.md: ${(error as Error).message}`);
  }
  const frontmatter = parseYaml(
    content.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/)![1],
  ) as Record<string, unknown>;
  const version = frontmatter.version;
  const declaredVersion =
    typeof version === "string" || typeof version === "number"
      ? String(version).slice(0, 256)
      : undefined;
  return {
    content,
    resources,
    source: {
      ...location,
      commit: revision.sha,
      digest: bundleDigest(content, resources),
      checked_at: new Date().toISOString(),
      declared_version: declaredVersion,
    },
  };
}

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("Invalid GitHub API response");
  return parsed.data!;
}
