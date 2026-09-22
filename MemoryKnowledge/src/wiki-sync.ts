#!/usr/bin/env node
/**
 * knowledge-wiki-sync — sync a TDAI wiki with a local git checkout, both ways.
 *
 * The wiki is the live wiki; the checkout is a working copy of it. Each run
 * compares both sides against the last reconciled state and applies whichever
 * side moved:
 *
 *   wiki-only change   → written to the checkout
 *   commit-only change → written to the wiki
 *   both, differing    → CONFLICT: nothing is written, the run stops
 *
 * Three rules keep this out of the data-loss business:
 *
 *  - **Commits only.** The git side is the committed tree, never the working
 *    tree. Uncommitted edits are reported as drift and not imported, so a
 *    half-finished edit cannot reach the live wiki, and a deletion that is not
 *    committed cannot delete a page.
 *  - **A conflict blocks the whole run.** Partial application of a half-merged
 *    pair is worse than no progress; refusing is the only outcome that cannot
 *    silently discard one side's work.
 *  - **Deletions are symmetric** — a page deleted in the wiki deletes the file,
 *    a file deleted in a commit deletes the page — and each one is logged by
 *    name, because that is the operation that cannot be undone by re-reading.
 *
 * The service holds no git remote or credential: the checkout, its remote, its
 * identity and its push auth all belong to the caller.
 *
 * Usage:
 *   knowledge-wiki-sync --wiki-id <id> --repo <path> [--push]
 *
 * Exit codes: 0 ok · 1 error · 2 conflicts (nothing written)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import simpleGit, { type SimpleGit } from "simple-git";

import { callApi, type HttpClientOptions } from "./mcp/http-client.js";
import { createLogger } from "./logger.js";
import {
  bootstrapPlan,
  buildManifest,
  isPageFile,
  reconcile,
  wantedPages,
  wikiMoved,
  type GitStatus,
  type ReconcilePlan,
} from "./wiki-sync-reconcile.js";

const log = createLogger("wiki-sync");

/** Server-side caps: refs per `page/read`, pages per `page/write` / `page/rm`. */
const BATCH = 20;

/** State filename, kept inside the git dir: per checkout, never tracked. */
const STATE_FILE = "wiki-sync-state.json";

export class ConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `${paths.length} page(s) changed in both the wiki and git: ${paths.join(", ")} — ` +
        "resolve them, or pass --on-conflict=prefer-git|prefer-wiki",
    );
    this.name = "ConflictError";
  }
}

export interface Options {
  repo: string;
  wikiId: string;
  apiUrl: string;
  serviceId?: string;
  token?: string;
  onConflict: "abort" | "prefer-git" | "prefer-wiki";
  push: boolean;
  noCommit: boolean;
  dryRun: boolean;
  allowEmpty: boolean;
}

interface State {
  version: 1;
  wikiId: string;
  serviceId: string | null;
  /** Commit holding the last reconciled content. */
  commit: string;
  /** Page path → content hash at that commit. */
  pages: Record<string, string>;
}

/**
 * Page files currently in the checkout's working tree, as repo-relative posix
 * paths. Used only to report drift — never as an input to the plan.
 */
export function walkPageFiles(repoDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable subtree = nothing to consider
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "media") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      out.push(relative(repoDir, full).split(sep).join("/"));
    }
  };
  walk(join(repoDir, "wiki"));
  return out;
}

// ───────────────────────────── wiki (HTTP) ─────────────────────────────

async function getTeamId(http: HttpClientOptions, wikiId: string): Promise<string> {
  const data = (await callApi(http, "/wiki/get", { wiki_id: wikiId })) as { team_id?: string };
  if (!data?.team_id) throw new Error(`wiki ${wikiId} has no team_id`);
  return data.team_id;
}

async function listPages(http: HttpClientOptions, wikiId: string): Promise<string[]> {
  const data = (await callApi(http, "/wiki/page/ls", { wiki_id: wikiId })) as {
    items?: { path?: string }[];
  };
  return (data?.items ?? []).map((i) => i.path).filter((p): p is string => Boolean(p));
}

