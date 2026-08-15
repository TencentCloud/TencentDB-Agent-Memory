/**
 * Thin execFile wrapper around the system `git` binary.
 *
 * No shelling through `sh -c` — every invocation passes argv as an array,
 * so caller-controlled strings (branch names, keys, remote URLs) can never
 * be interpreted by a shell. Auth material (tokens, SSH keys) is passed via
 * per-invocation `-c` config args / env vars, never written to `.git/config`
 * or any file on disk.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitCredential } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const COMMIT_IDENTITY_ARGS = ["-c", "user.name=git-storage-backend", "-c", "user.email=git-storage-backend@localhost"];

export class GitCliError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCliError";
  }
}

export interface GitAuth {
  /** Extra `-c` args inserted right after `git`, before the subcommand. */
  configArgs: string[];
  /** Extra env vars for the spawned process (e.g. GIT_SSH_COMMAND). */
  env?: NodeJS.ProcessEnv;
}

/** POSIX single-quote shell escaping, for values embedded in GIT_SSH_COMMAND. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildGitAuth(credential: GitCredential): GitAuth {
  if (credential.authMethod === "ssh") {
    const hostKeyArg = credential.knownHostsPath
      ? `-o UserKnownHostsFile=${shellQuote(credential.knownHostsPath)}`
      : "-o StrictHostKeyChecking=accept-new";
    return {
      configArgs: [],
      env: {
        GIT_SSH_COMMAND: `ssh -i ${shellQuote(credential.privateKeyPath)} -o IdentitiesOnly=yes -o BatchMode=yes ${hostKeyArg}`,
      },
    };
  }
  const username = credential.username && credential.username.length > 0 ? credential.username : "x-access-token";
  const basic = Buffer.from(`${username}:${credential.token}`, "utf-8").toString("base64");
  return {
    // credential.helper= (empty) disables any configured helper so nothing
    // else tries to prompt for or supply credentials for this invocation.
    configArgs: ["-c", `http.extraHeader=Authorization: Basic ${basic}`, "-c", "credential.helper="],
  };
}

export interface RunGitOptions {
  cwd: string;
  /** Extra `-c` args (e.g. from buildGitAuth) inserted before the subcommand. */
  configArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Allow specific non-zero exit codes without throwing (caller inspects stderr/exit code itself). */
  allowExitCodes?: number[];
}

export async function runGit(args: string[], opts: RunGitOptions): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const fullArgs = [...(opts.configArgs ?? []), ...args];
  try {
    const { stdout, stderr } = await execFileAsync("git", fullArgs, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    const exitCode = typeof e.code === "number" ? e.code : null;
    if (exitCode !== null && opts.allowExitCodes?.includes(exitCode)) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode };
    }
    if (e.code === "ENOENT") {
      throw new GitCliError(`git binary not found on PATH`, fullArgs, null, "");
    }
    throw new GitCliError(
      `git ${args.join(" ")} failed${exitCode !== null ? ` (exit ${exitCode})` : ""}: ${(e.stderr ?? String(err)).trim()}`,
      fullArgs,
      exitCode,
      e.stderr ?? "",
    );
  }
}

export async function gitVersion(): Promise<string> {
  const { stdout } = await runGit(["--version"], { cwd: process.cwd() });
  return stdout.trim();
}

export async function gitCheckRefFormat(branchName: string): Promise<boolean> {
  const { exitCode } = await runGit(["check-ref-format", "--branch", branchName], {
    cwd: process.cwd(),
    allowExitCodes: [1],
  });
  return exitCode === 0;
}

export async function gitLsRemoteHasBranch(remoteUrl: string, branch: string, auth: GitAuth): Promise<boolean> {
  const { stdout } = await runGit(["ls-remote", "--heads", remoteUrl, branch], {
    cwd: process.cwd(),
    configArgs: auth.configArgs,
    env: auth.env,
    timeoutMs: 30_000,
  });
  return stdout.trim().length > 0;
}

export async function gitInit(dir: string): Promise<void> {
  await runGit(["init", "--quiet"], { cwd: dir });
}

/**
 * `-t branch` restricts the remote's configured fetch refspec to that one
 * branch — without it, a plain `git remote add` leaves the default
 * `+refs/heads/*:refs/remotes/origin/*` refspec in place, so every later
 * `git fetch` (not just the initial clone) would pull every other memory
 * space's branch history too.
 */
