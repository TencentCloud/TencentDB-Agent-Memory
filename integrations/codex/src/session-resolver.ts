import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_SESSION_KEY_LENGTH = 160;
const THREAD_ENV_NAMES = ["CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CODEX_SESSION_ID"] as const;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function sanitizeSessionKey(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return (sanitized || "codex-default").slice(0, MAX_SESSION_KEY_LENGTH);
}

function gitValue(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 2_000 });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export interface SessionResolverOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  explicitSessionKey?: string;
}

export class SessionResolver {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly explicitSessionKey?: string;

  constructor(options: SessionResolverOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.env = options.env ?? process.env;
    this.explicitSessionKey = options.explicitSessionKey?.trim() || undefined;
  }

  resolve(toolSessionKey?: string): string {
    if (toolSessionKey?.trim()) return sanitizeSessionKey(toolSessionKey);
    if (this.explicitSessionKey) return sanitizeSessionKey(this.explicitSessionKey);

    const threadId = THREAD_ENV_NAMES.map((name) => this.env[name]?.trim()).find(Boolean);
    const repoRoot = gitValue(this.cwd, ["rev-parse", "--show-toplevel"]);
    const remote = gitValue(this.cwd, ["config", "--get", "remote.origin.url"]);
    const workspaceIdentity = repoRoot ? `${repoRoot}|${remote ?? ""}` : this.cwd;
    const repoName = sanitizeSessionKey(basename(repoRoot ?? this.cwd));
    const base = `codex:${repoName}:${hash(workspaceIdentity)}`;
    return sanitizeSessionKey(threadId ? `${base}:${hash(threadId)}` : base);
  }
}