/**
 * Read every ref, in server-sized batches. Content is the page verbatim,
 * frontmatter included.
 *
 * A ref the service reports as missing aborts the run: a silent drop here would
 * read as "the wiki deleted this page" and delete it from every checkout.
 */
async function readPages(
  http: HttpClientOptions,
  wikiId: string,
  refs: string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = refs.slice(i, i + BATCH);
    const data = (await callApi(http, "/wiki/page/read", { wiki_id: wikiId, refs: batch })) as {
      items?: { ref?: string; content?: string; not_found?: boolean }[];
    };
    for (const item of data?.items ?? []) {
      if (!item.ref || item.not_found || typeof item.content !== "string") {
        throw new Error(`page not readable: ${item.ref ?? "(missing ref)"}`);
      }
      contents.set(item.ref, item.content);
    }
  }
  for (const ref of refs) {
    if (!contents.has(ref)) throw new Error(`page missing from read response: ${ref}`);
  }
  return contents;
}

async function writePages(
  http: HttpClientOptions,
  wikiId: string,
  teamId: string,
  contents: Map<string, string>,
): Promise<void> {
  const refs = [...contents.keys()];
  for (let i = 0; i < refs.length; i += BATCH) {
    const pages = refs.slice(i, i + BATCH).map((ref) => ({ ref, content: contents.get(ref) ?? "" }));
    await callApi(http, "/wiki/page/write", { wiki_id: wikiId, team_id: teamId, pages });
  }
}

async function removePages(
  http: HttpClientOptions,
  wikiId: string,
  teamId: string,
  refs: string[],
): Promise<void> {
  for (let i = 0; i < refs.length; i += BATCH) {
    await callApi(http, "/wiki/page/rm", {
      wiki_id: wikiId,
      team_id: teamId,
      refs: refs.slice(i, i + BATCH),
    });
  }
}

// ─────────────────────────────── git ───────────────────────────────

async function gitDirOf(git: SimpleGit): Promise<string> {
  return (await git.raw(["rev-parse", "--absolute-git-dir"])).trim();
}

/**
 * The current commit, or null on an unborn branch (a freshly `git init`'d
 * checkout has no HEAD to read a tree from).
 */
async function headCommit(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.raw(["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    return null;
  }
}

async function treePageFiles(git: SimpleGit, ref: string): Promise<string[]> {
  const out = await git.raw(["ls-tree", "-r", "--name-only", ref, "--", "wiki"]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isPageFile(line));
}

/**
 * What changed under `wiki/` between two commits. Empty when the refs are
 * equal, so callers need not special-case it.
 */
async function diffPageFiles(
  git: SimpleGit,
  from: string,
  to: string,
): Promise<Map<string, GitStatus>> {
  const changed = new Map<string, GitStatus>();
  if (from === to) return changed;
  const out = await git.raw(["diff", "--name-status", from, to, "--", "wiki"]);
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0];
    if (code === "A" && parts[1]) changed.set(parts[1], "added");
    else if ((code === "M" || code === "T") && parts[1]) changed.set(parts[1], "modified");
    else if (code === "D" && parts[1]) changed.set(parts[1], "deleted");
    else if ((code === "R" || code === "C") && parts[1] && parts[2]) {
      // A rename is a delete plus an add; a copy is just an add.
      if (code === "R") changed.set(parts[1], "deleted");
      changed.set(parts[2], "added");
    }
  }
  return changed;
}