export async function gitRemoteAdd(dir: string, name: string, url: string, restrictToBranch?: string): Promise<void> {
  const args = restrictToBranch
    ? ["remote", "add", "--no-tags", "-t", restrictToBranch, name, url]
    : ["remote", "add", "--no-tags", name, url];
  await runGit(args, { cwd: dir });
}

export async function gitCheckoutOrphan(dir: string, branch: string): Promise<void> {
  await runGit(["checkout", "--orphan", branch], { cwd: dir });
}

export async function gitClone(remoteUrl: string, dir: string, branch: string, auth: GitAuth): Promise<void> {
  await runGit(
    ["clone", "--quiet", "--single-branch", "--no-tags", "--branch", branch, "--", remoteUrl, dir],
    { cwd: process.cwd(), configArgs: auth.configArgs, env: auth.env, timeoutMs: 120_000 },
  );
}

export async function gitAdd(dir: string, relPath: string): Promise<void> {
  await runGit(["add", "--", relPath], { cwd: dir });
}

/** Commit whatever is currently staged. Returns false if there was nothing to commit. */
export async function gitCommit(dir: string, message: string, opts: { allowEmpty?: boolean } = {}): Promise<boolean> {
  const args = ["commit", "--quiet", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-m", message];
  const { exitCode } = await runGit([...COMMIT_IDENTITY_ARGS, ...args], { cwd: dir, allowExitCodes: [1] });
  return exitCode === 0;
}

export async function gitFetch(dir: string, auth: GitAuth, remote = "origin"): Promise<void> {
  try {
    await runGit(["fetch", "--quiet", "--no-tags", remote], {
      cwd: dir,
      configArgs: auth.configArgs,
      env: auth.env,
      timeoutMs: 60_000,
    });
  } catch (err) {
    // With a single-branch-restricted fetch refspec (see gitRemoteAdd), the
    // very first fetch for a brand-new orphan branch that hasn't been
    // pushed yet has a specifically-named remote ref that doesn't exist —
    // git treats that as fatal instead of "nothing to fetch". Swallow it:
    // semantically this is the same as the old wildcard refspec matching
    // zero branches, not a real failure.
    if (err instanceof GitCliError && /couldn't find remote ref/i.test(err.stderr)) {
      return;
    }
    throw err;
  }
}

export interface GitPushResult {
  rejected: boolean;
}

const NON_FAST_FORWARD_PATTERNS = [/non-fast-forward/i, /failed to push some refs/i, /rejected/i, /stale info/i];

export async function gitPush(dir: string, branch: string, auth: GitAuth, remote = "origin"): Promise<GitPushResult> {
  try {
    await runGit(["push", "--quiet", remote, `${branch}:${branch}`], {
      cwd: dir,
      configArgs: auth.configArgs,
      env: auth.env,
      timeoutMs: 60_000,
    });
    return { rejected: false };
  } catch (err) {
    if (err instanceof GitCliError && NON_FAST_FORWARD_PATTERNS.some((re) => re.test(err.stderr))) {
      return { rejected: true };
    }
    throw err;
  }
}

export async function gitMergeBase(dir: string, refA: string, refB: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(["merge-base", refA, refB], { cwd: dir, allowExitCodes: [1, 128] });
  return exitCode === 0 ? stdout.trim() : null;
}

export async function gitResetHard(dir: string, ref: string): Promise<void> {
  await runGit(["reset", "--hard", ref], { cwd: dir });
}

export async function gitCheckoutDiscard(dir: string): Promise<void> {
  await runGit(["checkout", "--", "."], { cwd: dir, allowExitCodes: [1] });
  await runGit(["clean", "-fd"], { cwd: dir });
}

export async function gitStatusPorcelain(dir: string): Promise<string> {
  const { stdout } = await runGit(["status", "--porcelain"], { cwd: dir });
  return stdout;
}

export async function gitRevParse(dir: string, ref: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(["rev-parse", "--verify", ref], { cwd: dir, allowExitCodes: [1, 128] });
  return exitCode === 0 ? stdout.trim() : null;
}

/** Extract "Ops: <id> <id> ..." trailer values from commit messages in `range` (e.g. "abc123..origin/main"). */
export async function gitLogOpIds(dir: string, range: string): Promise<Set<string>> {
  const { stdout } = await runGit(["log", "--format=%B%x00", range], { cwd: dir, allowExitCodes: [128] });
  const opIds = new Set<string>();
  for (const body of stdout.split("\x00")) {
    const match = /^Ops: (.+)$/m.exec(body);
    if (match?.[1]) {
      for (const id of match[1].trim().split(/\s+/)) opIds.add(id);
    }
  }
  return opIds;
}
