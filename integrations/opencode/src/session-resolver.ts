import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_SESSION_KEY_LENGTH = 160;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function sanitizeSessionKey(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "opencode-default"
  ).slice(0, MAX_SESSION_KEY_LENGTH);
}

function gitValue(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export interface SessionResolverOptions {
  cwd?: string;
  explicitSessionKey?: string;
}

export class SessionResolver {
  private readonly cwd: string;
  private readonly explicitSessionKey?: string;
  private readonly workspaceBase: string;

  constructor(options: SessionResolverOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.explicitSessionKey = options.explicitSessionKey?.trim() || undefined;

    const repoRoot = gitValue(this.cwd, ["rev-parse", "--show-toplevel"]);
    const remote = gitValue(this.cwd, ["config", "--get", "remote.origin.url"]);
    const workspaceIdentity = repoRoot
      ? `${repoRoot}|${remote ?? ""}`
      : this.cwd;
    this.workspaceBase = sanitizeSessionKey(
      `opencode:${basename(repoRoot ?? this.cwd)}:${hash(workspaceIdentity)}`,
    );
  }

  resolve(openCodeSessionId?: string, toolSessionKey?: string): string {
    if (toolSessionKey?.trim()) return sanitizeSessionKey(toolSessionKey);
    if (this.explicitSessionKey)
      return sanitizeSessionKey(this.explicitSessionKey);
    if (!openCodeSessionId?.trim()) return this.workspaceBase;
    return sanitizeSessionKey(
      `${this.workspaceBase}:${hash(openCodeSessionId)}`,
    );
  }
}
