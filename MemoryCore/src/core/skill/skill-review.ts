import { createHash } from "node:crypto";
import type { SkillResourcePayload } from "./skill-resource-store.js";
import { GitHubSourceError } from "./github-source.js";
export interface ReviewBundle {
  content: string;
  resources: SkillResourcePayload[];
}
export interface ReviewSide {
  size: number;
  executable: boolean;
  hash: string;
  text?: string;
  reason?: "binary" | "large";
}
export interface ReviewFile {
  path: string;
  status: "added" | "removed" | "changed" | "unchanged";
  before: ReviewSide | null;
  after: ReviewSide | null;
}
function entries(bundle: ReviewBundle | null) {
  return new Map(
    (bundle
      ? [
          {
            path: "SKILL.md",
            content: bundle.content,
            encoding: "utf-8" as const,
          },
          ...bundle.resources,
        ]
      : []
    ).map((r) => [r.path, r]),
  );
}
function describe(
  resource: SkillResourcePayload | undefined,
  includeText: boolean,
): ReviewSide | null {
  if (!resource) return null;
  const bytes = Buffer.from(
    resource.content,
    resource.encoding === "base64" ? "base64" : "utf8",
  );
  const result: ReviewSide = {
    size: bytes.length,
    executable: !!resource.is_executable,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
  if (bytes.length > 100_000) result.reason = "large";
  else {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) result.reason = "binary";
      else if (text.split("\n").length > 2000) result.reason = "large";
      else if (includeText) result.text = text;
    } catch {
      result.reason = "binary";
    }
  }
  return result;
}
export function reviewFiles(
  before: ReviewBundle | null,
  after: ReviewBundle,
  filePath?: string,
): ReviewFile[] {
  const a = entries(before),
    b = entries(after);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort((a, b) =>
    a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b),
  );
  if (filePath !== undefined && !paths.includes(filePath))
    throw new GitHubSourceError("File is not in the reviewed package");
  return paths
    .filter((path) => filePath === undefined || path === filePath)
    .map((path) => {
      const before = describe(a.get(path), filePath !== undefined),
        after = describe(b.get(path), filePath !== undefined);
      const status = !before
        ? "added"
        : !after
          ? "removed"
          : before.hash !== after.hash || before.executable !== after.executable
            ? "changed"
            : "unchanged";
      return { path, status, before, after };
    });
}