/** Content of a path at a revision, or null if it is absent there. */
async function contentAt(git: SimpleGit, rev: string, path: string): Promise<string | null> {
  try {
    return await git.raw(["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
}

/** Stage exactly the paths this run touched, then commit if that changed anything. */
async function commitPaths(
  git: SimpleGit,
  paths: string[],
  message: string,
  push: boolean,
): Promise<boolean> {
  if (paths.length === 0) return false;
  await git.raw(["add", "-A", "--", ...paths]);
  const staged = await git.raw(["diff", "--cached", "--name-only"]);
  if (!staged.trim()) return false;
  await git.commit(message);
  if (push) await git.push();
  return true;
}

// ────────────────────────────── state ──────────────────────────────

function statePath(gitDir: string): string {
  return join(gitDir, STATE_FILE);
}

function loadState(gitDir: string, wikiId: string): State | null {
  const file = statePath(gitDir);
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, "utf-8")) as State;
  if (state.wikiId !== wikiId) {
    throw new Error(
      `state file belongs to ${state.wikiId}, not ${wikiId} — pointing a checkout at two wikis would ` +
        `merge them; delete ${file} to re-baseline`,
    );
  }
  return state;
}

function saveState(gitDir: string, state: State): void {
  writeFileSync(statePath(gitDir), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

// ─────────────────────────────── run ───────────────────────────────

/**
 * Uncommitted wiki changes are never imported, so say so — those edits sit in
 * the checkout doing nothing until someone commits them.
 */
async function reportDrift(git: SimpleGit): Promise<void> {
  const drift = await git.raw(["status", "--porcelain", "--", "wiki"]);
  if (drift.trim()) {
    log.warn(`uncommitted wiki changes are not imported until committed:\n${drift.trim()}`);
  }
}

function applyToGit(repoDir: string, plan: ReconcilePlan, tdai: Map<string, string>): string[] {
  const touched = new Set<string>();
  for (const path of plan.toGit.write) {
    const content = tdai.get(path);
    if (content === undefined) continue;
    const abs = join(repoDir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    touched.add(path);
  }
  for (const path of plan.toGit.delete) {
    rmSync(join(repoDir, path), { force: true });
    touched.add(path);
  }
  return [...touched];
}

/**
 * Build the plan: bootstrap on the first run, three-way afterwards, then apply
 * the conflict policy.
 *
 * `gitContents` is pre-read for the paths that moved on both sides — the only
 * place a byte comparison is needed, since reading a page the wiki did not
 * change would be a wasted subprocess.
 */
async function buildPlan(
  git: SimpleGit,
  opts: Options,
  tdai: Map<string, string>,
  state: State | null,
): Promise<ReconcilePlan> {
  if (state === null) {
    log.info("first run: the wiki becomes the baseline; checkout edits are not imported this run");
    const head = await headCommit(git);
    return bootstrapPlan(tdai, head === null ? [] : await treePageFiles(git, head));
  }

  const head = await headCommit(git);
  if (head === null) {
    throw new Error("state exists but the checkout has no commit — delete the state file to re-baseline");
  }

  try {
    await git.raw(["cat-file", "-e", `${state.commit}^{commit}`]);
  } catch {
    throw new Error(
      `recorded commit ${state.commit} is gone from this checkout (rewritten history?) — delete the ` +
        "state file to re-baseline",
    );
  }

  const manifest = new Map(Object.entries(state.pages));
  const gitChanged = await diffPageFiles(git, state.commit, head);
  const movedOnWiki = wikiMoved(tdai, manifest);
  const bothMoved = [...gitChanged.keys()].filter((p) => isPageFile(p) && movedOnWiki.has(p));

  const gitContents = new Map<string, string | null>();
  for (const path of bothMoved) {
    gitContents.set(path, await contentAt(git, "HEAD", path));
  }

  const plan = reconcile({
    tdai,
    gitChanged,
    manifest,
    gitContent: (path) => gitContents.get(path) ?? null,
  });

  if (plan.conflicts.length === 0) return plan;

  for (const path of plan.conflicts) {
    log.error(`conflict (changed in both): ${path}`);
  }
  if (opts.onConflict === "abort") throw new ConflictError(plan.conflicts);

  // The chosen side wins, so its content is applied to the other — including
  // when the winning side is the one that deleted the page.
  for (const path of plan.conflicts) {
    if (opts.onConflict === "prefer-wiki") {
      if (tdai.has(path)) plan.toGit.write.push(path);
      else plan.toGit.delete.push(path);
    } else if (gitContents.get(path) === null) {
      plan.toWiki.delete.push(path);
    } else {
      plan.toWiki.write.push(path);
    }
  }
  plan.conflicts = [];
  return plan;
}

export async function runSync(opts: Options): Promise<number> {
  const repoDir = resolve(opts.repo);
  if (!existsSync(repoDir)) throw new Error(`repo directory not found: ${repoDir}`);
  const git = simpleGit(repoDir);
  try {
    await git.revparse(["--git-dir"]);
  } catch {
    throw new Error(`not a git checkout: ${repoDir}`);
  }
  const gitDir = await gitDirOf(git);

  const http: HttpClientOptions = {
    baseUrl: opts.apiUrl,
    token: opts.token,
    serviceId: opts.serviceId,
  };
  const teamId = await getTeamId(http, opts.wikiId);
  const tdai = await readPages(http, opts.wikiId, await listPages(http, opts.wikiId));

  // An empty wiki is almost always a wrong --service-id or a wiki that is not
  // `ready` (page/ls returns []), not a wiki someone emptied. Acting on it would
  // delete every page file in the checkout.
  if (wantedPages([...tdai.keys()]).length === 0 && !opts.allowEmpty) {
    throw new Error(
      "wiki returned no pages — refusing to act (check --service-id / wiki status, or pass --allow-empty)",
    );
  }

  const state = loadState(gitDir, opts.wikiId);
  const plan = await buildPlan(git, opts, tdai, state);

  log.info(
    `wiki ${opts.wikiId}: to git ${plan.toGit.write.length} written / ${plan.toGit.delete.length} deleted; ` +
      `to wiki ${plan.toWiki.write.length} written / ${plan.toWiki.delete.length} deleted`,
  );
  for (const path of plan.toGit.delete) log.warn(`page gone from wiki, removing file: ${path}`);
  for (const path of plan.toWiki.delete) log.warn(`file gone from git, deleting page: ${path}`);
  for (const path of plan.unmanaged) log.warn(`changed in git but outside wiki/: ignored (${path})`);

  if (opts.dryRun) return 0;

  // Wiki writes go first: the service normalises what it stores (it injects
  // `locked: true`), so the checkout is written from the re-read wiki afterwards
  // and both sides end the run identical.
  if (plan.toWiki.write.length > 0 || plan.toWiki.delete.length > 0) {
    const fromGit = new Map<string, string>();
    for (const path of plan.toWiki.write) {
      const content = await contentAt(git, "HEAD", path);
      if (content !== null) fromGit.set(path, content);
    }
    await writePages(http, opts.wikiId, teamId, fromGit);
    plan.toWiki.write = [...fromGit.keys()];
    if (plan.toWiki.delete.length > 0) {
      await removePages(http, opts.wikiId, teamId, plan.toWiki.delete);
    }
    if (plan.toWiki.write.length > 0) {
      const canonical = await readPages(http, opts.wikiId, plan.toWiki.write);
      for (const [ref, content] of canonical) tdai.set(ref, content);
      for (const ref of canonical.keys()) {
        if (!plan.toGit.write.includes(ref)) plan.toGit.write.push(ref);
      }
    }
    for (const ref of plan.toWiki.delete) tdai.delete(ref);
  }

  const touched = applyToGit(repoDir, plan, tdai);

  if (opts.noCommit) {
    await reportDrift(git);
    log.warn("--no-commit: state not saved, so the next run re-derives from the last saved state");
    return 0;
  }

  const committed = await commitPaths(
    git,
    touched,
    `sync wiki ${opts.wikiId}: ${plan.toGit.write.length} written, ` +
      `${plan.toGit.delete.length} deleted, ${plan.toWiki.write.length} imported from git`,
    opts.push,
  );
  if (!committed) log.info("nothing to commit");

  // Reported after the commit, so what is left is genuine leftover work and not
  // the files this run just wrote.
  await reportDrift(git);

  saveState(gitDir, {
    version: 1,
    wikiId: opts.wikiId,
    serviceId: opts.serviceId ?? null,
    commit: (await headCommit(git)) ?? "",
    pages: Object.fromEntries(buildManifest(tdai)),
  });
  return 0;
}

// ────────────────────────────── CLI ──────────────────────────────

function usage(): string {
  return [
    "Sync a TDAI wiki with a local git checkout, both ways.",
    "",
    "Usage:",
    "  knowledge-wiki-sync --wiki-id <id> --repo <path> [options]",
    "",
    "Required:",
    "  --wiki-id <id>        Wiki to sync (e.g. wiki-g8lwpmlz)",
    "  --repo <path>         Git checkout whose <repo>/wiki/ mirrors the wiki",
    "",
    "Options:",
    "  --api-url <url>       Knowledge Service base URL (env KNOWLEDGE_API_URL, default http://localhost:8421)",
    "  --service-id <id>     Tenant id, sent as x-tdai-service-id (env KNOWLEDGE_SERVICE_ID)",
    "  --token <token>       Bearer token (env KNOWLEDGE_API_TOKEN)",
    "  --on-conflict <p>     abort (default) | prefer-git | prefer-wiki",
    "  --push                Push the commit to the checkout's remote",
    "  --no-commit           Write the tree, leave staging/committing to you (state is not saved)",
    "  --dry-run             Report the plan, write nothing",
    "  --allow-empty         Permit an empty page listing (can act on the whole checkout)",
    "  -h, --help            Show this help",
    "",
    "Notes:",
    "  Only committed git changes are imported; uncommitted edits are reported as drift.",
    "  The first run adopts the wiki as the baseline and rewrites the checkout to match.",
    "",
    "Exit codes: 0 ok · 1 error · 2 conflicts (nothing written)",
    "",
  ].join("\n");
}

export function parseArgs(argv: string[]): Options | "help" {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const inlineBools = new Set(["push", "no-commit", "dry-run", "allow-empty"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return "help";
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (inlineBools.has(name)) {
      bools.add(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    flags.set(name, value);
  }

  const repo = flags.get("repo");
  const wikiId = flags.get("wiki-id");
  if (!repo) throw new Error("--repo is required");
  if (!wikiId) throw new Error("--wiki-id is required");

  const onConflict = flags.get("on-conflict") ?? "abort";
  if (onConflict !== "abort" && onConflict !== "prefer-git" && onConflict !== "prefer-wiki") {
    throw new Error(`--on-conflict must be abort, prefer-git or prefer-wiki (got ${onConflict})`);
  }

  return {
    repo,
    wikiId,
    apiUrl: flags.get("api-url") ?? process.env.KNOWLEDGE_API_URL ?? "http://localhost:8421",
    serviceId: flags.get("service-id") ?? process.env.KNOWLEDGE_SERVICE_ID,
    token: flags.get("token") ?? process.env.KNOWLEDGE_API_TOKEN,
    onConflict,
    push: bools.has("push"),
    noCommit: bools.has("no-commit"),
    dryRun: bools.has("dry-run"),
    allowEmpty: bools.has("allow-empty"),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") {
      process.stdout.write(usage());
      return;
    }
    process.exitCode = await runSync(parsed);
  } catch (err: unknown) {
    if (err instanceof ConflictError) {
      process.stderr.write(`knowledge-wiki-sync: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`knowledge-wiki-sync: ${msg}\n`);
    process.exitCode = 1;
  }
}

// Direct run (`tsx src/wiki-sync.ts`). The published bin goes through
// bin/wiki-sync.mjs, which calls main() itself — argv[1] is the launcher there,
// so this guard is false and nothing runs twice.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}